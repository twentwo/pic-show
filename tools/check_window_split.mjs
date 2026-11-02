/**
 * 「窗口几何终身只读」检查器。
 *
 * ## 这条约束是什么
 *
 * **图片墙（`main` 窗口）的几何与形态，任何代码路径都不许写。** 它既不进全屏、
 * 也不被摆尺寸、也不被摘装饰 —— 预览是**另一个物理窗口**（`viewer`）的事。
 *
 * ## 为什么必须这样
 *
 * 只要共用一条窗口，进预览就只能靠切换那一条窗口的形态，而**任何**一次对
 * 几何或样式的写入，都会被窗口层记成「退出全屏时照着还原」的目标：
 *
 *   1. 运行时摘过装饰 → tao 把无边框那份 styleMask 存进 `saved_style`，退出
 *      全屏时**无条件**写回，我们随后补回标题栏那一笔必然被覆盖，或被「已经是
 *      了」的闸门变成空操作 —— 表现就是**标题栏回不来**；
 *   2. 进全屏前把窗口摆到整块屏 → macOS 当场判定它 `zoomed`（frame 等于屏幕
 *      可视区即命中），AppKit 从此把「最大化」当成全屏前的样子，之后无论进出
 *      多少次，退出都一丝不差地还原到**最大化**。
 *
 * 这些写入和我们补的写入都排在同一个 `DispatchQueue.main` 的 FIFO 里，谁在后
 * 谁生效 —— 纯竞态。靠「等 N 毫秒再写」去卡顺序是卡不住的，机器一换、系统一
 * 忙就失手。
 *
 * 所以改成两条窗口**物理分家**：预览自己独占一个窗口、自己进全屏、关掉时自己
 * 让位。图片墙那条窗口因此一次全屏都没进过、一次几何都没被写过 —— 它也就
 * 根本不存在「退出预览要还原到什么」这个问题。
 *
 * ## 这里断言的四件事
 *
 *   1. Rust 侧不写几何（不 `set_size` / `set_position` / `set_maximized`）；
 *   2. Rust 侧不切装饰，且预览进全屏没有 `maximize` 兜底；
 *   3. 全屏只切在预览窗口上，主窗口连一次都不进；
 *   4. 前端不再有「预览形态」这套记账（形态根本不属于主窗口）。
 *
 * 系统级的那半边证据在 `tools/appkit_geometry.swift`：它直接用 AppKit 复刻
 * tao 的行为，证明「先摆到整屏」确实会让 `isZoomed` 变 YES。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/**
 * 去掉 Rust 注释，只留代码。
 *
 * 「某个危险调用不该存在」这类断言必须扫代码而不是原文：解释「为什么删掉它」
 * 的注释里必然要提这个名字，扫原文会永远报假警。
 */
function stripComments(src) {
  let out = '';
  let mode = 'code';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === '"') {
        mode = 'string';
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    out += ch;
    if (ch === '"') mode = 'code';
    i += 1;
  }
  return out;
}

const commands = read('src-tauri/src/commands.rs');
const commandsCode = stripComments(commands);
const macosCode = stripComments(read('src-tauri/src/macos.rs'));
const libCode = stripComments(read('src-tauri/src/lib.rs'));
const main = read('ui/js/main.js');
const viewerMain = read('ui/js/viewer-main.js');
const api = read('ui/js/api.js');

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

console.log('Rust 侧：不写几何');

