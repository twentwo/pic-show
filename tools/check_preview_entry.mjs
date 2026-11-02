/**
 * 全屏预览入口检查器：三条进入预览的路必须汇聚到**同一套**实现。
 *
 * 为什么单独一个文件：这类问题没有任何运行时症状 —— 两边的动画都能播、都能
 * 关闭，只是「少给一个来源矩形」「少给一个中心兜底倍率」，于是同一个全屏预
 * 览在两条入口上悄悄长成两种样子。靠肉眼比对 `open()` 的 options 是记不住
 * 的，所以把「入口唯一」「呈现一致」「几何换算对称」写成断言。
 *
 * 预览现在是**独立的物理窗口**（`viewer`），与主窗口之间隔着两个 webview。
 * 所以这里盯的第三条尤其关键：来源几何在两侧必须**对称折算** —— 一边折出
 * 去、另一边折回来，用错单位或漏掉原点都会让开场动画从错误的位置长出来，
 * 而那种偏差在单显示器上恰好表现为 0。
 *
 * 断言五类：
 *   1. 唯一性 —— 预览只有 `api.openViewer` 一个发起口、一个接收口；
 *   2. 一致性 —— 开场 / 背景 / 关闭的时长与缓动在代码里是同一份常量；
 *   3. 几何对称 —— 跨窗口传的矩形两侧都用物理像素，且各自负责一半换算；
 *   4. 会话差异 —— 「关闭即退出」只属于「打开方式」，图片墙必须回得去；
 *   5. 收尾时序 —— 退场动画的落点就是开场记下的那一格。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/**
 * 去掉 JS 注释，只留代码。
 *
 * 「某个名字不该再出现」这类断言必须扫代码而不是原文：解释「为什么删掉它」
 * 的注释里必然要提这个名字，扫原文会永远报假警 —— 于是注释越详实、检查越
 * 吵，最后人只能把注释删掉，那是最坏的结果。
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
      if (ch === '"' || ch === "'" || ch === '`') {
        mode = ch;
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
      i += 1;
      continue;
    }
    // 字符串内部：只认转义与自己的收尾引号，其余照抄。
    if (ch === '\\') {
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === mode) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }
  return out;
}

const viewer = read('ui/js/viewer.js');
const main = read('ui/js/main.js');
const viewerMain = read('ui/js/viewer-main.js');
const launch = read('ui/js/launch.js');
const geometry = read('ui/js/geometry.js');
const css = read('ui/styles/app.css');
const viewerCode = stripComments(viewer);

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

/* ---------------- 1. 唯一性 ---------------- */

console.log('唯一入口');

