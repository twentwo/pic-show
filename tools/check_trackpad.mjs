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
 *   3. 连续滚动流：不再有「一段流只翻一张」的锁；每跨过一整屏就同步换一张，
 *      换页不播收尾动画、不重建手势、不设闸门；
 *   4. 跟手：跟手位移要真的写进 transform，且不能被在跑的动画盖住；
 *   5. 响应：流中间不插结算，只有流停下来（统一 65ms 窗口）时吸附一次；
 *   6. 只在真正消费时才 preventDefault；
 *   7. 前端与后端接得上（onWheelAdvance / onWheelSwipe / onWheelRest /
 *      onSwipeIntent 都有人注册），且旧锁定写法不得回归；
 *   8. 落位 / 回弹：WAAPI 动画**起点**先落地、fill:'forwards'、终值在 finished
 *      里提交（不闪到终点、不闪回起点）；wheel 流结束吸附走不重建手势、不落闸、
 *      固定 WHEEL_LAND_MS 的轻量路径；连续推进一次量视口、跳过静止位写入。
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

/* ---------------- 2. 连续滚动流：不再有「一次手势一张」的锁 ---------------- */

const switchMs = Number((viewer.match(/const SWITCH_MS = (\d+);/) || [])[1]);
const endMs = num('WHEEL_GESTURE_END_MS');
const advanceMax = num('WHEEL_ADVANCE_MAX');
const advanceFrom = viewerCode.indexOf('advanceBy(direction) {');
const advanceBody = advanceFrom > 0
  ? viewerCode.slice(advanceFrom, viewerCode.indexOf('return true;', advanceFrom))
  : '';

ok(
  '结算窗口 ≤ 70ms（再长就是「松手后发木」，上一版 120ms）',
  endMs > 0 && endMs <= 70,
  `WHEEL_GESTURE_END_MS=${endMs}`
);

ok(
  '静默 ≥ 结算窗口就清掉本段进度（结算与「新的一段」共用同一个刻度）',
  /if \(sincePrev >= WHEEL_GESTURE_END_MS\) this\.clearWheelProgress\(\);/.test(gestures) &&
    /s\.at = now;/.test(gestures)
);

// 旧的锁定状态机一旦回归，「连续跨多张」立刻失效：翻过一张之后惯性尾巴会被
// 整段吞掉、画面停住 —— 这正是本次要根治的症状。只看代码，注释里提到这些
// 名字是为了解释历史根因。
ok(
  '旧锁定写法不得回归（locked / 解锁三出口 / 反向行程 / 锁定硬上限）',
  !/s\.locked|s\.lockedAt|s\.rev|wheelGestureRestarted|trackWheelReverse|lockWheelSwipe/.test(gesturesCode) &&
    !/WHEEL_REVERSE_TRAVEL|WHEEL_LOCK_MAX_MS|WHEEL_COMMIT_RATIO|WHEEL_RESTART_RATIO|WHEEL_RESTART_MIN_PX|WHEEL_FAST_COMMIT_PX|WHEEL_FLICK_VELOCITY/.test(gesturesCode)
);

ok(
  '跨过整屏走 onWheelAdvance 同步换页，剩余位移扣掉一屏继续跟手',
  /while \(Math\.abs\(t\.base \+ t\.x\) >= viewW && steps < WHEEL_ADVANCE_MAX\)/.test(gestures) &&
    /if \(!this\.o\.onWheelAdvance\?\.\(direction\)\)/.test(gestures) &&
    /t\.x = shown \+ direction \* viewW;\s*t\.base = 0;/.test(gestures)
);

ok(
  '一次事件连续推进有上限（异常增量不能把整个图库跳完）',
  advanceMax > 0 && advanceMax <= 12,
  `WHEEL_ADVANCE_MAX=${advanceMax}`
);

ok(
  '到首尾时累计夹到一小段阻尼（不无限堆、不露整屏空槽，反向立刻响应）',
  /t\.x = Math\.sign\(shown\) \* WHEEL_OVERSCROLL_RUBBER - t\.base;\s*break;/.test(gestures)
);

