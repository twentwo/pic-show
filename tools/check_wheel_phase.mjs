#!/usr/bin/env node
/**
 * 钉住「原生 wheel 相位产品链路」的边界（Node 直接跑，不依赖浏览器）。
 *
 * 已从只读原型收敛成默认开启的产品能力：Rust 侧把一次手势归一化成 begin /
 * end，只发两个语义事件；前端纯转发，65ms 静默仍是兜底。最容易改坏的方式
 * 不是写错，而是**有人顺手让它自己去切图**，或把逐帧 emit / JSONL 观测基建
 * 又加回来 —— 前者绕开「一次一张、边界只回弹」的契约，后者把「每手势两次
 * IPC」打回「每帧一次 IPC」。这个文件把这些禁令变成静态 + 行为断言。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

const rust = read('src-tauri/src/wheel_phase.rs');
const web = read('ui/js/wheel-phase.js');
const entry = read('ui/js/viewer-main.js');
const lib = read('src-tauri/src/lib.rs');
const manifest = read('src-tauri/Cargo.toml');
const viewer = read('ui/js/viewer.js');
const gestures = read('ui/js/gestures.js');

// 只去整行注释，别把字符串里的 "picshow://..." 截断。
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rustCode = strip(rust);
const webCode = strip(web);

let problems = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    problems += 1;
    console.error(`✗ ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

/* ---------------- 1. 默认开启、=0 可关、进程级一次 ---------------- */
const installBody = rust.slice(
  rust.indexOf('pub fn install'),
  rust.indexOf('/// 单个 scrollWheel')
);
ok(
  '默认开启，只有 PICSHOW_WHEEL_PHASE=0 才显式关闭',
  /PICSHOW_WHEEL_PHASE/.test(installBody) &&
    /==\s*Ok\("0"\)/.test(installBody) &&
    /return;/.test(installBody) &&
    !/!=\s*Ok\("1"\)/.test(installBody)
);
ok(
  '=0 时监视器根本不安装（65ms 兜底可 A/B 对照）',
  installBody.indexOf('== Ok("0")') <
    installBody.indexOf('addLocalMonitorForEventsMatchingMask_handler')
);
ok(
  '进程级只装一次（INSTALLED 闸门）',
  /INSTALLED\.swap\(true/.test(rustCode)
);
ok(
  'AppKit 要求主线程安装',
  /MainThreadMarker::new\(\)\.is_none\(\)/.test(rustCode)
);

/* ---------------- 2. 只观察：不吞事件、不改窗口 ---------------- */
const blockBody = rustCode.slice(
  rustCode.indexOf('let block = RcBlock::new'),
  rustCode.indexOf('let monitor =')
);
ok(
  '监视器把 NSEvent 原样返回（不吞事件）',
  /let ptr = event\.as_ptr\(\)/.test(blockBody) &&
    /observe\(&app, event\);\s*ptr/.test(blockBody) &&
    !/null_mut|return\s+None/.test(blockBody)
);
ok(
  '不碰窗口装饰 / 几何 / 全屏',
  !/(set_decorations|set_size|set_position|set_maximized|unmaximize|set_fullscreen)\s*\(/.test(rustCode)
);
ok(
  '窗口过滤：事件窗口 == keyWindow、预览存在、viewer_listening',
  /let key_matches = match/.test(rustCode) &&
    /Retained::as_ptr\(w\), Retained::as_ptr\(k\)/.test(rustCode) &&
    /get_webview_window\(VIEWER_LABEL\)\.is_none\(\)/.test(rustCode) &&
    /is_viewer_listening\(\)/.test(rustCode) &&
    /if !key_matches \{\s*return;\s*\}/.test(rustCode)
);
ok(
  '过滤不通过时连相位都不读（图片墙滚动零额外开销）',
  rustCode.indexOf('if !key_matches') < rustCode.indexOf('let phase = ev.phase().0;') &&
    rustCode.indexOf('is_viewer_listening()') <
      rustCode.indexOf('let phase = ev.phase().0;')
);
ok(
  '事件定向发给 viewer，不让主窗口收到',
  /emit_to\(/.test(rustCode) && /EventTarget::AnyLabel/.test(rustCode)
);

/* ---------------- 3. Rust 归一化：每手势恰好 begin + end ---------------- */
ok(
  '一次手势恰好一次 begin + 一次 end（两类 ended 不得双计）',
  /if phase == 1 \{/.test(rustCode) &&
    /kinds\[0\] = Some\("begin"\)/.test(rustCode) &&
    /let momentum_ended = momentum == 8 \|\| momentum == 16;/.test(rustCode) &&
    /let ended = momentum_ended \|\| \(phase == 8 && !in_momentum\);/.test(rustCode) &&
    /kinds\[1\] = Some\("end"\)/.test(rustCode) &&
    /IN_MOMENTUM/.test(rustCode) &&
    !/p\.phase === 8 \|\| p\.momentum === 8/.test(webCode)
);
ok(
  '每手势最多两次 emit：单一调用点 + 最多两项的 kinds，按 begin → end 顺序',
  /let mut kinds: \[Option<&str>; 2\] = \[None, None\];/.test(rustCode) &&
    /for kind in kinds\.iter\(\)\.flatten\(\)/.test(rustCode) &&
    (rustCode.match(/emit_to\(/g) || []).length === 1 &&
    rustCode.indexOf('kinds[0] = Some("begin")') <
      rustCode.indexOf('kinds[1] = Some("end")')
);
ok(
  'payload 只带 kind，逐帧观测字段 / JSONL / 统计全部下线',
  /json!\(\{ "kind": \*kind \}\)/.test(rustCode) &&
    !/"wallMs"|"uptimeMs"|"phase"|"momentum"|"dx"|"nativeDx"|"skippedTotal"/.test(rustCode) &&
    !/PICSHOW_WHEEL_PHASE_OUT|writeln!|OpenOptions|OUT_FILE|SKIPPED/.test(rustCode) &&
    !/SystemTime|UNIX_EPOCH|scrollingDeltaX|msg_send!/.test(rustCode)
);

/* ---------------- 4. 前端：纯语义转发，零观测 ---------------- */
ok(
  '前端不调用任何切图 / 结算入口',
  !/(go|settleWheelSwipe|clearWheelProgress|onWheelSwipe)\s*\(/.test(webCode),
  'ended 只允许转给 viewer.handleWheelPhase'
);
ok(
  '前端不拦默认行为、不挂任何 wheel 监听',
  !/preventDefault/.test(webCode) &&
    !/addEventListener\('wheel'/.test(webCode) &&
    !/passive/.test(webCode)
);
ok(
  '前端只认 begin / end，其余 payload 一律忽略',
  /if \(kind !== 'begin' && kind !== 'end'\) return;/.test(webCode) &&
    /sink\?\.\(kind\)/.test(webCode)
);
ok(
  '前端零观测基建（无逐帧数组 / 配对 / 统计 / 定时器）',
  !/MAX_SAMPLES|nativeFrames|pairs\.|statsOf|countBy|ensureWebWheelTap|webTapInstalled/.test(webCode) &&
    !/setTimeout|setInterval/.test(webCode)
);
ok(
  'devtools 极简快照保留（begins / ends 累计不截断）',
  /window\.__picshowWheelPhase = snapshot/.test(webCode) &&
    /__picshowWheelPhaseDump/.test(webCode) &&
    /JSON\.stringify\(snapshot\(\), null, 2\)/.test(webCode) &&
    /totalBegins \+= 1;/.test(webCode) &&
    /totalEnds \+= 1;/.test(webCode) &&
    /begins: totalBegins/.test(webCode) &&
    /ends: totalEnds/.test(webCode)
);
ok(
  '能力来源可观测：source / lastEventAt / sinceLastEventMs，且不引入定时器或 IPC',
  /source: totalBegins \+ totalEnds > 0 \? 'native' : 'none'/.test(webCode) &&
    /lastEventAt = Date\.now\(\);/.test(webCode) &&
    /sinceLastEventMs: lastEventAt === null \? null : Math\.max\(0, Date\.now\(\) - lastEventAt\)/.test(webCode) &&
    !/setTimeout|setInterval/.test(webCode) &&
    (webCode.match(/emit_to\(|listen\(/g) || []).length <= 1
);

/* ---------------- 5. 前后端接线一致 ---------------- */
ok(
  '事件名前后端一致',
  /picshow:\/\/wheel-phase/.test(rust) && /picshow:\/\/wheel-phase/.test(web)
);
ok(
  'viewer 入口先挂监听再报 listening',
  entry.indexOf('installWheelPhaseProbe()') > 0 &&
    entry.indexOf('installWheelPhaseProbe()') < entry.indexOf('api.viewerListening()')
);
ok(
  'lib.rs 在主线程投递安装，且模块只在 macOS 编译',
  /#\[cfg\(target_os = "macos"\)\]\s*\nmod wheel_phase;/.test(lib) &&
    /wheel_phase::install/.test(lib) &&
    /run_on_main_thread/.test(lib)
);
ok(
  'macOS 依赖齐备：NSEvent + block2 feature 与直接依赖',
  /"NSEvent"/.test(manifest) && /"block2"/.test(manifest) &&
    /block2 = "0\.6"/.test(manifest)
);

/* ---------------- 6. 接入后的语义边界：只换结算时机 ---------------- */
ok(
  'viewer 是唯一转发点，且先注册 sink 再挂监听',
  /handleWheelPhase\(kind\) \{/.test(viewer) &&
    /if \(kind === 'begin'\) g\.onWheelPhaseBegin\(\);/.test(viewer) &&
    /else if \(kind === 'end'\) g\.onWheelPhaseEnd\(\);/.test(viewer) &&
    /setWheelPhaseSink\(\(kind\) => viewer\.handleWheelPhase\(kind\)\);/.test(entry) &&
    entry.indexOf('setWheelPhaseSink') < entry.indexOf('installWheelPhaseProbe()')
);
ok(
  'Gestures 用 phaseEnded 切短刻度，65ms 静默兜底仍在',
  /const WHEEL_PHASE_SETTLE_MS = 24;/.test(gestures) &&
    /const ms = this\.wheelSwipe\.phaseEnded\s*\?\s*WHEEL_PHASE_SETTLE_MS\s*:\s*WHEEL_GESTURE_END_MS;/.test(gestures) &&
    /const WHEEL_GESTURE_END_MS = 65;/.test(gestures) &&
    /onWheelPhaseBegin\(\)/.test(gestures) &&
    /onWheelPhaseEnd\(\)/.test(gestures)
);

/* ---------------- 7. 行为级：纯转发（不只看文本） ---------------- */
// 把 ESM 外壳换成可直接在 vm 里跑的脚本，喂三段合成手势与脏 payload，确认
// sink 只收到两类语义、顺序不错、计数不被污染。纯正则证明不了「没漏发」。
const harness = web
  .replace(/^import .*$/m,
    'const isTauri = true; const listen = async (_n, fn) => { globalThis.__handler = fn; };')
  .replace(/^export /gm, '');
const calls = [];
// Date / Math 显式注入：快照里的墙钟时间要能在 vm 里稳定断言，不能靠沙箱隐式
// 内部对象碰巧存在。
const ctx = { window: {}, console, JSON, Date, Math };
vm.runInNewContext(harness, ctx);
ctx.setWheelPhaseSink((kind) => calls.push(kind));
await ctx.installWheelPhaseProbe();
const feed = (payload) => ctx.__handler({ payload });
for (let i = 0; i < 3; i += 1) {
  feed({ kind: 'begin' });
  feed({ kind: 'end' });
}
feed({ kind: 'changed' });
feed({});
feed(null);
const snap = ctx.window.__picshowWheelPhase();
ok(
  '合成三段手势：只收到 3 次 begin + 3 次 end，脏 payload 全部被忽略',
  calls.join(',') === 'begin,end,begin,end,begin,end' &&
    snap.begins === 3 && snap.ends === 3 && snap.last === 'end',
  JSON.stringify({ calls: calls.join(','), snap })
);
feed({ kind: 'begin' });
const mid = ctx.window.__picshowWheelPhase();
ok(
  '惯性未收尾时 begins 可比 ends 多 1（计数是不截断的累计总数）',
  mid.begins === 4 && mid.ends === 3 && mid.last === 'begin' &&
    calls.length === 7,
  JSON.stringify(mid)
);

/* ---------------- 8. 行为级：能力来源可观测 ---------------- */
// 「从未收到事件」必须能一眼看出，而不是靠 begins=0 去猜是 =0 关掉、非 macOS
// 还是 IPC 失败。先在**没有事件**时取一次快照，再喂一帧看状态翻转。
{
  const fresh = web
    .replace(/^import .*$/m,
      'const isTauri = true; const listen = async (_n, fn) => { globalThis.__handler = fn; };')
    .replace(/^export /gm, '');
  const fctx = { window: {}, console, JSON, Date, Math };
  vm.runInNewContext(fresh, fctx);
  await fctx.installWheelPhaseProbe();
  const before = fctx.window.__picshowWheelPhase();
  ok(
    '8.1 一次都没收到原生事件时 source=none，且不臆测原因',
    before.source === 'none' && before.begins === 0 && before.ends === 0 &&
      before.lastEventAt === null && before.sinceLastEventMs === null &&
      before.last === null,
    JSON.stringify(before)
  );
  fctx.__handler({ payload: { kind: 'begin' } });
  const after = fctx.window.__picshowWheelPhase();
  ok(
    '8.2 收到首帧后 source 翻成 native，记录墙钟时间与 0ms 量级的间隔',
    after.source === 'native' && after.begins === 1 &&
      typeof after.lastEventAt === 'number' && after.lastEventAt > 0 &&
      typeof after.sinceLastEventMs === 'number' && after.sinceLastEventMs >= 0,
    JSON.stringify(after)
  );
  fctx.__handler({ payload: { kind: 'changed' } });
  const dirty = fctx.window.__picshowWheelPhase();
  ok(
    '8.3 脏 payload 不刷新能力来源时间戳（过滤先于记账）',
    dirty.lastEventAt === after.lastEventAt && dirty.begins === 1 &&
      dirty.source === 'native',
    JSON.stringify({ before: after.lastEventAt, after: dirty.lastEventAt })
  );
}

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ wheel-phase：默认开启 / Rust 归一化 begin·end / 每手势 2 帧 / 只观察不吞事件 / 65ms 兜底 检查全部通过');