ok('preview 有唯一入口 `openFullscreen`', /^  openFullscreen\(index, source = null\) \{/m.test(viewer));
ok(
  '预览侧那条也只是它的一个调用者（不再另配一套几何）',
  /openLaunch\(index, rect\) \{\s*this\.openFullscreen\(index, \{ rect \}\);\s*\}/.test(viewer)
);
ok('open() 不再读 `fadeIn` 开关（渐变是这个入口的固有形态）', !/if \(options\.fadeIn\)/.test(viewer));
ok(
  'open() 的开场恒带透明度渐变（与位移等长、并行叠加）',
  /const anim = slide\.animate\(\s*\{ transform: \[from, 'translate3d\(0px, 0px, 0\) scale\(1\)'\] \},/.test(
    viewer
  ) &&
    /slide\.animate\(\{ opacity: \[0, 1\] \}, \{\s*duration: OPEN_MS,\s*easing: TWEEN_FADE_EASE,/.test(
      viewer
    )
);
ok('open() 的文档把调用者指向 openFullscreen', /\{@link Viewer#openFullscreen\}/.test(viewer));

// 主窗口：**发起**的那一侧。三条路（点击 / 回车 / 打开方式）都汇聚到
// `openViewer` 这一个 IPC 上，所以「这几个入口的预览是否一致」在代码上没有
// 第二种答案。
ok(
  '图片墙点击 → openPreview',
  /onActivate: \(index, cell\) => openPreview\(index, cell\)/.test(main)
);
ok(
  '图片墙回车 → 同一个 openPreview',
  /openPreview\(0, grid\.cellFor\(0\)\)/.test(main)
);
ok(
  '图片墙这条路径只有一次 `api.openViewer`（不重复发起）',
  (main.match(/api\.openViewer\(/g) || []).length === 2,
  String((main.match(/api\.openViewer\(/g) || []).length)
);
// 预览根本不住在这个窗口里 —— 主窗口任何一个预览 DOM / 预览方法都是残留。
ok(
  '主窗口不再碰任何预览 DOM 或预览方法（预览住在另一个窗口）',
  (main.match(/viewer\./g) || []).length === 0 &&
    (main.match(/openFullscreen\(|openLaunch\(/g) || []).length === 0,
  String((main.match(/viewer\./g) || []).length)
);
// 预览侧：**接收**的那一侧，两个入口（待取件 / 事件）共用同一个 openSession。
// 两个入口：冷启动那条走 `viewer_boot` 取到会话，已在跑的那条走 goto 事件。
// 它们必须落到同一个函数，否则「首次打开」与「换一张」会长成两种样子。
ok(
  '预览侧只有一条装配路径 `openSession`（两个入口共用它）',
  (viewerMain.match(/await openSession\(session\);/g) || []).length === 1 &&
    (viewerMain.match(/openSession\(session\)\.catch\(/g) || []).length === 1 &&
    (viewerMain.match(/function openSession\(/g) || []).length === 1
);
ok(
  '预览侧不再直接调 viewer.open（一律经过 openLaunch）',
  (viewerMain.match(/viewer\.open\(/g) || []).length === 0
);

/* ---------------- 2. 一致性 ---------------- */

console.log('呈现一致');

ok(
  '开场只有一处时长 / 缓动（OPEN_MS / EASE）',
  /export const OPEN_MS = \d+;/.test(viewer) &&
    (viewer.match(/duration: OPEN_MS/g) || []).length >= 1 &&
    (viewer.match(/duration: \d+,/g) || []).length <= 8
);
ok(
  '关闭的时长统一取自 CLOSE_MS（经 motionMs 换算，支持减少动态效果）',
  /const ms = motionMs\(CLOSE_MS\);/.test(viewer) &&
    (viewer.match(/duration: ms,/g) || []).length >= 2
);
ok(
  '位移与透明度分开用两套缓动，且都不再出现字面量缓动',
  /easing: TWEEN_FADE_EASE/.test(viewer) &&
    (viewer.match(/easing: '(?:ease-out|linear|ease-in)'/g) || []).length === 0
);
// 跨窗口那次变形有自己的曲线：`EASE` 前段猛冲，用在「从缩略图长到整屏」上就
// 是「啪」地弹开。轨道切换那种同屏位移才用 `EASE`。
ok(
  '开场/收场用跨窗口专用的缓动（不是轨道切换那条）',
  /const MORPH_EASE = 'cubic-bezier\([^)]+\)';/.test(viewer) &&
    /export const OPEN_EASE = MORPH_EASE;/.test(viewer) &&
    (viewer.match(/easing: OPEN_EASE/g) || []).length >= 2 &&
    /easing: OPEN_EASE/.test(viewer)
);
ok(
  '开场与关闭操作的是同一个 backdrop 元素',
  (viewer.match(/this\.backdrop\.animate\(/g) || []).length >= 1 &&
    /setBackdrop\(0\)/.test(viewer)
);

/* ---------------- 2b. 减少动态效果 ---------------- */

console.log('减少动态效果');

ok(
  '转场时长与 FLIP 都过一遍「减少动态效果」开关',
  /const motionOK = \(\) => !reduceMotionQuery\?\.matches;/.test(viewer) &&
    /const motionMs = \(ms\) => \(motionOK\(\) \? ms : REDUCED_MS\);/.test(viewer) &&
    /motionOK\(\) \? this\.zoomStart/.test(viewer)
);
const reducedMs = Number(viewer.match(/const REDUCED_MS = (\d+);/)?.[1] ?? 0);
ok(
  '减少动态效果时仍保留一段最短淡出（完全去掉会让开关失去提示）',
  reducedMs > 0 && reducedMs < 200,
  String(reducedMs)
);

/* ---------------- 3. 跨窗口几何必须两侧对称 ---------------- */

console.log('跨窗口几何');

// 两个窗口的视口原点各不相同，只有折到共同的桌面坐标系里才对得上。
// 这段错了的表现是「多显示器上动画起点偏出屏幕」，单显示器上恰好是 0 ——
// 所以必须钉在代码里，不能靠肉眼。
ok(
  '主窗口把 DOM 矩形折成物理像素的屏幕坐标（加自己的原点、乘 dpr）',
  /const origin = await api\.windowOrigin\(\);/.test(main) &&
    /const dpr = window\.devicePixelRatio \|\| 1;/.test(main) &&
    /x: origin\.x \+ rect\.left \* dpr,/.test(main)
);
ok(
  '预览侧按自己的原点把屏幕矩形折回视口坐标（减原点、除 dpr）',
  /viewportRectFrom\(originRect, frame, dpr\)/.test(viewerMain) &&
    /const left = \(rect\.x - [\s\S]*?\) \/ scale;/.test(launch)
);
// 量到布局这件事，后端给了准数就不要再去猜 `window.screen`：多显示器、带缩放
// 的屏上那两个值常对不齐，判定迟迟不成立，白等出的那几帧画面还没开始长 ——
// 用户看到的就是一段纯黑。
ok(
  '等视口就位时优先用后端回报的真实尺寸（不是拿 window.screen 猜）',
  /viewportMatches\(frame\.width, frame\.height, dpr\)/.test(viewerMain) &&
    /export function viewportMatches\(width, height, dpr/.test(launch)
);
// 单位是物理像素而不是 CSS 像素，是为了绕开 `scale_factor`：那个查询是「发
// 消息给事件循环 → 阻塞等回执」的 getter，在命令里问它会自锁。注意这里盯的
// 是**调用**（`scale_factor(`），注释里提到它不算。
ok(
  '两端都用物理像素，谁都不去问 scale_factor（那个 getter 会自锁）',
  /物理像素/.test(main) &&
    /物理像素/.test(launch) &&
    !/scale_factor\(/.test(main) &&
    !/scale_factor\(/.test(launch)
);
ok(
  '「打开方式」的光标点也折成物理像素屏幕矩形（与点击那条同源）',
  /launchOriginScreenRect\(point, window\.devicePixelRatio \|\| 1\)/.test(main) &&
    /const size = cssSize \* scale;/.test(launch)
);
ok(
  '来源矩形拿不到时退化为屏幕中心（有 plausibility 兜底）',
  /centerScale: CENTER_ZOOM_SCALE/.test(viewer) &&
    /isPlausible\(out, env\) \? out : null/.test(launch)
);

/* ---------------- 4. 会话差异 ---------------- */

console.log('会话差异');

ok(
  '「打开方式」那条会话标记为 immersive（预览侧据此关闭即退出）',
  /api\.openViewer\(payload\.index \?\? 0, origin, true\)/.test(main) &&
    /api\.openViewer\(index, origin, false\)/.test(main)
);
// 「关闭即退出」只有一个出口：Viewer 只管收画面，退出与否由预览入口这个
// 知道会话来源的调用方决定。两条出口并存时会退出两次。
ok(
  '「关闭即退出」只挂在 onClosed 这一个出口上',
  (viewerCode.match(/this\.onClosed\?\.\(\);/g) || []).length === 2 &&
    !/exitOnClose/.test(viewerCode) &&
    !/onExit/.test(viewerCode) &&
    /if \(immersiveSession\) \{\s*api\.exitApp\(\)/.test(viewerMain)
);
// 「打开方式」的 immersive 会话不能走 `close_viewer`：那条命令会把主窗口叫到
// 前台，而主窗口在这条路径上从头到尾都不该露面。
ok(
  'immersive 会话关闭时直接退出，不叫醒主窗口',
  /if \(immersiveSession\) \{\s*api\.exitApp\(\)/.test(viewerMain)
);

/* ---------------- 5. 收尾时序 ---------------- */

console.log('收尾时序');

// 预览窗口里没有网格 DOM，退场落点只能是开场时记下的那一格。
ok(
  '退场落点取开场记下的来源矩形（不再去问网格）',
  /this\.originRect = options\.fromRect \?\? null;/.test(viewer) &&
    /const target = this\.localRect\(this\.originRect\);/.test(viewer) &&
    (viewer.match(/this\.grid\./g) || []).length === 0
);
ok(
  '退场淡的是根容器而不是背景层（根容器自带不透明背景）',
  /await withTimeout\(\s*this\.root\s*\.animate\(\{ opacity: \[1, 0\] \}/.test(viewer)
);
ok(
  '开场先挂幕布，切全屏那段等待不是空白',
  /viewer\.prime\(\);/.test(viewerMain) &&
    /cancelPrime\(\)/.test(viewer) &&
    /\.viewer\.is-priming > \*:not\(\.viewer-backdrop\)/.test(css)
);
// 切全屏与量布局都必须排在切全屏**之后**：全屏落在哪块屏，那一刻才确定。
ok(
  '先切全屏 → 再取原点 → 再等布局 → 最后才播动画',
  viewerMain.indexOf('api.viewerReady()') < viewerMain.indexOf('waitFor(settled') &&
    viewerMain.indexOf('waitFor(settled') < viewerMain.indexOf('viewer.openLaunch(')
);
// 首图预热必须**并行**发出（转场那几百毫秒本来就是要等掉的），但等待要有上限：
// 图片取不到也不能拖着不开场。
ok(
  '首图在切全屏那段等待里并行预热，且等待有上限',
  /const framePromise = api\.viewerReady\(\)/.test(viewerMain) &&
    viewerMain.indexOf('const imagePromise = viewer.preload(') >
      viewerMain.indexOf('const framePromise') &&
    viewerMain.indexOf('const imagePromise = viewer.preload(') <
      viewerMain.indexOf('const frame = await framePromise;') &&
    /withTimeout\(imagePromise, FIRST_IMAGE_MS\)/.test(viewerMain) &&
    /const FIRST_IMAGE_MS = \d+;/.test(viewerMain)
);

/* ---------------- 6. 起点必须与那一格对齐 ---------------- */

console.log('起点对齐');

// 三处曾经各自让起点偏掉一块，而它们的共同点是「编译得过、跑得出、只是从错的
// 地方长出来」—— 只能钉在代码里。
ok(
  '来源矩形先折成 stage 坐标（stage 给顶栏/胶片条让了位，视口坐标会偏）',
  /localRect\(rect\) \{\s*if \(!rect\) return null;[\s\S]*?getBoundingClientRect\(\)/.test(
    viewer
  ) && /this\.localRect\(fromRect\)/.test(viewer)
);
ok(
  '缩放按 cover 取（缩略图是 object-fit: cover 裁的，按宽度对齐会矮一截）',
  /const scale = Math\.max\(byWidth, byHeight\);/.test(geometry)
);
ok(
  'cover 溢出那一格的部分用 clip-path 裁掉（第一帧与缩略图逐像素相同）',
  /clipFor\(local\)/.test(viewer) &&
    /clipPath: \[clip, 'inset\(0px 0px 0px 0px\)'\]/.test(viewer) &&
    /clipPath: \['inset\(0px 0px 0px 0px\)', clip\]/.test(viewer)
);
// 动画对象创建后还要等一帧才开跑，那一帧元素显示的是基础样式（全尺寸、不透
// 明）—— 于是开场先闪一下「画面已经到位」，再缩回去重新长大。
ok(
  '开场动画填满「开跑之前」那一帧（否则先闪一帧全尺寸）',
  /\{ duration: OPEN_MS, easing: OPEN_EASE, fill: 'backwards' \}/.test(viewer)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 全屏预览入口检查全部通过');
