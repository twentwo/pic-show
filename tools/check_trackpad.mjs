/**
 * 触控板横向切换图片的前提检查器。
 *
 * 为什么需要它：这条交互建立在若干**平台前提**之上，而这些前提散落在
 * Rust 侧、配置文件与前端常数里 —— 任何一处被破坏，症状都是「时灵时不灵」，
 * 靠手测很难复现。这里把它们钉成断言：
 *
 *   1. WKWebView 的 `allowsBackForwardNavigationGestures` 必须保持关闭。
 *      它默认是 false（Apple 文档），一旦被打开，系统的「在页面之间轻扫」会
 *      把双指横滑直接吃掉，应用只收到零星几个 wheel 就断流；
 *   2. `allowsMagnification` 同理，打开后整个 webview 会被捏合缩放；
 *   3. 一次滑动只切相邻一张：流中间零次换页（`onWheelAdvance` 恒不调用），
 *      索引唯一可能变化的地方是流停下时的 `settleWheelSwipe`；`settled` 闸门
 *      挡住惯性尾巴 / 重复回调，静默 ≥ 65ms 才算新的一段；
 *   4. 跟手：显示位移渐近压缩到不足一屏（前 75% 仍 1:1），不能被在跑的
 *      动画盖住；累计有上限，反向不必先抵消几千 px；
 *   5. 响应：流中间不插结算，只有流停下来（统一 65ms 窗口）时结算一次；
 *   6. 只在真正消费时才 preventDefault；
 *   7. 前端与后端接得上（onWheelCanStep / onWheelSwipe / onWheelRest /
 *      onSwipeIntent 都有人注册），且旧锁定写法不得回归；
 *   7a. 边界：首张 / 末张继续往外滑只看「相邻一张是否还在列表里」，不看循环
 *      开关；**轨道一格都不动、越界槽不画**，只让当前图有一点弹性位移再弹回
 *      —— 旧实现把 90px 阻尼写进轨道并给越界槽（当前图副本）贴边，从边缘
 *      进来的其实是同一张图，看着正是「末张进入下一张的过渡状态」；
 *   8. 落位 / 回弹：WAAPI 动画**起点**先落地、fill:'forwards'、终值在 finished
 *      里提交（不闪到终点、不闪回起点）；wheel 流结束吸附走不重建手势、不落闸、
 *      时长随剩余距离收缩的轻量路径；单步换页原语一次量视口、跳过静止位写入。
 *   9. 目标图从对应侧边缘**第一帧**就进入视口：槽位换源不清空已有像素
 *      （原子 replaceWith）、静止期双向预热缩略图、单步换页的预热排在填槽
 *      之前、越界槽用当前图保底不露背景、手势开放前等两槽像素（有上限）。
 *  10. 目标图**贴边跟随**：`object-fit: contain` 的居中留白会先于图片进视口，
 *      每个跟手事件都必须在写轨道 transform 之前按 swipeX 的方向 / 进度把
 *      目标槽图片挪到对应侧边缘，并在收尾 / 回弹时与轨道动画同步归零。
 *  11. 落位**速度连续**：结算把跟手速度交给 `wheelLandTiming()`，时长
 *      `clamp(2·dist/v0, MIN_MS, WHEEL_LAND_MS)`、缓动 `cubic-bezier(x1, y1, x2, 1)`
 *      且 `y1 = x1·v0·T/dist` —— 起点速度 = v0、终点速度 = 0，不得再退回
 *      固定 180ms / `EASE`（.22,1,.36,1）那条「快起 + 近零速度慢尾」。
 *      轨道 WAAPI 与贴边量 CSS transition 必须共用同一份时长 / 缓动。
 *
 * 状态机的**时序**行为由 `tools/check_wheel_swipe.mjs` 用可控时钟验证，
 * 这个文件只负责「结构有没有被改坏」。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const srcTaUri = join(root, 'src-tauri/src');
const rustSources = readdirSync(srcTaUri)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => read(`src-tauri/src/${f}`))
  .join('\n');
const confJson = read('src-tauri/tauri.conf.json');
const gestures = read('ui/js/gestures.js');
const viewer = read('ui/js/viewer.js');
const api = read('ui/js/api.js');
const css = read('ui/styles/app.css');

/** 「不存在」类断言必须只看代码：注释里会提到旧写法来解释历史根因 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const gesturesCode = stripComments(gestures);
const viewerCode = stripComments(viewer);

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

const num = (name, src = gestures) =>
  Number((src.match(new RegExp(`const ${name} = ([\\d.]+);`)) || [])[1]);

/* ---------------- 1. 系统级手势开关必须保持关闭 ---------------- */

for (const needle of [
  'allowsBackForwardNavigationGestures',
  'setAllowsBackForwardNavigationGestures',
  'allowsMagnification',
  'setAllowsMagnification'
]) {
  ok(
    `Rust 侧没有打开 ${needle}（否则双指横滑会被系统吃掉）`,
    !rustSources.includes(needle)
  );
}

ok(
  'tauri.conf.json 里也没有动过这些开关',
  !/allowsBackForward|allowsMagnification/.test(confJson)
);

/* ---------------- 2. 一次滑动只切一张：流中零换页、流末唯一结算 ---------------- */

const switchMs = Number((viewer.match(/const SWITCH_MS = (\d+);/) || [])[1]);
const endMs = num('WHEEL_GESTURE_END_MS');
const advanceFrom = viewerCode.indexOf('advanceBy(direction) {');
const advanceBody = advanceFrom > 0
  ? viewerCode.slice(advanceFrom, viewerCode.indexOf('return true;', advanceFrom))
  : '';
const whFrom2 = gesturesCode.indexOf('handleWheelHorizontal(event, dx, dy) {');
const whBody2 = whFrom2 > 0
  ? gesturesCode.slice(whFrom2, gesturesCode.indexOf('\n  }', whFrom2))
  : '';
const settleFrom2 = gesturesCode.indexOf('settleWheelSwipe(waited = 0) {');
const settleBody2 = settleFrom2 > 0
  ? gesturesCode.slice(settleFrom2, gesturesCode.indexOf('reboundWheelSwipe() {', settleFrom2))
  : '';

ok(
  '结算窗口 ≤ 70ms（再长就是「松手后发木」，上一版 120ms）',
  endMs > 0 && endMs <= 70,
  `WHEEL_GESTURE_END_MS=${endMs}`
);

