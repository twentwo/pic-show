#!/usr/bin/env node
/**
 * 「预览层必须能退干净」检查器。
 *
 * 为什么单独一个文件：这类缺陷在静态检查里**看不见症状** —— 代码里既有
 * `close()` 也有 `finishClose()`，看起来是成对的；真正的区别在于它们之间是
 * 不是隔着几段「不一定会兑现」的 await。只要有一处 `await` 挂住，那层
 * `position: fixed; inset: 0; z-index: 200` 的不透明预览就永远留在屏幕上，
 * 于是「退出预览后界面无响应、无法滚动」。
 *
 * 而「挂住」不是假设：`requestAnimationFrame` 在窗口做全屏转场、被最小化、
 * 被切到另一个 Space 时**真的会停**，而且不通知任何人。所以这里断言的不是
 * 「有没有写收尾」，而是：
 *
 *   1. 收尾是否挂在 `finally` 上（任何路径都跑得到）；
 *   2. 收尾是否幂等（重复跑不会二次触发宿主回调）；
 *   3. 每一段 await 是否都有硬超时（帧停摆时也会兑现）；
 *   4. 幕布是否有保险丝、开场等待是否可取消；
 *   5. 形态切换的串行队列是否会被一次挂起永久毒化。
 *
 * 动态的那一半在 `tools/check_exit.mjs`（真跑一遍三种退出方式）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const viewer = read('ui/js/viewer.js');
const viewerMain = read('ui/js/viewer-main.js');
const main = read('ui/js/main.js');
const async_ = read('ui/js/async.js');

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

console.log('收尾必然发生');

ok(
  'close() 把收尾放在 finally 里（动画 / IPC / 幕布任一段挂住也收得掉）',
  /try \{\s*await this\.playClose\(\{ fromDismiss \}\);\s*\} finally \{\s*this\.finishClose\(\);\s*\}/.test(
    viewer
  )
);
ok(
  'finishClose() 幂等（重复调用不会二次触发宿主回调）',
  /finishClose\(\) \{[\s\S]{0,300}?if \(!this\.isOpen && !this\.closing\) return;/.test(
    viewer
  )
);
ok(
  'close() 本体不再直接写收尾逻辑（只留一条路）',
  (viewer.match(/this\.finishClose\(\)/g) || []).length === 2,
  String((viewer.match(/this\.finishClose\(\)/g) || []).length)
);

console.log('每一段 await 都有硬超时');

ok(
  '退场动画与幕布淡出都带硬超时（animation.finished 在帧停摆时不兑现）',
  (viewer.match(/withTimeout\(/g) || []).length >= 3,
  String((viewer.match(/withTimeout\(/g) || []).length)
);
// 「幕后换场」那一段随分家一起删掉了：预览是独立窗口，收摊时它只是被藏起
// 来，图片墙那条窗口一个像素都没被动过，也就没有需要藏在幕布后面的重排。
// 留着一个没人会挂的钩子，等于把「这里曾经切过窗口形态」这件事变成死代码。
ok(
  '不再有幕后换场那一段（钩子没人挂，等它只是干等）',
  !/prepareBackstage|onBeforeClose|BACKSTAGE_MS/.test(viewer)
);
ok(
  '放大态的 reset 也带超时（否则缩不回来就永远关不掉）',
  /withTimeout\(this\.g\.reset\(true\), \d+\)/.test(viewer)
);
ok(
  'viewer 从 async.js 引入 withTimeout（不自己另造一套）',
  /import \{ withTimeout \} from '\.\/async\.js';/.test(viewer)
);

console.log('等帧必须能兜底');

// 「等帧」是这一类故障的源头：rAF 停摆时它永不兑现，而它恰好排在关闭链上。
ok(
  'nextFrames 同时挂了 setTimeout 兜底',
  /export function nextFrames\(n, budgetMs = \d+\)[\s\S]*?timer = setTimeout\(finish, budgetMs\)/.test(
    async_
  )
);
ok(
  'waitFor 同时挂了 setTimeout 兜底',
  /export function waitFor\(predicate, maxFrames = \d+, budgetMs = \d+\)[\s\S]*?timer = setTimeout\(finish, budgetMs\)/.test(
    async_
  )
);
ok(
  'waitFor 的判定自己抛错时不再空等（环境已经不是预期样子）',
  /\} catch \{\s*\/\/ 判定自己炸了就别再等[\s\S]*?hit = true;/.test(async_)
);
ok(
  'async.js 把「rAF 会停」这件事写进了文件头注释（后来人不会再裸等帧）',
  /requestAnimationFrame` 是会停的/.test(async_) || /rAF 的回调就停摆/.test(async_)
);
ok(
  '预览窗口不再自己定义等帧函数（统一走 async.js）',
  !/const waitFor = \(predicate/.test(viewerMain) &&
    /import \{ waitFor, withTimeout \} from '\.\/async\.js';/.test(viewerMain)
);

console.log('预览窗口的让位必然发生');

// 预览是独立窗口，它「让位」的出口只有一个 —— 收尾一旦漏掉，用户看到的就是
// 一块永远退不掉的全屏画面（和旧架构里那层卡住的遮罩是同一类故障）。
ok(
  '关闭与取消共用同一条出路（onClosed 是唯一出口）',
  (viewer.match(/this\.onClosed\?\.\(\);/g) || []).length === 2,
  String((viewer.match(/this\.onClosed\?\.\(\);/g) || []).length)
);
ok(
  'abort 之前先清掉幕布保险丝（不留悬空定时器）',
  /abort\(\) \{[\s\S]{0,300}?clearTimeout\(this\._primeFuse\);[\s\S]{0,300}?this\.onClosed\?\.\(\);/.test(
    viewer
  )
);
ok(
  'abort 自己不碰 isOpen / closing（画面根本没开，没有退场动画可言）',
  /abort\(\) \{\s*if \(this\.isOpen \|\| this\.closing\) return;/.test(viewer)
);
ok(
  '预览侧把「用户在看第几张」回传给主窗口（退出后网格才停得到那一格）',
  /api\.closeViewer\(Math\.max\(0, viewer\.index\)\)/.test(viewerMain)
);

console.log('幕布与开场等待');

ok(
  '幕布带保险丝（迟迟没人接手就自己撤掉）',
  /this\._primeFuse = setTimeout\(\(\) => this\.cancelPrime\(\), PRIME_FUSE_MS\)/.test(
    viewer
  ) && /const PRIME_FUSE_MS = \d+;/.test(viewer)
);
ok(
  'cancelPrime 会一并清掉保险丝（不留悬空定时器）',
  /cancelPrime\(\) \{\s*clearTimeout\(this\._primeFuse\);/.test(viewer)
);
ok(
  'finishClose 也会清掉保险丝与根容器的行内透明度',
  /clearTimeout\(this\._primeFuse\);\s*this\._primeFuse = 0;\s*this\.root\.style\.opacity = '';/.test(
    viewer
  )
);
ok(
  'open() 被拒时把幕布摘掉（不能让一层遮罩无限期留在屏幕上）',
  /if \(!this\.items\.length\) \{\s*this\.cancelPrime\(\);\s*return;\s*\}/.test(
    viewer
  ) &&
    /if \(this\.isOpen \|\| this\.closing\) \{\s*clearTimeout\(this\._primeFuse\);[\s\S]*?remove\('is-priming'\);\s*return;\s*\}/.test(
      viewer
    )
);
// 切全屏那串 IPC 还没走完时，画面一格都没画。`close()` 要求 `isOpen` 为真，
// 那时会被挡掉 —— 少了 abort，用户按 Esc 是**毫无反应**的。
ok(
  '开场等待期间按 Esc = 取消这次打开（那段等待里按 Esc 不能毫无反应）',
  /if \(!this\.isOpen && !this\.closing\) \{\s*if \(event\.key === 'Escape'\)[\s\S]{0,120}?this\.abort\(\);/.test(
    viewer
  )
);
ok(
  '预览要等会话到手才开画（没有会话就进入待命，不空转）',
  /const session = await api\.viewerBoot\(\)/.test(viewerMain) &&
    /if \(session\) \{\s*await openSession\(session\);\s*\}/.test(viewerMain)
);
ok(
  '预览侧的异常统一上报（webview 的 console 不进终端）',
  /window\.addEventListener\('error'/.test(viewerMain) &&
    /window\.addEventListener\('unhandledrejection'/.test(viewerMain)
);

console.log('卸载出口');

ok('viewer 有 destroy()（拆观察器与全局监听器）', /^  destroy\(\) \{/m.test(viewer));
ok(
  'destroy() 里断开了 ResizeObserver 与 keydown / resize 监听',
  /this\._ro\?\.disconnect\(\);/.test(viewer) &&
    /window\.removeEventListener\('keydown', this\._onKey, true\);/.test(viewer) &&
    /window\.removeEventListener\('resize', this\._onResize\);/.test(viewer)
);
ok('strip 也有 destroy()（胶片条的 RO 不能留着继续回调）', /^  destroy\(\) \{/m.test(read('ui/js/strip.js')));

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 预览层卸载检查全部通过');