ok(
  '结算完只清本段进度、不落锁（下一段流照常重新累计）',
  /clearWheelProgress\(\) \{[\s\S]*?s\.x = 0;[\s\S]*?s\.base = null;[\s\S]*?s\.peakV = 0;/.test(gestures) &&
    /this\.clearWheelProgress\(\);\s*this\.o\.onWheelSwipe\?\.\(direction, \{ fromSwipe: true \}\);/.test(gestures)
);

ok(
  'viewer 用 advanceBy 同步换页：不播收尾动画、不重建手势、不设闸门',
  /onWheelAdvance: \(direction\) => this\.advanceBy\(direction\)/.test(viewer) &&
    advanceBody.length > 0 &&
    /this\.switching = false;/.test(advanceBody) &&
    /this\.rebalance\(\{ view, skipTransform: true \}\);/.test(advanceBody) &&
    !/attachGestures|animateTrack\(|this\.switching = true/.test(advanceBody)
);

ok(
  '连续换页只把变换目标 retarget 到新当前槽（事件仍挂在 track 上）',
  /retarget\(el\) \{[\s\S]*?this\.el = el;/.test(gestures) &&
    /this\.g\?\.retarget\(this\.currentSlot\);/.test(viewer)
);

ok(
  '连续推进期间不拉当前项原图，流结束由 onWheelRest 补给（结算帧不撞解码）',
  /onWheelRest: \(\) => \{[\s\S]*?this\.startFullLoad\(\);[\s\S]*?this\.preloadNeighbors\(\);/.test(viewer) &&
    advanceBody.length > 0 &&
    !/startFullLoad\(\)/.test(advanceBody)
);

ok(
  '沿滑动方向多张预热（prefetchNeighbor 默认 PREFETCH_RUN，advanceBy 显式传）',
  /prefetchNeighbor\(direction, count = PREFETCH_RUN\) \{[\s\S]*?n <= count/.test(viewer) &&
    /this\.prefetchNeighbor\(step, PREFETCH_RUN\);/.test(viewer)
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
  '跟手位移每个事件都写进轨道 transform（不是只在结算时跳一下）',
  /this\.swipeX = this\.wheelFollowOffset\(t\.base \+ t\.x, viewW\);\s*this\.applyTrack\(\);/.test(gestures)
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
  '接管的偏移参与跟手显示，但吸附判据只看余数 swipeX',
  /this\.swipeX = this\.wheelFollowOffset\(t\.base \+ t\.x, viewW\)/.test(gestures) &&
    /const dx = this\.swipeX;/.test(gestures) &&
    /const far = Math\.abs\(dx\) > width \* SWIPE_DISTANCE_RATIO;/.test(gestures)
);

ok(
  '结算 / 回弹都把接管偏移交回 null（否则下一段会多算一截）',
  /s\.base = null;/.test(gestures) &&
    /reboundWheelSwipe\(\) \{\s*this\.clearWheelProgress\(\);/.test(gestures) &&
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
  '结算定时器统一用 WHEEL_GESTURE_END_MS（结算与「新的一段」同刻度）',
  /\}, WHEEL_GESTURE_END_MS\);/.test(gestures) &&
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
  /function freshWheelSwipe\(\) \{[\s\S]*?axis: null,[\s\S]*?peakV: 0\s*\};/.test(
    gestures
  ) &&
    !/locked:|lockedAt:|rev:|dir:/.test(gesturesCode) &&
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
  'viewer 注册了 onWheelSwipe（流结束吸附走 fromWheel 轻量收尾）',
  /onWheelSwipe: \(direction, opts = \{\}\) => \{\s*this\.go\(direction, \{ fromSwipe: true, fromWheel: true, \.\.\.opts \}\);/.test(
    viewer
  ) && /async go\(delta, \{ fromSwipe = false, fromWheel = false \} = \{\}\)/.test(viewer)
);

ok(
  'gestures 结算时带上 fromSwipe（收尾要从手指当前位置接着播）',
  /this\.o\.onWheelSwipe\?\.\(direction, \{ fromSwipe: true \}\);/.test(gestures)
);

ok(
  '方向一确定就预取目标邻图（onSwipeIntent → prefetchNeighbor）',
  /onSwipeIntent: \(direction\) => this\.prefetchNeighbor\(direction\)/.test(viewer) &&
    /this\.o\.onSwipeIntent\?\.\(t\.x < 0 \? 1 : -1\);/.test(gestures)
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
  /reboundWheelSwipe\(\) \{\s*this\.clearWheelProgress\(\);/.test(gestures) &&
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
  'wheel 流结束吸附固定用 WHEEL_LAND_MS（短于键盘 SWITCH_MS，去掉松手顿挫）',
  wheelLandMs > 0 &&
    wheelLandMs < switchMs &&
    /const duration = fromWheel\s*\?\s*WHEEL_LAND_MS\s*:\s*fromSwipe/.test(viewer),
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
    /if \(!this\.adoptSlotImage\(slot, '__low', lowUrl, 'slide-low'\)\) \{/.test(viewer)
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
  '连续推进一次量视口：advanceBy 量好传给 rebalance，跳过静止基准写入',
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
  '异常增量夹到不足一屏（wheelFollowOffset 不会把视觉位置压到另一侧）',
  /const rest = t\.base \+ t\.x;[\s\S]{0,200}?if \(Math\.abs\(rest\) >= viewW\) \{[\s\S]{0,160}?viewW - 1/.test(gestures)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}

console.log('\n✓ 触控板横向切换检查全部通过');
