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
 *   3. 一次手势一张：结算后整段锁死，解锁只认「流真的停了」和「反向重推」；
 *   4. 跟手：跟手位移要真的写进 transform，且不能被在跑的动画盖住；
 *   5. 响应：意图一明确就当场结算，剩下的只有 65ms 的「流停」窗口；
 *   6. 只在真正消费时才 preventDefault；
 *   7. 前端与后端接得上（onWheelSwipe / onSwipeIntent 有人注册）。
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

/* ---------------- 2. 一次手势只翻一张 ---------------- */

const switchMs = Number((viewer.match(/const SWITCH_MS = (\d+);/) || [])[1]);
const endMs = num('WHEEL_GESTURE_END_MS');
const revTravel = num('WHEEL_REVERSE_TRAVEL');
const lockMax = num('WHEEL_LOCK_MAX_MS');

ok(
  '结算窗口 ≤ 70ms（再长就是「松手后发木」，上一版 120ms）',
  endMs > 0 && endMs <= 70,
  `WHEEL_GESTURE_END_MS=${endMs}`
);

ok(
  '解锁只认「流真的停了」：静默 ≥ 结算窗口',
  /if \(sincePrev >= WHEEL_GESTURE_END_MS\) return true;/.test(gestures) &&
    /s\.at = now;/.test(gestures)
);

// 「单次增量达到本次峰值某个比例就算重新推了一把」这条出口必须**不存在**：
// 一次持续的个人推力里每帧增量本来都在峰值附近，它会在手指还按着的时候把锁
// 解掉 —— 「滑得远一点就连翻两张」就是这个判据造成的。
ok(
  '解锁判据里没有「单次增量 ≈ 峰值」这条（它会把持续推力误判成重新推）',
  !/WHEEL_RESTART_RATIO|WHEEL_RESTART_MIN_PX|s\.peak(?!V)/.test(gestures) &&
    /if \(s\.rev >= WHEEL_REVERSE_TRAVEL\) return true;/.test(gestures)
);

ok(
  '反向重推按「累积行程」判定，而不是单个事件（抖动攒不出阈值）',
  revTravel > 0 &&
    /s\.rev \+= Math\.abs\(dx\);/.test(gestures) &&
    /if \(s\.rev >= WHEEL_REVERSE_TRAVEL\) return true;/.test(gestures),
  `revTravel=${revTravel}`
);

ok(
  '触发时把累积位移一起清零（否则解锁后旧位移会再越一次阈值）',
  /lockWheelSwipe\(now, direction\) \{[\s\S]*?s\.x = 0;[\s\S]*?s\.rev = 0;/.test(
    gestures
  )
);

ok(
  '锁定期间不看阈值、不落到缩放（直接吞掉）',
  /if \(s\.locked\) \{[\s\S]*?if \(!this\.wheelGestureRestarted\([^)]*\)\) \{\s*event\.preventDefault\(\);\s*return true;/.test(
    gestures
  )
);

ok(
  '锁定有硬上限（异常长的尾巴不能把用户永久锁住）',
  lockMax > 0 &&
    lockMax > endMs &&
    /return now - s\.lockedAt > WHEEL_LOCK_MAX_MS;/.test(gestures),
  `LOCK_MAX=${lockMax}`
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
  '接管的偏移参与跟手位移，但不参与翻页判定（判定仍只看 t.x）',
  /this\.swipeX = this\.wheelFollowOffset\(t\.base \+ t\.x, viewW\)/.test(gestures) &&
    /const far = Math\.abs\(t\.x\) >= viewW \* WHEEL_COMMIT_RATIO;/.test(gestures)
);

ok(
  '翻完一张 / 回弹归位后都要把接管偏移交回 null（否则下一段会多算一截）',
  /s\.base = null;/.test(gestures) &&
    /reboundWheelSwipe\(\) \{[\s\S]*?this\.wheelSwipe\.base = null;/.test(gestures)
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

/* ---------------- 4. 响应：意图一明确就结算 ---------------- */

const commitRatio = num('WHEEL_COMMIT_RATIO');
const fastPx = num('WHEEL_FAST_COMMIT_PX');
const flickV = num('WHEEL_FLICK_VELOCITY');
const exitMin = num('SWITCH_EXIT_MIN_MS', viewer);

ok(
  '拖过半张图当场结算（不等流停）',
  commitRatio > 0 && commitRatio < 1 &&
    /const far = Math\.abs\(t\.x\) >= viewW \* WHEEL_COMMIT_RATIO;/.test(gestures),
  `ratio=${commitRatio}`
);

ok(
  '甩（位移够了且当前速度仍在阈值上）当场结算',
  fastPx > 0 &&
    flickV > 0.45 &&
    /const fast =\s*Math\.abs\(t\.x\) >= WHEEL_FAST_COMMIT_PX && Math\.abs\(t\.vx\) > WHEEL_FLICK_VELOCITY;/.test(
      gestures
    ) &&
    /if \(far \|\| fast/.test(gestures),
  `fastPx=${fastPx} flickV=${flickV}`
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
  '换手势后有明确的重置入口（轴 / 累积 / 锁定一起清）',
  /function freshWheelSwipe\(\) \{[\s\S]*?axis: null,[\s\S]*?locked: false,/.test(
    gestures
  ) &&
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
  'viewer 注册了 onWheelSwipe（否则手势认领了却没人翻页）',
  /onWheelSwipe: \(direction, opts = \{\}\) => \{\s*this\.go\(direction, \{ fromSwipe: true, \.\.\.opts \}\);/.test(
    viewer
  )
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
  /reboundWheelSwipe\(\) \{[\s\S]*?this\.wheelSwipe\.base = null;/.test(gestures)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}

console.log('\n✓ 触控板横向切换检查全部通过');