// 这是前几轮反复失手的那一处：把窗口先摆到整块屏，macOS 当场判定它 zoomed。
// 现在整个后端连一个摆尺寸的地方都不该有 —— 两条窗口的几何都由用户在
// tauri.conf.json 里给、由用户自己拖动，程序一次都不碰。
for (const [label, code] of [
  ['commands.rs', commandsCode],
  ['macos.rs', macosCode],
  ['lib.rs', libCode]
]) {
  ok(
    `${label} 不写窗口尺寸 / 位置（几何终身只读）`,
    !/set_size\s*\(/.test(code) &&
      !/set_position\s*\(/.test(code) &&
      !/set_outer_position\s*\(/.test(code) &&
      !/set_min_size\s*\(/.test(code),
    code.match(/(?:set_size|set_position|set_outer_position|set_min_size)\s*\(/g)?.join(', ') ?? ''
  );
  ok(
    `${label} 不动最大化 / 装饰（这两样都是不可撤回的一步）`,
    !/(un)?maximize\s*\(/.test(code) && !/set_decorations\s*\(/.test(code),
    code.match(/(?:(?:un)?maximize|set_decorations)\s*\(/g)?.join(', ') ?? ''
  );
}

console.log('Rust 侧：全屏只切在预览窗口上');

// 主窗口连一次全屏都不进 —— 这是整个方案的立身之本。
ok(
  '没有对主窗口切全屏的调用',
  !/MAIN_LABEL[\s\S]{0,300}?set_fullscreen/.test(commands)
);
// 预览进全屏**没有** maximize 兜底：最大化在本项目里没有撤回路径，一旦走到
// 就把窗口永久留在放大态 —— 正是「退出预览后回不到原尺寸」的直接来源。
// 全屏拿不到就保持窗口态，预览照样能用，比不可逆的一步安全。
ok(
  '预览进全屏没有 maximize 兜底（宁可用窗口态，也不留不可逆的一步）',
  (() => {
    const start = commands.indexOf('pub fn viewer_ready(');
    const end = commands.indexOf('#[tauri::command]', start);
    const body = commands.slice(start, end < 0 ? undefined : end);
    return (
      start > 0 &&
      /set_fullscreen\(true\)/.test(body) &&
      !/maximize/.test(body) &&
      /保持在窗口态/.test(body)
    );
  })()
);
// 窗口几何终身只读的另一半：预览窗口关闭时是整条销毁，不隐藏、也不重摆。
//
// 让位从 `close_viewer` 本体挪到了 `release_viewer`（销毁确认要跑在后台线程），
// 所以这里盯的是后者：它只许做「destroy + 确认」两件事，几何一个字都不许写；
// 尤其不许 `hide()` 或 `set_fullscreen(false)` —— 那正是空白窗口的来源。
ok(
  '关闭预览不做任何几何操作（destroy + 确认而已）',
  (() => {
    const start = commands.indexOf('pub(crate) fn release_viewer(');
    const end = commands.indexOf('/// 销毁确认的轮询间隔', start);
    const body = commands.slice(start, end < 0 ? undefined : end);
    return (
      start > 0 &&
      /window\.destroy\(\)/.test(body) &&
      /confirm_viewer_destroyed\(app\)/.test(body) &&
      !/\.hide\(\)/.test(body) &&
      !/set_fullscreen\(false\)/.test(body) &&
      !/set_size|set_position|set_outer_position|maximize|set_decorations/.test(
        stripComments(body)
      )
    );
  })()
);
// `close_viewer` 本体不许再碰窗口：它只负责回填索引、把让位派到后台线程。
ok(
  'close_viewer 本体不碰窗口（让位整段派到后台线程）',
  (() => {
    const start = commands.indexOf('pub fn close_viewer(');
    const end = commands.indexOf('pub(crate) fn release_viewer(', start);
    const body = commands.slice(start, end < 0 ? undefined : end);
    return (
      start > 0 &&
      /std::thread::spawn\(move \|\| release_viewer\(&handle\)\);/.test(body) &&
      !/window\.hide\(\)|set_fullscreen|set_size|set_position/.test(stripComments(body))
    );
  })()
);

console.log('前端：形态记账已经消失');

// 「预览形态」这套记账是为「同一条窗口切来切去」服务的。分家之后它全是负债：
// 一处记账就等于一处可能与实际状态失同步的地方。
ok(
  '主窗口不再有预览形态的记账（形态不属于它）',
  !/isStageFullscreen/.test(main) &&
    !/useImmersiveStage/.test(main) &&
    !/stageQueue/.test(main) &&
    !/wantedStage/.test(main)
);
ok(
  '不再有形态切换命令（set_stage / window_stage 都已删除）',
  !/api\.setStage\(/.test(main) &&
    !/api\.windowStage\(/.test(main) &&
    !/invoke\('set_stage'/.test(api) &&
    !/invoke\('window_stage'/.test(api)
);
// 前端也不该自己去动窗口 —— 那属于后端，且只有预览那条窗口才进全屏。
ok(
  '前端不调用任何窗口几何 / 形态命令',
  !/setSize|setPosition|maximize\(|setDecorations|setFullscreen/.test(main) &&
    !/setSize|setPosition|maximize\(|setDecorations|setFullscreen/.test(viewerMain)
);
// 主窗口唯一的窗口动作就是「点亮」与「让位」。
ok(
  '主窗口只有 show / focus 两个动作（其余一概不碰）',
  /api\.showWindow\(\)/.test(main) &&
    !/api\.hideWindow\(/.test(main)
);

console.log('系统级证据');

// 这套结论最初是拿 AppKit 实测出来的，不是读源码推出来的。探针留在仓库里，
// 换机器 / 换 macOS 版本时可以重跑。
ok(
  '仓库里留有可复跑的 AppKit 几何探针',
  /NSWindow/.test(read('tools/appkit_geometry.swift')) &&
    /isZoomed/.test(read('tools/appkit_geometry.swift'))
);
// 「退出全屏 → 隐藏」的时序是实测出来的：frame 落到终值比
// `windowDidExitFullScreen:` 早约 530ms，所以拿尺寸当「转场播完」的判据，会把
// `orderOut:` 掐在转场里 —— 窗口随后被转场收尾拉回来，就是那块盖在图片墙上的
// 空白窗口。而 `--close-in-fullscreen` 证明：在全屏里直接 `close()` 时窗口从层
// 级移除、AppKit 自己走完 `didExit` 回收桌面、全程没有常规尺寸的可见帧。现在
// 的生产代码走的是后者。换机器 / 换 macOS 版本时可以重跑。
const exitProbe = read('tools/appkit_fullscreen_exit.swift');
ok(
  '仓库里留有可复跑的「退出全屏 → 隐藏」时序探针',
  /NSWindow/.test(exitProbe) &&
    /windowDidExitFullScreen/.test(exitProbe) &&
    /--at-didexit/.test(exitProbe)
);
ok(
  '时序探针留有「全屏中直接销毁」的对照模式（生产代码的依据）',
  /--close-in-fullscreen/.test(exitProbe) &&
    /sawNormalVisible/.test(exitProbe)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 窗口几何终身只读检查全部通过');