ok(
  '静默 ≥ 结算窗口就开新的一段：清累计 + 复位结算闸门与起手方向',
  /if \(sincePrev >= WHEEL_GESTURE_END_MS\) \{[\s\S]{0,200}?this\.clearWheelProgress\(\);[\s\S]{0,120}?s\.settled = false;[\s\S]{0,120}?s\.dir = 0;/.test(gestures) &&
    /s\.at = now;/.test(gestures)
);

// 旧的「锁满动画时长 + 解锁三出口」状态机一旦回归，抬手再滑会被整段吞掉。
// 新契约用的是**单次结算闸门**，不是那种锁。
ok(
  '旧锁定写法不得回归（locked / 解锁三出口 / 反向行程 / 锁定硬上限）',
  !/s\.locked|s\.lockedAt|s\.rev|wheelGestureRestarted|trackWheelReverse|lockWheelSwipe/.test(gesturesCode) &&
    !/WHEEL_REVERSE_TRAVEL|WHEEL_LOCK_MAX_MS|WHEEL_COMMIT_RATIO|WHEEL_RESTART_RATIO|WHEEL_RESTART_MIN_PX|WHEEL_FAST_COMMIT_PX|WHEEL_FLICK_VELOCITY|WHEEL_ADVANCE_MAX/.test(gesturesCode)
);

ok(
  '一段流零次换页：handleWheelHorizontal 不调用 onWheelAdvance，viewer 也不注册它',
  whBody2.length > 0 &&
    !/onWheelAdvance/.test(whBody2) &&
    !/onWheelAdvance/.test(viewerCode) &&
    /advanceBy\(direction\) \{/.test(viewerCode)
);

ok(
  'settled 闸门：初始 false、两个落地结算分支各置一次、同段尾巴直接挡掉',
  /settled: false,/.test(gestures) &&
    /if \(s\.settled\) return;/.test(settleBody2) &&
    (settleBody2.match(/s\.settled = true;/g) || []).length === 2 &&
    /if \(s\.settled\) \{[\s\S]{0,180}?event\.preventDefault\(\);[\s\S]{0,80}?return true;/.test(whBody2)
);

ok(
  'clearWheelProgress 不动 settled（结算完成后闸门要留到新的一段）',
  /clearWheelProgress\(\) \{[\s\S]{0,500}?s\.peakV = 0;[\s\S]{0,140}?s\.intent = false;/.test(gestures) &&
    !/clearWheelProgress\(\) \{[\s\S]{0,700}?s\.settled = false/.test(gestures)
);

ok(
  '显示位移渐近压缩到不足一屏（前 75% 1:1，之后 rubberband，绝不跨到第二张）',
  /const WHEEL_FOLLOW_LINEAR_RATIO = 0\.75;/.test(gestures) &&
    /wheelFollowOffset\(x, limit = 0\) \{[\s\S]{0,400}?const cap = Math\.max\(1, \(limit \|\| this\.o\.view\(\)\.w\) - 1\);[\s\S]{0,320}?rubberband\(distance - linear, cap - linear\)/.test(gestures) &&
    /if \(distance <= linear\) return x;/.test(gestures)
);

ok(
  'wheel 专用边界判定不看循环开关，边界段不再写轨道阻尼',
  /const WHEEL_OVERSCROLL_RUBBER = 90;/.test(gestures) &&
    /export const WHEEL_EDGE_RUBBER = 22;/.test(gestures) &&
    /const limit = canStep \? viewW : WHEEL_OVERSCROLL_RUBBER \+ 1;/.test(gestures) &&
    /onWheelCanStep: \(direction\) => \{[\s\S]{0,260}?return this\.items\.length > 1 && next >= 0 && next < this\.items\.length;/.test(viewer) &&
    !/this\.loop/.test(viewer.slice(viewer.indexOf('onWheelCanStep:'), viewer.indexOf('onWheelCanStep:') + 320))
);

/* ---------------- 7a2. 末张边界：轨道不动 / 越界槽不画 / 只弹当前图 -------- */
// 真 DOM 探针量到过旧实现的症状：末张继续往「下一张」滑时轨道被推到 -86px，
// 越界槽（装着当前图副本 __shown=5）还被贴边 -117px —— 从右边缘进来的其实是
// 同一张图，看着就是「末张正在过渡到下一张」。这里把新的边界契约钉成结构。

const edgeFrom = whBody2.indexOf('const indicated =');
const edgeBranch = edgeFrom > 0
  ? whBody2.slice(edgeFrom, whBody2.indexOf('let carried = 0;', edgeFrom))
  : '';
const edgeMethodStart = gesturesCode.indexOf('wheelEdgeFollow(shown) {');
const edgeMethod = edgeMethodStart > 0
  ? gesturesCode.slice(edgeMethodStart, gesturesCode.indexOf('\n  }', edgeMethodStart))
  : '';
const viewerEdgeFrom = viewerCode.indexOf('followWheelEdge(offset) {');
const viewerEdge = viewerEdgeFrom > 0
  ? viewerCode.slice(viewerEdgeFrom, viewerCode.indexOf('seamMargin(slot, width) {', viewerEdgeFrom))
  : '';

ok(
  '边界判定排在接管之前，命中即走 wheelEdgeFollow 并 return（不 claimTrack / 不贴边）',
  edgeBranch.length > 0 &&
    whBody2.indexOf('const indicated =') < whBody2.indexOf('this.o.claimTrack?.()') &&
    /const edgeCanStep =/.test(edgeBranch) &&
    /if \(!edgeCanStep\) \{/.test(edgeBranch) &&
    /this\.wheelEdgeFollow\(t\.x \+ \(t\.base \?\? 0\)\);/.test(edgeBranch) &&
    /return true;/.test(edgeBranch) &&
    !/claimTrack|onWheelFollow|onSwipeIntent|wheelFollowOffset\(shown, WHEEL_OVERSCROLL/.test(edgeBranch)
);

ok(
  'wheelEdgeFollow：swipeX 归零、轨道恒写基准、只把弹性量交给 onWheelEdge',
  edgeMethod.length > 0 &&
    /this\.swipeX = 0;/.test(edgeMethod) &&
    /this\.applyTrack\(\);/.test(edgeMethod) &&
    /this\.o\.onWheelEdge\?\.\(this\.wheelFollowOffset\(shown, WHEEL_EDGE_RUBBER \+ 1\)\);/.test(edgeMethod) &&
    !/onWheelFollow|onSwipeIntent/.test(edgeMethod)
);

ok(
  'viewer 注册 onWheelEdge；followWheelEdge 只动当前槽，绝不 fill / 贴边越界槽',
  /onWheelEdge: \(offset\) => this\.followWheelEdge\(offset\),/.test(viewer) &&
    /onWheelEdge: \(\) => \{\},/.test(gestures) &&
    viewerEdge.length > 0 &&
    /const cur = this\.currentSlot;/.test(viewerEdge) &&
    /clamp\(carry \+ offset, -WHEEL_EDGE_RUBBER, WHEEL_EDGE_RUBBER\)/.test(viewerEdge) &&
    /this\.setSlotSeam\(slot, slot === cur \? elastic : 0\);/.test(viewerEdge) &&
    !/this\.fill\(|followWheelSeam|bindSlotPixels|slots\[1 \+ dir\]/.test(viewerEdge)
);

ok(
  '边界回弹不掐上一段动画：swipeX === 0 时 reboundWheelSwipe 直接返回',
  /reboundWheelSwipe\(timing\) \{[\s\S]{0,500}?if \(this\.swipeX === 0\) return;[\s\S]{0,500}?this\.animateTrackTo\(0, duration, easing\);/.test(gesturesCode) &&
    /const duration = Number\.isFinite\(timing\?\.duration\) \? timing\.duration : 200;/.test(gesturesCode) &&
    /const easing = typeof timing\?\.easing === 'string' \? timing\.easing : EASE_SOFT;/.test(gesturesCode)
);

ok(
  '累计夹在两屏内（反向不必抵消几千 px，压缩区间仍有渐近变化）',
  /const travelCap = limit \* 2;/.test(gestures) &&
    /if \(Math\.abs\(rawShown\) > travelCap\) \{[\s\S]{0,180}?t\.x = Math\.sign\(rawShown\) \* travelCap - t\.base;/.test(gestures)
);

ok(
  '同一段里掉头：反向必须靠位移重新达标，峰值速度不算数（不误翻一张）',
  /dir: 0,/.test(gestures) &&
    /if \(!t\.dir\) t\.dir = edgeDir;/.test(gestures) &&
    /if \(!t\.dir\) t\.dir = direction;/.test(gestures) &&
    /const reversed = s\.dir !== 0 && direction !== s\.dir;/.test(settleBody2) &&
    /const hit = reversed \? far : far \|\| fast;/.test(settleBody2)
);

ok(
  '结算完只清本段进度、不落锁，并把跟手速度交给落位（下一段流照常重新累计）',
  /clearWheelProgress\(\) \{[\s\S]*?s\.x = 0;[\s\S]*?s\.base = null;[\s\S]*?s\.peakV = 0;/.test(gestures) &&
    /const velocity = Math\.max\(Math\.abs\(s\.vx\), s\.peakV \* 0\.4\);/.test(settleBody2) &&
    /this\.clearWheelProgress\(\);\s*this\.o\.onWheelSwipe\?\.\(direction, \{ fromSwipe: true, velocity \}\);/.test(gestures)
);

ok(
  '单步换页原语保留（rebalance / 预热 / 已解码池配套），但不接入 wheel',
  advanceBody.length > 0 &&
    /this\.switching = false;/.test(advanceBody) &&
    /this\.rebalance\(\{ view, skipTransform: true \}\);/.test(advanceBody) &&
    !/attachGestures|animateTrack\(|this\.switching = true/.test(advanceBody)
);

ok(
  'wheel 结算的 go(fromWheel) 只把变换目标 retarget 到新当前槽（不重建手势）',
  /retarget\(el\) \{[\s\S]*?this\.el = el;/.test(gestures) &&
    /this\.g\?\.retarget\(this\.currentSlot\);/.test(viewer)
);

ok(
  '流结束由 onWheelRest 补给当前那张的原图与邻图（结算帧不撞解码）',
  /onWheelRest: \(\) => \{[\s\S]*?this\.startFullLoad\(\);[\s\S]*?this\.preloadNeighbors\(\);/.test(viewer) &&
    advanceBody.length > 0 &&
    !/startFullLoad\(\)/.test(advanceBody)
);

ok(
  '起手就沿方向多张预热（onSwipeIntent → prefetchNeighbor，默认 PREFETCH_RUN）',
  /prefetchNeighbor\(direction, count = PREFETCH_RUN\) \{[\s\S]*?n <= count/.test(viewer) &&
    /onSwipeIntent: \(direction\) => this\.prefetchNeighbor\(direction\)/.test(viewer) &&
    /this\.o\.onSwipeIntent\?\.\(this\.swipeX < 0 \? 1 : -1\);/.test(gestures)
);

ok(
  '横向判定排在 enabled 闸门之前（切换动画期间那一段也要记账）',
  (() => {
    const call = gestures.indexOf('this.handleWheelHorizontal(event, dx, dy)');
    const gate = gestures.indexOf('if (!this.enabled) return;', call);
    return call > 0 && gate > call;
  })()
);

ok(
  '单指横滑：一次「按下 → 抬起」有并且只有一个消费凭证（swipeFired）',
  /this\.swipeFired = true;/.test(gestures) &&
    /this\.swipeFired \|\| !this\.enabled \|\| !\(far \|\| fast\)/.test(gestures)
);

ok(
  '切图 / 展开动画期间不接受新的 pointerdown（否则 track 会停在半张图的位置）',
  /onPointerDown\(event\) \{[\s\S]*?if \(!this\.enabled\) return;[\s\S]*?this\.pointers\.set/.test(
    gestures
  )
);

/* ---------------- 3. 跟手：位移要真的写进 transform ---------------- */

ok(
  '跟手位移每个事件都写进轨道 transform，且目标图贴边回调排在写 transform 之前（起手第一帧就可见）',
  /this\.swipeX = this\.wheelFollowOffset\(shown, limit\);[\s\S]{0,420}?this\.o\.onWheelFollow\?\.\(this\.swipeX, viewW\);\s*this\.applyTrack\(\);/.test(gesturesCode)
);

// Web Animations 的关键帧优先级高于内联样式：回弹 / 收尾动画没走完时写
// `style.transform` 是被盖住的 —— 表现就是「头几帧纹丝不动，动画一结束又
// 突然跳过去」。跟手之前必须先 cancelAnim。
ok(
  '跟手写样式之前先掐掉还在跑的轨道动画（否则关键帧会盖住内联样式）',
  /if \(this\.anim\) \{[\s\S]{0,220}this\.cancelAnim\(\);[\s\S]{0,220}t\.base = claimed/.test(gestures)
);

// 本实例的 `anim` 只是回弹动画；切图的收尾动画跑在同一个 track 上、句柄在
// viewer 手里。不接管的话，连续切换时那几百毫秒里的跟手位移全被关键帧盖住。
ok(
  '跟手之前向调用方接管「切图收尾动画」（跨实例的 track 动画不归本实例管）',
  /claimTrack: \(\) => this\.claimTrack\(\)/.test(viewer) &&
    /claimTrack\(\) \{\s*const anim = this\.trackAnim;\s*if \(!anim \|\| anim\.playState !== 'running'\) return null;/.test(
      viewer
    ),
  'viewer 里要有 claimTrack，并只在动画运行中接管'
);

ok(
  '接管时读「视觉当前位置」而不是代码里的终值（否则接管那一帧会跳）',
  /getComputedStyle\(this\.track\)\.transform\)\.m41/.test(viewer) &&
    /return visual - this\.trackOffset;/.test(viewer)
);

ok(
  '接管后立刻放开 switching / enabled（新手势不必再等一次动画）',
  /this\.switching = false;\s*this\.rebalance\(\);/.test(viewer) &&
    /if \(this\.g\) this\.g\.enabled = true;\s*return visual - this\.trackOffset;/.test(viewer)
);

ok(
  '接管的偏移参与跟手显示，但结算判据只看最终显示位移 swipeX',
  /this\.swipeX = this\.wheelFollowOffset\(shown, limit\)/.test(gestures) &&
    /const dx = this\.swipeX;/.test(gestures) &&
    /const far = Math\.abs\(dx\) > width \* SWIPE_DISTANCE_RATIO;/.test(gestures)
);

ok(
  '结算 / 回弹都把接管偏移交回 null（否则下一段会多算一截）',
  /s\.base = null;/.test(gestures) &&
    /reboundWheelSwipe\(timing\) \{\s*this\.clearWheelProgress\(\);/.test(gestures) &&
    /settleWheelSwipe\(waited = 0\) \{[\s\S]*?this\.clearWheelProgress\(\);/.test(gestures)
);

ok(
  '旧那次 go() 的 await 回来时若已被接管/被新的一次顶替，就不再碰闸门',
  /if \(gen !== this\.switchGen\) return;/.test(viewer) && /const gen = \+\+this\.switchGen;/.test(viewer)
);

ok(
  '一段手势只量一次视口宽（避免每个事件都强制同步布局）',
  /s\.viewW = this\.o\.view\(\)\.w;/.test(gestures) &&
    /const viewW = s\.viewW \|\| \(s\.viewW = this\.o\.view\(\)\.w\);/.test(gestures)
);

ok(
  '跟手路径不再逐事件 emit（classList / textContent 的写入没必要跟着 120Hz 刷）',
  !/this\.swipeX = this\.wheelFollowOffset\(t\.x, viewW\);[\s\S]{0,160}?this\.emit\(\);/.test(
    gestures
  )
);

ok(
  'wheel 唤醒控件走节流（noteMotion），不是每个事件都续期计时器',
  /this\.noteMotion\(\);/.test(gestures) &&
    !/onWheel\(event\) \{[\s\S]{0,400}?this\.o\.onUserActivity\?\.\(\);/.test(gestures)
);

/* ---------------- 4. 响应：流中间不插收尾，流结束统一吸附 ---------------- */

const exitMin = num('SWITCH_EXIT_MIN_MS', viewer);
const whFrom = gesturesCode.indexOf('handleWheelHorizontal(event, dx, dy) {');
const whBody = whFrom > 0
  ? gesturesCode.slice(whFrom, gesturesCode.indexOf('\n  }', whFrom))
  : '';

ok(
  '流中间不插结算：跟手分支只排定时器，没有当场 settle / 逐张收尾',
  whBody.length > 0 &&
    /this\.armWheelSettle\(\);/.test(whBody) &&
    !/settleWheelSwipe\(|onWheelSwipe\?\.\(/.test(whBody) &&
    !/WHEEL_COMMIT_RATIO|WHEEL_FAST_COMMIT_PX|WHEEL_FLICK_VELOCITY/.test(gesturesCode)
);

ok(
  '吸附判据沿用单指松手那一套（22% 视口 / 0.45 速度 / 28px 最小位移）',
  /const far = Math\.abs\(dx\) > width \* SWIPE_DISTANCE_RATIO;/.test(gestures) &&
    /const fast = Math\.abs\(dx\) > SWIPE_MIN_PX && s\.peakV > SWIPE_VELOCITY;/.test(gestures)
);

ok(
  '结算刻度：默认 65ms 兜底，只有原生相位确认结束才切 24ms 短刻度',
  /const WHEEL_PHASE_SETTLE_MS = 24;/.test(gestures) &&
    /const ms = this\.wheelSwipe\.phaseEnded\s*\?\s*WHEEL_PHASE_SETTLE_MS\s*:\s*WHEEL_GESTURE_END_MS;/.test(gestures) &&
    /\}, ms\);/.test(gestures) &&
    /if \(sincePrev >= WHEEL_GESTURE_END_MS\)/.test(gestures) &&
    !/WHEEL_FLICK_SETTLE_MS/.test(gesturesCode)
);

ok(
  '收尾动画按剩余距离缩放（跟手推掉大半时不再固定 300ms）',
  exitMin > 0 &&
    exitMin < switchMs &&
    /clamp\(\(SWITCH_MS \* dist\) \/ Math\.max\(1, width\), SWITCH_EXIT_MIN_MS, SWITCH_MS\)/.test(
      viewer
    ),
  `exitMin=${exitMin} switchMs=${switchMs}`
);

/* ---------------- 5. 轴向归属：累积判定，一次序列只认一种 ---------------- */

const axisLock = num('WHEEL_AXIS_LOCK_PX');

ok(
  '轴向按累积位移判定（单帧噪声不能把整段横滑钉成缩放）',
  axisLock > 0 &&
    /s\.ax \+= dx;/.test(gestures) &&
    /if \(Math\.max\(Math\.abs\(s\.ax\), Math\.abs\(s\.ay\)\) < WHEEL_AXIS_LOCK_PX\) return true;/.test(
      gestures
    ),
  `AXIS_LOCK_PX=${axisLock}`
);

ok(
  '轴判定之后不再翻案（整串序列只认一种）',
  /if \(s\.axis === null\) \{[\s\S]*?if \(s\.axis !== 'x'\) return false;/.test(gestures)
);

ok(
  '横向占比阈值存在且大于 1（斜向不算横滑）',
  num('WHEEL_AXIS_RATIO') > 1
);

ok(
  '换手势后有明确的重置入口（轴 / 累积 / 速度一起清，状态里没有锁）',
  /function freshWheelSwipe\(\) \{[\s\S]*?axis: null,[\s\S]*?peakV: 0,[\s\S]*?phaseEnded: false\s*\};/.test(
    gestures
  ) &&
    // `dir` 是「本段起手方向」，供掉头时判反向；它不是旧锁（`locked` /
    // `lockedAt` / `rev` 那一套带冷却的状态机）。
    !/locked:|lockedAt:|rev:/.test(gesturesCode) &&
    /这一段\*\*起手\*\*时的翻页方向/.test(gestures) &&
    /resetWheelSwipe\(\) \{\s*clearTimeout\(this\._wheelSettle\);\s*this\._wheelSettle = 0;\s*this\.wheelSwipe = freshWheelSwipe\(\);/.test(
      gestures
    ) &&
    /if \(sincePrev > WHEEL_GESTURE_GAP_MS\) this\.resetWheelSwipe\(\);/.test(gestures)
);

// 「重置后必须在下一次读取前重新取 this.wheelSwipe」：写成
// `const s = this.wheelSwipe; if (...) this.resetWheelSwipe();` 会让 s 一直
// 指向刚被丢掉的对象，每个事件都从 0 累加，跨事件的阈值永远攒不够。
ok(
  '重置之后重新取累积状态（不是接着用被丢掉的旧引用）',
  /if \(sincePrev > WHEEL_GESTURE_GAP_MS\) this\.resetWheelSwipe\(\);\s*const s = this\.wheelSwipe;/.test(
    gestures
  )
);

ok(
  '切换图片重建 Gestures 时，一次手势的状态要跟着交接（否则会重复累积）',
  /this\.wheelSwipe = this\.o\.wheelState \?\? freshWheelSwipe\(\);/.test(gestures) &&
    /wheelState: previous\?\.wheelSwipe,/.test(viewer)
);

/* ---------------- 6. 只在真正消费时 preventDefault ---------------- */

ok(
  'onWheel 里 preventDefault 排在横向判定之后（观察阶段不阻断默认行为）',
  /if \(this\.handleWheelHorizontal\(event, dx, dy\)\) return;[\s\S]*?event\.preventDefault\(\);/.test(
    gestures
  ) &&
    !/onWheel\(event\) \{\s*if \(!this\.enabled\) return;\s*event\.preventDefault\(\);/.test(
      gestures
    )
);

ok(
  '轴判定还没结论时不消费默认行为（装死一两帧，不误判成缩放）',
  /if \(Math\.max\(Math\.abs\(s\.ax\), Math\.abs\(s\.ay\)\) < WHEEL_AXIS_LOCK_PX\) return true;/.test(
    gestures
  )
);

/* ---------------- 7. 方向必须与单指横滑一致 ---------------- */

// 单指横滑的写法是 `dx < 0 ? 1 : -1`（手指向左拖 → 下一张）。wheel 路径的
// 累积量同样是屏幕坐标系下的手势位移（向左为负），所以必须同号 —— 符号反了
// 就是「触控板左右反了」。
ok(
  'wheel 的方向换算与单指横滑一致（dx < 0 → 下一张）',
  /const direction = dx < 0 \? 1 : -1; \/\/ 手指向左 → 下一张/.test(gestures) &&
    /const direction = dx < 0 \? 1 : -1;/.test(gestures)
);

ok(
  '放大态横向平移时内容跟手（rawX 与手势位移同号）',
  /panByWheelX\(dx\) \{[\s\S]*?this\.rawX \+= dx;/.test(gestures)
);

/* ---------------- 8. 冲突规避必须在位 ---------------- */

ok(
  '捏合（ctrl+wheel）与横滑互斥',
  /if \(event\.ctrlKey\) \{\s*this\.resetWheelSwipe\(\);\s*return false;/.test(gestures)
);

ok(
  '右边缘让给 macOS 通知中心',
  /if \(window\.innerWidth - event\.clientX <= EDGE_DEADZONE_PX\)/.test(gestures)
);

ok(
  '已放大时横向平移而不是翻页',
  /if \(this\.isZoomed\) \{[\s\S]*?this\.panByWheelX\(dx\);[\s\S]*?return true;/.test(gestures)
);

ok(
  '「滚动方向：自然」关闭时会按 webkitDirectionInvertedFromDevice 归一化',
  /function wheelSign\(event\) \{[\s\S]*?event\.webkitDirectionInvertedFromDevice === true \? -1 : 1;/.test(
    gestures
  ) && /normalizeWheel\(event, 'x'\) \* sign/.test(gestures)
);

/* ---------------- 9. 首帧不卡：预取 + 提前解码 ---------------- */

ok(
  'viewer 注册了 onWheelSwipe（流结束吸附走 fromWheel 轻量收尾，速度随 opts 透传）',
  /onWheelSwipe: \(direction, opts = \{\}\) => \{\s*this\.go\(direction, \{ fromSwipe: true, fromWheel: true, \.\.\.opts \}\);/.test(
    viewer
  ) && /async go\(delta, \{ fromSwipe = false, fromWheel = false, velocity = 0 \} = \{\}\)/.test(viewer)
);

ok(
  'gestures 结算时带上 fromSwipe 与跟手速度（收尾从手指当前位置和当前节奏接着播）',
  /this\.o\.onWheelSwipe\?\.\(direction, \{ fromSwipe: true, velocity \}\);/.test(gestures) &&
    /const velocity = Math\.max\(Math\.abs\(s\.vx\), s\.peakV \* 0\.4\);/.test(settleBody2)
);

ok(
  '预取方向与结算方向同源（都用显示位移 swipeX，不一边预热上一张一边切下一张）',
  /onSwipeIntent: \(direction\) => this\.prefetchNeighbor\(direction\)/.test(viewer) &&
    /this\.o\.onSwipeIntent\?\.\(this\.swipeX < 0 \? 1 : -1\);/.test(gestures) &&
    /const dx = this\.swipeX;[\s\S]{0,120}?const direction = dx < 0 \? 1 : -1;/.test(gestures)
);

ok(
  '预取时把位图也解码掉（只下载不解码，第一次绘制仍会同步解码）',
  /img\.decode\(\)/.test(api)
);

// 多张预热的窗口彼此重叠：推到第 n 张时，第 n-1、n-2 张也在窗口里。没有去重
// 就会在一段流里把同一张 4K 原图反复解码，预热反而变成跟手阶段的卡顿源。
ok(
  '多张预热按 URL 去重（同一张原图只取一次、只解码一次，失败可重试）',
  /const prefetched = new Map\(\);/.test(api) &&
    /const cached = prefetched\.get\(src\);\s*if \(cached\) return cached;/.test(api) &&
    /prefetched\.set\(src, promise\);/.test(api) &&
    /if \(prefetched\.get\(src\) === promise\) prefetched\.delete\(src\);/.test(api)
);

/* ---------------- 10. 回弹被打断时不能丢位移 ---------------- */
// 回弹是 WAAPI 关键帧，优先级高于内联样式：`cancel()` 会让视觉瞬间掉回内联值。
// 所以掐掉回弹**之前**必须把「画面此刻停在哪」读出来接住，否则那一段没走完的
// 位移会整段消失、画面往回跳 —— 「前一段位移丢失」。
ok(
  '跟手前先读出轨道的视觉位置再掐自己的回弹动画',
  /if \(this\.anim\) \{\s*carried = this\.trackVisualOffset\(\);\s*this\.cancelAnim\(\);\s*\}/.test(
    gestures
  )
);

ok(
  '接管偏移优先用 claimTrack 的返回值，没有才用回弹中途的位置',
  /const claimed = this\.o\.claimTrack\?\.\(\);\s*t\.base = claimed != null \? claimed : carried;/.test(
    gestures
  )
);

ok(
  '视觉位置从 computed transform 读（内联样式会被关键帧盖住）',
  /new DOMMatrixReadOnly\(getComputedStyle\(track\)\.transform\)\.m41/.test(gestures)
);

ok(
  '回弹后把接管偏移交回 null（等下一段跟手重新量，不能写死成 0）',
  /reboundWheelSwipe\(timing\) \{\s*this\.clearWheelProgress\(\);/.test(gestures) &&
    /clearWheelProgress\(\) \{[\s\S]*?s\.base = null;/.test(gestures)
);

/* ---------------- 11. 落位动画与邻槽无缝换源 ---------------- */
// 这一组钉住「相邻图片在滑动过程中按手势位移平滑跟随、始终无缝排列」以及
// 「达到切换条件自然落位、取消平滑回弹、全程不闪不跳」的实现前提。静态检查
// 只认结构；真机上有没有掉帧由 README 的 Performance 步骤人工验收。

const landFrom = viewerCode.indexOf('animateTrack(fromX, toX, duration, easing = EASE) {');
const landEnd = landFrom > 0 ? viewerCode.indexOf('rebalance({', landFrom) : -1;
const landBody = landFrom > 0 && landEnd > landFrom
  ? viewerCode.slice(landFrom, landEnd)
  : '';

ok(
  'viewer 轨道落位动画：起点先落地、fill:forwards、finished 里提交终值',
  landBody.length > 0 &&
    /this\.track\.style\.transform = from;/.test(landBody) &&
    /fill: 'forwards'/.test(landBody) &&
    !/fill: 'none'/.test(landBody) &&
    /if \(this\.trackAnim !== anim\) return;[\s\S]{0,220}?this\.track\.style\.transform = to;/.test(landBody),
  '两端都不跳；旧写法是「终点先写 inline + fill:none」，会先闪到终点再弹回'
);

const atFrom = gesturesCode.indexOf('animateTrackTo(swipeX, duration = 260, easing = EASE_OUT) {');
const atEnd = atFrom > 0 ? gesturesCode.indexOf('emit() {', atFrom) : -1;
const atBody = atFrom > 0 && atEnd > atFrom ? gesturesCode.slice(atFrom, atEnd) : '';

ok(
  'gestures 回弹动画同一套提交方式（起点落地 / forwards / finished 提交）',
  atBody.length > 0 &&
    /this\.o\.track\.style\.transform = from;/.test(atBody) &&
    /fill: 'forwards'/.test(atBody) &&
    !/fill: 'none'/.test(atBody) &&
    /if \(this\.anim !== anim\) return;[\s\S]{0,220}?this\.o\.track\.style\.transform = to;/.test(atBody)
);

const wheelLandMs = Number((viewer.match(/const WHEEL_LAND_MS = (\d+);/) || [])[1]);
ok(
  'wheel 落位时长随剩余距离 / 跟手速度收缩，WHEEL_LAND_MS 只是上限（短于键盘 SWITCH_MS）',
  wheelLandMs > 0 &&
    wheelLandMs < switchMs &&
    /const landing = fromWheel \? this\.wheelLandTiming\(dist, velocity\) : null;/.test(viewer) &&
    /const duration = fromWheel\s*\?\s*landing\.duration\s*:\s*fromSwipe/.test(viewer) &&
    /const duration = clamp\(\(2 \* d\) \/ v0, WHEEL_LAND_MIN_MS, WHEEL_LAND_MS\);/.test(viewer),
  `WHEEL_LAND_MS=${wheelLandMs} SWITCH_MS=${switchMs}`
);

ok(
  'fromWheel 收尾不重建手势、不关 enabled，只 retarget 到新当前槽',
  /if \(fromWheel\) \{[\s\S]{0,400}?this\.g\?\.retarget\(this\.currentSlot\);[\s\S]{0,200}?\} else \{\s*this\.attachGestures\(\);/.test(viewer) &&
    /if \(!fromWheel && this\.g\) this\.g\.enabled = true;/.test(viewer)
);

ok(
  '邻槽换源：把预取阶段已 decode 的 <img> 直接换进 DOM（同一帧就有像素）',
  /export function takeDecoded\(src\) \{/.test(api) &&
    /takeDecoded/.test(viewer) &&
    /adoptSlotImage\(slot, key, url, className\) \{[\s\S]*?const ready = takeDecoded\(url\);[\s\S]*?old\.replaceWith\(ready\);/.test(viewer) &&
    /const lowReady = this\.swapSlotImage\(slot, '__low', thumbUrl\(item\.id\), 'slide-low'\);/.test(viewer)
);

ok(
  '换源先确认旧节点仍挂在 DOM，再去池里取（不白白丢掉已解码节点）',
  /adoptSlotImage\(slot, key, url, className\) \{[\s\S]{0,300}?if \(!old\?\.parentNode\) return false;[\s\S]{0,200}?const ready = takeDecoded\(url\);/.test(viewer)
);

ok(
  '预热同时备齐缩略图与原图（fill 画的是缩略图，只预热原图等于预热错资源）',
  /preload\(thumbUrl\(item\.id\), 'high'\);[\s\S]{0,160}?preload\(fullUrl\(item\.id, maxEdgeFor\(item\)\), 'high'\);/.test(viewer)
);

ok(
  '单步换页原语一次量视口：advanceBy 量好传给 rebalance，跳过静止基准写入',
  /const view = this\.view\(\);/.test(advanceBody) &&
    /this\.rebalance\(\{ view, skipTransform: true \}\);/.test(advanceBody) &&
    /rebalance\(\{ view = null, skipTransform = false \} = \{\}\) \{/.test(viewer) &&
    /const v = view \?\? this\.view\(\);/.test(viewer) &&
    /if \(!skipTransform\) \{/.test(viewer)
);

ok(
  'fill 默认参数不带 this.view()（按需才量，空槽不碰布局）',
  /fill\(slot, itemIndex, view = null\) \{/.test(viewer) &&
    /const v = view \?\? this\.view\(\);/.test(viewer)
);

ok(
  '异常增量也压到不足一屏（wheelFollowOffset 渐近上限 cap，不会把视觉位置压到另一侧）',
  /wheelFollowOffset\(x, limit = 0\) \{[\s\S]{0,400}?const cap = Math\.max\(1, \(limit \|\| this\.o\.view\(\)\.w\) - 1\);[\s\S]{0,320}?rubberband\(distance - linear, cap - linear\)/.test(gestures) &&
    /const travelCap = limit \* 2;/.test(gestures) &&
    !/t\.x = Math\.sign\(rest\) \* \(viewW - 1\) - t\.base;/.test(gestures)
);

/* ---------------- 12. 目标图第一帧就位：槽位永不空白 ---------------- */
// 位置由三槽轨道 + 跟手位移保证（第 3 组），这一组只管「那一帧槽里有没有
// 像素」：起手第一帧、切图换槽、反向、首尾阻尼都不能露出背景占位。
// 换源世代号必须**只看 swapSlotImage 自己**：resetSlots 里也有一行同样的自增，
// 拿整份 viewerCode 去匹配会让「摘掉换源世代号」这条回归悄悄漏网（反向验证实测）。
const swapFrom = viewerCode.indexOf('swapSlotImage(slot, key, url, className) {');
const swapBody = swapFrom > 0
  ? viewerCode.slice(swapFrom, viewerCode.indexOf('installSlotImage(', swapFrom))
  : '';

ok(
  'fill 不再原地给底图设新 src（旧写法先抹掉旧像素、再等请求与解码 → 空白帧）',
  /const lowReady = this\.swapSlotImage\(slot, '__low', thumbUrl\(item\.id\), 'slide-low'\);/.test(viewerCode) &&
    !/setSrc\(slot\.__low, lowUrl\)/.test(viewerCode),
  '只保留空槽清空与 retry 两条路径'
);

ok(
  '原子换源：池命中同帧替换；池空且槽里已有像素时旧节点原样留着，解码完再 replaceWith',
  /swapSlotImage\(slot, key, url, className\) \{[\s\S]*?if \(this\.adoptSlotImage\(slot, key, url, className\)\) return Promise\.resolve\(\);[\s\S]*?if \(!old\.naturalWidth\) \{[\s\S]*?return decodedImage\(url\)\.then\(\(img\) => \{[\s\S]*?this\.installSlotImage\(slot, key, old, img, url, className\);/.test(viewerCode) &&
    /installSlotImage\(slot, key, old, img, url, className\) \{[\s\S]*?old\.replaceWith\(img\);[\s\S]*?slot\[key\] = img;/.test(viewerCode)
);

ok(
  '快速连滑的换源有世代号（后发先至的解码不能把已换好的新图覆盖回旧图）',
  swapBody.length > 0 &&
    /const token = \(slot\.__swapGen = \(slot\.__swapGen \|\| 0\) \+ 1\);/.test(swapBody) &&
    /if \(slot\.__swapGen !== token \|\| slot\[key\] !== old \|\| !old\.parentNode\) return;/.test(swapBody)
);

const decodedImageBody = api.slice(
  api.indexOf('export function decodedImage(src) {'),
  api.indexOf('export function preload(')
);
// 「池命中 → 慢路径」之间只允许 `if (ready) return Promise.resolve(ready);`
// 这一条 return：多一条提前返回就会让池空时永远拿不到可绘制节点，重新露白。
const decodedFastPath = decodedImageBody.slice(
  decodedImageBody.indexOf('const ready = takeDecoded(src);'),
  decodedImageBody.indexOf('const img = new Image();')
);
const decodedReturns = decodedFastPath.match(/return\s+[^;\n]+;/g) || [];
ok(
  'decodedImage 先取池里已解码节点，池空则新建独立节点解码完再交付（失败交 null）',
  decodedImageBody.length > 0 &&
    decodedFastPath.length > 0 &&
    decodedReturns.length === 1 &&
    /return Promise\.resolve\(ready\);/.test(decodedReturns[0]) &&
    /const img = new Image\(\);/.test(decodedImageBody) &&
    /img\.decode\(\)\.then\(finish, finish\)/.test(decodedImageBody) &&
    /resolve\(img\.naturalWidth > 0 \? img : null\);/.test(decodedImageBody) &&
    /setTimeout\(finish, DECODE_WAIT_MS\)/.test(decodedImageBody)
);

ok(
  '静止期双向预热「缩略图 + 原图」（跟手画的是缩略图，只预热原图等于预热错资源）',
  /preloadNeighbors\(\) \{[\s\S]*?for \(const offset of \[1, -1\]\)[\s\S]*?preload\(thumbUrl\(item\.id\), 'high'\);[\s\S]*?preload\(fullUrl\(item\.id, maxEdgeFor\(item\)\)\);/.test(viewer)
);

ok(
  '连续推进的预热排在 rebalance 之前，且反方向也备一张（反向第一帧不露白）',
  advanceBody.length > 0 &&
    advanceBody.indexOf('this.prefetchNeighbor(step, PREFETCH_RUN);') > 0 &&
    advanceBody.indexOf('this.prefetchNeighbor(step, PREFETCH_RUN);') <
      advanceBody.indexOf('this.rebalance({ view, skipTransform: true });') &&
    /this\.prefetchNeighbor\(-step, 1\);/.test(advanceBody)
);

ok(
  '越界槽用当前图保底、不清空成背景；关闭时仍由 resetSlots 真清空',
  /const shown = at >= 0 \? at : clamp\(this\.index, 0, this\.items\.length - 1\);/.test(viewerCode) &&
    /const item = this\.items\[shown\] \?\? null;/.test(viewerCode) &&
    /slot\.__shown = shown;/.test(viewerCode) &&
    /resetSlots\(\) \{[\s\S]*?slot\.__swapGen = \(slot\.__swapGen \|\| 0\) \+ 1;[\s\S]*?setSrc\(slot\.__low, ''\);/.test(viewerCode) &&
    !/resetSlots\(\) \{[\s\S]{0,300}?this\.fill\(slot, -1\)/.test(viewerCode)
);

ok(
  '手势开放前等左右两槽像素，与 FLIP 并行且有上限（不拖慢开场、不锁死预览）',
  /const NEIGHBOR_READY_MS = OPEN_MS;/.test(viewer) &&
    /const neighborsReady = withTimeout\(\s*Promise\.all\(\[leftReady, rightReady\]\),\s*NEIGHBOR_READY_MS\s*\);/.test(viewer) &&
    /\.then\(\(\) => neighborsReady\)/.test(viewer) &&
    /if \(openGen !== this\.openGen\) return;/.test(viewer)
);

ok(
  '启动焦点交接跟得上换节点（换源后重新绑定，不会把焦点吊到超时）',
  /function imageReady\(slide, timeout = 4000\) \{[\s\S]*?new MutationObserver\(bind\)[\s\S]*?bind\(\);/.test(viewer) &&
    /function imageLoaded\(img\) \{/.test(viewer)
);

ok(
  '原图仍只走「池命中同帧换入」快速路径（不在滑动中途异步补入造成清晰度跳变）',
  /if \(this\.adoptSlotImage\(slot, '__full', fullSrc, 'slide-full'\)\) \{/.test(viewerCode) &&
    !/decodedImage\(fullSrc\)/.test(viewerCode)
);

/* ---------------- 13. 目标图贴边跟随：起手第一帧就进视口 ---------------- */
// 第 12 组保证「槽里有像素」；这一组保证「那张图贴着对应侧边缘」。
// `object-fit: contain` 居中留白会先于图片进入视口（竖幅照片可到三四百 px），
// 不贴边就是「轨道已经动了、目标图却要滑过小半屏才露面」。

const seamFrom = viewerCode.indexOf('followWheelSeam(swipeX, viewW) {');
const seamBody = seamFrom > 0
  ? viewerCode.slice(seamFrom, viewerCode.indexOf('followWheelEdge(offset) {', seamFrom))
  : '';
const marginFrom = viewerCode.indexOf('seamMargin(slot, width) {');
const marginBody = marginFrom > 0
  ? viewerCode.slice(marginFrom, viewerCode.indexOf('}', marginFrom) + 1)
  : '';
const setSeamFrom = viewerCode.indexOf('setSlotSeam(slot, px) {');
const setSeamBody = setSeamFrom > 0
  ? viewerCode.slice(setSeamFrom, viewerCode.indexOf('clearSlotSeam(slot) {', setSeamFrom))
  : '';
const releaseFrom = viewerCode.indexOf('releaseWheelSeam(rebound, velocity = 0) {');
const releaseBody = releaseFrom > 0
  ? viewerCode.slice(releaseFrom, viewerCode.indexOf('bindSlotPixels(slot) {', releaseFrom))
  : '';

ok(
  '每个跟手事件先让目标图贴边、再写轨道 transform（同一帧落地，不等阈值/结算/动画）',
  /onWheelFollow: \(swipeX, viewW\) => this\.followWheelSeam\(swipeX, viewW\)/.test(viewer) &&
    /onWheelFollow: \(\) => \{\},/.test(gestures) &&
    /this\.o\.onWheelFollow\?\.\(this\.swipeX, viewW\);/.test(gesturesCode)
);

ok(
  '贴边方向由 swipeX 决定，贴边量随进度线性收回（进度 = |swipeX| / 视口宽）',
  seamBody.length > 0 &&
    /const dir = swipeX < 0 \? 1 : -1;/.test(seamBody) &&
    /const progress = clamp\(Math\.abs\(swipeX\) \/ Math\.max\(1, width\), 0, 1\);/.test(seamBody) &&
    /const target = this\.slots\[1 \+ dir\];/.test(seamBody) &&
    /-dir \* this\.seamMargin\(slot, width\) \* \(1 - progress\)/.test(seamBody) &&
    /this\.setSlotSeam\(slot, shift\);/.test(seamBody)
);

ok(
  '留白只从缓存的 __box.w 算，跟手热路径不读布局',
  marginBody.length > 0 &&
    /slot\.__box\?\.w \?\? width/.test(marginBody) &&
    !/clientWidth|getBoundingClientRect|\.view\(\)/.test(marginBody)
);

ok(
  '图片按宽度铺满时留白夹到 0（窄屏不产生反向贴边量）',
  /Math\.max\(0, \(width - \(slot\.__box\?\.w \?\? width\)\) \/ 2\)/.test(marginBody)
);

ok(
  '贴边量同时写到槽里的底图与原图，记录 __seam 供换节点继承；跟手期禁掉缓动',
  setSeamBody.length > 0 &&
    /slot\.__seam = px;/.test(setSeamBody) &&
    /for \(const img of \[slot\.__low, slot\.__full\]\)/.test(setSeamBody) &&
    /img\.style\.transition = 'none';/.test(setSeamBody) &&
    /img\.style\.transform = value;/.test(setSeamBody)
);

ok(
  '换源继承贴边量、换内容与关闭时清空（换源当帧不跳回居中）',
  /this\.paintSlotSeam\(slot, img\);/.test(viewerCode) &&
    /this\.paintSlotSeam\(slot, ready\);/.test(viewerCode) &&
    (viewerCode.match(/this\.clearSlotSeam\(slot\);/g) || []).length >= 2 &&
    /clearSlotSeam\(slot\) \{[\s\S]*?removeProperty\('transform'\)/.test(viewerCode)
);

const reboundBody = (() => {
  const from = viewerCode.indexOf('wheelReboundTiming(dist, velocity) {');
  const to = viewerCode.indexOf('wheelReboundDistance() {', from);
  return from > 0 && to > from ? viewerCode.slice(from, to) : '';
})();
ok(
  '流结束把贴边量与收尾/回弹动画同步归零（补完 wheelLandTiming、取消 wheelReboundTiming）',
  /onWheelSettle: \(rebound, velocity\) => this\.releaseWheelSeam\(rebound, velocity\)/.test(viewer) &&
    /this\.o\.onWheelSettle\?\.\(false, velocity\);/.test(gesturesCode) &&
    /this\.o\.onWheelSettle\?\.\(true, velocity\);/.test(gesturesCode) &&
    releaseBody.length > 0 &&
    /const timing = rebound\s*\?\s*this\.wheelReboundTiming\(this\.wheelReboundDistance\(\), velocity\)\s*:\s*this\.wheelLandTiming\(this\.wheelLandDistance\(\), velocity\);/.test(releaseBody) &&
    /return timing;/.test(releaseBody) &&
    /img\.style\.transition = `transform \$\{duration\}ms \$\{easing\}`;/.test(releaseBody)
);
ok(
  '慢滑回弹：起点速度接回交接速度、高速逐字退回原曲线、补完路径一行不动',
  reboundBody.length > 0 &&
    /const duration = WHEEL_SEAM_REBOUND_MS;/.test(reboundBody) &&
    /const v0 = clamp\(Math\.abs\(velocity\) \|\| 0, WHEEL_REBOUND_MIN_V, WHEEL_LAND_MAX_V\);/.test(reboundBody) &&
    /const vStart = Math\.min\(v0, \(d \/ duration\) \* \(1 \/ WHEEL_LAND_X1\)\);/.test(reboundBody) &&
    /if \(y1 >= 0\.999\) \{[\s\S]{0,160}?WHEEL_SEAM_SOFT_EASE/.test(reboundBody) &&
    /const WHEEL_REBOUND_MIN_V = 0\.08;/.test(viewer) &&
    /wheelReboundDistance\(\) \{[\s\S]{0,200}?this\.g\?\.swipeX/.test(viewerCode) &&
    /const timing = this\.o\.onWheelSettle\?\.\(true, velocity\);/.test(gesturesCode) &&
    /this\.reboundWheelSwipe\(timing\);/.test(gesturesCode) &&
    /const landing = fromWheel \? this\.wheelLandTiming\(dist, velocity\) : null;/.test(viewer) &&
    !/const \{ duration, easing \} = rebound\s*\?\s*\{ duration: WHEEL_SEAM_REBOUND_MS/.test(releaseBody)
);

ok(
  '目标槽先校正内容再贴边：中途掉头后，进视口的仍是目标那张（边界段不走这条路）',
  seamBody.length > 0 &&
    /const wanted = this\.index \+ dir;/.test(seamBody) &&
    /if \(target\.__index !== at \|\| target\.__shown !== shown\) this\.fill\(target, wanted\);/.test(seamBody) &&
    seamBody.indexOf('this.fill(target, wanted)') < seamBody.indexOf('this.bindSlotPixels(target)') &&
    seamBody.indexOf('this.bindSlotPixels(target)') < seamBody.indexOf('this.setSlotSeam(slot, shift)')
);

ok(
  '预热晚于 fill 的已解码节点会被补装进目标槽（底图 + 原图，不必等结算）',
  /bindSlotPixels\(slot\) \{[\s\S]*?this\.adoptSlotImage\(slot, '__low', lowUrl, 'slide-low'\);[\s\S]*?this\.adoptSlotImage\(slot, '__full', fullSrc, 'slide-full'\)/.test(viewerCode)
);

/* ---------------- 14. 落位速度连续：无硬停顿、无慢速爬行 ---------------- */
// 这个检查器只认结构；`ui/probe.html` 17.18 会解析真实缓动曲线量初速 / 尾速，
// `tools/check_wheel_swipe.mjs` 第 27 组钉住「结算把速度交出来、一段只交一次」。
// 旧的固定 180ms + EASE(.22,1,.36,1)：前 13% 时间走完近半程、末 35% 时间只挪
// 约 1%，目标图在接近居中处「先硬停、再以近零速度爬完最后几 px」。

const timingFrom = viewerCode.indexOf('wheelLandTiming(dist, velocity) {');
const timingBody = timingFrom > 0
  ? viewerCode.slice(timingFrom, viewerCode.indexOf('wheelLandDistance() {', timingFrom))
  : '';
const distFrom = viewerCode.indexOf('wheelLandDistance() {');
const distBody = distFrom > 0
  ? viewerCode.slice(distFrom, viewerCode.indexOf('async go(delta,', distFrom))
  : '';

ok(
  '落位纯函数：初速夹在手势节奏区间，时长 = clamp(2·dist/v0, MIN_MS, WHEEL_LAND_MS)',
  timingBody.length > 0 &&
    /const v0 = clamp\(Math\.abs\(velocity\) \|\| 0, WHEEL_LAND_MIN_V, WHEEL_LAND_MAX_V\);/.test(timingBody) &&
    /const d = Math\.max\(1, dist\);/.test(timingBody) &&
    /const duration = clamp\(\(2 \* d\) \/ v0, WHEEL_LAND_MIN_MS, WHEEL_LAND_MS\);/.test(timingBody) &&
    !/clientWidth|getBoundingClientRect|this\.view\(\)/.test(timingBody)
);

ok(
  '缓动起点速度 = 交接初速、终点速度 = 0：y1 = x1·vStart·T/dist，末控制点恒 y=1 且 y1≤1（不过冲）',
  /const vStart = Math\.min\(v0, \(d \/ duration\) \* \(1 \/ WHEEL_LAND_X1\)\);/.test(timingBody) &&
    /const slope = \(vStart \* duration\) \/ d;/.test(timingBody) &&
    /const y1 = WHEEL_LAND_X1 \* slope;/.test(timingBody) &&
    /return \{ duration, easing, velocity: vStart \};/.test(timingBody) &&
    /const easing =\s*`cubic-bezier\(\$\{WHEEL_LAND_X1\.toFixed\(3\)\}, \$\{y1\.toFixed\(3\)\}, `\s*\+\s*`\$\{WHEEL_LAND_X2\.toFixed\(3\)\}, 1\)`;/.test(timingBody)
);

const wheelLandMinMs = Number((viewer.match(/const WHEEL_LAND_MIN_MS = (\d+);/) || [])[1]);
ok(
  '常量齐备：初速上下限 / 两个 x 控制点，时长下限足够短（不把短余数顶成猛起慢尾）',
  wheelLandMinMs > 0 && wheelLandMinMs <= 30 &&
    /const WHEEL_LAND_MIN_V = [\d.]+;/.test(viewer) &&
    /const WHEEL_LAND_MAX_V = [\d.]+;/.test(viewer) &&
    /const WHEEL_LAND_X1 = 1 \/ 3;/.test(viewer) &&
    /const WHEEL_LAND_X2 = 2 \/ 3;/.test(viewer) &&
    wheelLandMs < switchMs,
  `MIN_MS=${wheelLandMinMs} MAX_MS=${wheelLandMs} SWITCH_MS=${switchMs}`
);

ok(
  '贴边归零与轨道落位同源：wheelLandDistance 只读 slotWidth - |swipeX|，不量第二次布局',
  /return Math\.max\(1, this\.slotWidth\(\) - Math\.abs\(this\.g\?\.swipeX \?\? 0\)\);/.test(distBody) &&
    /this\.wheelLandTiming\(this\.wheelLandDistance\(\), velocity\)/.test(releaseBody) &&
    /this\.wheelLandTiming\(dist, velocity\)/.test(viewer)
);

ok(
  '只有 wheel 落位用速度匹配缓动；键盘 / 按钮 / 单指仍用原来的 EASE',
  /await this\.animateTrack\(fromX, toX, duration, landing\?\.easing \?\? EASE\);/.test(viewer) &&
    /const duration = fromWheel\s*\?\s*landing\.duration\s*:\s*fromSwipe\s*\?\s*clamp\(\(SWITCH_MS \* dist\)/.test(viewer)
);

ok(
  '旧「固定 180ms / EASE 快起慢尾」不得回归（wheel 落位不许再写死时长或省掉 easing）',
  !/const duration = fromWheel\s*\?\s*WHEEL_LAND_MS/.test(viewer) &&
    !/await this\.animateTrack\(fromX, toX, duration\);/.test(viewer) &&
    !/const easing = rebound \? WHEEL_SEAM_SOFT_EASE : EASE;/.test(releaseBody)
);

/* ---------------- 15. 原生 wheel 相位：只改结算时机，65ms 仍是兜底 -------- */

const phaseWeb = read('ui/js/wheel-phase.js');
const phaseEntry = read('ui/js/viewer-main.js');
const phaseWebCode = stripComments(phaseWeb);
const phaseRust = read('src-tauri/src/wheel_phase.rs');
const phaseRustCode = stripComments(phaseRust);

ok(
  '原生相位只经 viewer.handleWheelPhase 转发两类语义（不绕开唯一结算路径）',
  /handleWheelPhase\(kind\) \{/.test(viewer) &&
    /if \(kind === 'begin'\) g\.onWheelPhaseBegin\(\);/.test(viewer) &&
    /else if \(kind === 'end'\) g\.onWheelPhaseEnd\(\);/.test(viewer) &&
    /setWheelPhaseSink\(\(kind\) => viewer\.handleWheelPhase\(kind\)\);/.test(phaseEntry) &&
    phaseEntry.indexOf('setWheelPhaseSink') < phaseEntry.indexOf('installWheelPhaseProbe()')
);
ok(
  'wheel-phase.js 只转发 begin / end，不直接切图、不挂 wheel 监听',
  /sink\?\.\(kind\)/.test(phaseWebCode) &&
    /if \(kind !== 'begin' && kind !== 'end'\) return;/.test(phaseWebCode) &&
    !/(go|settleWheelSwipe|clearWheelProgress|onWheelSwipe)\s*\(/.test(phaseWebCode) &&
    !/preventDefault/.test(phaseWebCode) &&
    !/addEventListener\('wheel'/.test(phaseWebCode)
);
ok(
  'Rust 归一化：一次手势恰好一次 begin + 一次 end（两类 ended 不双计）',
  // 归一化已从前端搬到 Rust：这里按 Rust 分支切片，不再数前端的字符窗口。
  /if phase == 1 \{[\s\S]{0,200}?kinds\[0\] = Some\("begin"\)/.test(phaseRustCode) &&
    /let momentum_ended = momentum == 8 \|\| momentum == 16;/.test(phaseRustCode) &&
    /let ended = momentum_ended \|\| \(phase == 8 && !in_momentum\);/.test(phaseRustCode) &&
    /kinds\[1\] = Some\("end"\)/.test(phaseRustCode) &&
    !/p\.phase === 8 \|\| p\.momentum === 8/.test(phaseWebCode)
);
ok(
  '每手势最多 2 帧 IPC：payload 只带 kind，逐帧字段 / JSONL / 统计全部下线',
  /json!\(\{ "kind": \*kind \}\)/.test(phaseRustCode) &&
    /for kind in kinds\.iter\(\)\.flatten\(\)/.test(phaseRustCode) &&
    !/PICSHOW_WHEEL_PHASE_OUT|writeln!|OpenOptions|"wallMs"|"nativeDx"|"skippedTotal"/.test(phaseRustCode) &&
    !/nativeFrames|MAX_SAMPLES|statsOf|countBy/.test(phaseWebCode)
);
ok(
  'Gestures 的两个相位入口都只动结算状态，不写轨道 / 不切图',
  /onWheelPhaseBegin\(\) \{[\s\S]*?this\.clearWheelProgress\(\);\s*\}/.test(gesturesCode) &&
    /onWheelPhaseEnd\(\) \{[\s\S]*?s\.phaseEnded = true;\s*this\.armWheelSettle\(\);\s*\}/.test(gesturesCode) &&
    !/applyTrack\(|onWheelSwipe\?\.\(/.test(
      gesturesCode.slice(
        gesturesCode.indexOf('onWheelPhaseBegin()'),
        gesturesCode.indexOf('settleWheelSwipe(waited')
      )
    )
);
ok(
  '65ms 静默兜底仍在（没有原生相位事件时行为逐字不变）',
  /const WHEEL_GESTURE_END_MS = 65;/.test(gestures) &&
    /if \(sincePrev >= WHEEL_GESTURE_END_MS\)/.test(gesturesCode) &&
    /WHEEL_PHASE_SETTLE_MS\s*:\s*WHEEL_GESTURE_END_MS/.test(gesturesCode)
);
ok(
  'Rust：默认开启、=0 可关、只观察不吞事件、不改窗口几何',
  /==\s*Ok\("0"\)/.test(phaseRustCode) &&
    /observe\(&app, event\);\s*ptr/.test(phaseRustCode) &&
    !/(set_decorations|set_size|set_position|set_fullscreen)\s*\(/.test(phaseRustCode)
);

/* ---------------- 16. 边界阴影叠加层（只加视觉，不动切换/回弹逻辑） -------- */
// 规范点名的「边缘阴影拉长后平滑回弹」是一层**附加视觉**：它不能改索引、
// 不能改结算时机、也不能另算一份回弹曲线。这里把三条边界钉成结构。

const shadeFrom = viewerCode.indexOf('createEdgeShade() {');
const shadeMethods = shadeFrom > 0
  ? viewerCode.slice(shadeFrom, viewerCode.indexOf('wheelLandTiming(dist, velocity) {', shadeFrom))
  : '';
const shadeCssFrom = css.indexOf('.viewer-edge-shade {');
const shadeCss = shadeCssFrom > 0
  ? css.slice(shadeCssFrom, css.indexOf('/* 横向轨道', shadeCssFrom))
  : '';

ok(
  '阴影层：stage 之后 / chrome 之前插入，pointer-events:none，不引入 z-index',
  /this\.edgeShade = this\.createEdgeShade\(\);/.test(viewerCode) &&
    /const chrome = this\.root\.querySelector\('\.viewer-chrome'\);/.test(viewerCode) &&
    /this\.root\.insertBefore\(node, chrome \|\| null\);/.test(viewerCode) &&
    shadeCss.length > 0 &&
    /pointer-events:\s*none;/.test(shadeCss) &&
    /top:\s*var\(--chrome-top\);/.test(shadeCss) &&
    /bottom:\s*var\(--strip-h\);/.test(shadeCss) &&
    !/z-index/.test(shadeCss)
);
ok(
  '阴影取预览背景令牌（深浅主题同源），宽度固定、靠 scaleX 从外侧边拉长',
  /background:\s*linear-gradient\(to left, var\(--viewer-bg\), transparent\);/.test(shadeCss) &&
    /background:\s*linear-gradient\(to right, var\(--viewer-bg\), transparent\);/.test(shadeCss) &&
    /width:\s*36px;/.test(shadeCss) &&
    /transform:\s*scaleX\(0\);/.test(shadeCss) &&
    /transform-origin:\s*right center;/.test(shadeCss) &&
    /transform-origin:\s*left center;/.test(shadeCss) &&
    !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(shadeCss)
);
ok(
  '阴影与弹性量同源同号：距离 → scaleX，符号 → 左/右，跟手期禁缓动',
  shadeMethods.length > 0 &&
    /const strength = clamp\(Math\.abs\(elastic\) \/ WHEEL_EDGE_RUBBER, 0, 1\);/.test(shadeMethods) &&
    /const side = elastic < 0 \? 'right' : 'left';/.test(shadeMethods) &&
    /node\.style\.transform = `scaleX\(/.test(shadeMethods) &&
    /strength\.toFixed\(4\)/.test(shadeMethods) &&
    /node\.style\.opacity = String\(strength \* WHEEL_EDGE_SHADE_ALPHA\);/.test(shadeMethods) &&
    /node\.style\.transition = 'none';/.test(shadeMethods) &&
    /this\.paintEdgeShade\(elastic\);/.test(viewerEdge)
);
ok(
  '阴影回弹与贴边量共用同一个 timing 对象；换内容 / 关闭硬清空',
  /this\.releaseEdgeShade\(timing\);/.test(releaseBody) &&
    /const \{ duration, easing \} = timing;/.test(shadeMethods) &&
    /transform \$\{duration\}ms \$\{easing\}, opacity \$\{duration\}ms \$\{easing\}/.test(shadeMethods) &&
    (viewerCode.match(/this\.clearEdgeShade\(\);/g) || []).length === 2
);
ok(
  '阴影层不碰切换语义：不调 go / settleWheelSwipe / fill / onWheelSwipe',
  shadeMethods.length > 0 &&
    !/onWheelSwipe|settleWheelSwipe|this\.go\(|this\.fill\(/.test(shadeMethods)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}

console.log('\n✓ 触控板横向切换检查全部通过');
