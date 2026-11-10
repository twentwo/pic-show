/**
 * macOS 原生 wheel 相位的前端接收端 —— 只收 `begin` / `end` 两类语义。
 *
 * 后端 `src-tauri/src/wheel_phase.rs` 默认安装 AppKit 本地监视器，把一次物理
 * 手势在 **Rust 侧**归一化成恰好一次 begin + 一次 end，只发这两个事件。原型期
 * 那套逐帧 payload、IPC 延迟统计、Web wheel 配对与 JSONL 落盘已下线：每手势
 * 只有两次 IPC，前端也不再挂任何额外的 wheel 监听。
 *
 * 这里只做两件事：
 *   1. 把两类语义交给 `viewer.handleWheelPhase()`，由它转给 gestures 的
 *      `onWheelPhaseBegin()` / `onWheelPhaseEnd()`；
 *   2. 记三个极简计数，供 devtools 自证「一次手势 = 一次 begin + 一次 end」。
 *
 * 这里**绝不**直接调用 `go()` / `settleWheelSwipe()` / `clearWheelProgress()`，
 * 也不 `preventDefault()`：翻页的方向、位移、速度、触发判定仍全部来自 Web
 * `wheel`，原生相位只回答「这一段什么时候开始 / 结束」。
 *
 * **65ms 兜底**：`PICSHOW_WHEEL_PHASE=0` / 非 macOS / IPC 失败时收不到任何
 * 事件，`Gestures` 仍是 `WHEEL_GESTURE_END_MS`（65ms）+ `settled` 闸门，行为
 * 逐字不变 —— 兜底不能因为默认开启就消失。
 *
 * 函数名 `installWheelPhaseProbe` 沿用原型期的叫法，避免牵动 viewer 入口与
 * 回归检查器；它现在只是接收端，不再做任何观测。
 *
 * devtools 里执行 `__picshowWheelPhase()` 取极简快照，
 * `__picshowWheelPhaseDump()` 取可直接复制的 JSON。
 */

import { isTauri, listen } from './tauri.js';

const EVENT = 'picshow://wheel-phase';

let sink = null;
/** 页面加载以来累计、不截断：相等即说明归一化没有漏发或双计 */
let totalBegins = 0;
let totalEnds = 0;
let lastKind = null;

/**
 * viewer 的相位接收端。`installWheelPhaseProbe()` 之前注册即可；非 Tauri
 * 环境（如 `ui/probe.html` 的浏览器探针）不注册 sink，直接调
 * `viewer.handleWheelPhase(kind)` 就能测同一条结算路径。
 */
export function setWheelPhaseSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

export async function installWheelPhaseProbe() {
  if (!isTauri) return () => {};
  return listen(EVENT, ({ payload }) => {
    const kind = payload?.kind;
    // 后端只发这两类；未知 / 缺失的 payload 一律忽略，不让脏数据落到结算闸门上。
    if (kind !== 'begin' && kind !== 'end') return;
    if (kind === 'begin') totalBegins += 1;
    else totalEnds += 1;
    lastKind = kind;
    sink?.(kind);
  });
}

const snapshot = () => ({
  /** 累计总数，静止时应相等（惯性未收尾时 begins 可能比 ends 多 1） */
  begins: totalBegins,
  ends: totalEnds,
  last: lastKind
});

window.__picshowWheelPhase = snapshot;
window.__picshowWheelPhaseDump = () => JSON.stringify(snapshot(), null, 2);
