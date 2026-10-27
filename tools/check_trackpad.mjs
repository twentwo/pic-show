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
 *   3. 一次手势一张：冷却必须盖过切换动画，否则惯性尾巴会连翻；
 *   4. 只在真正消费时才 preventDefault；
 *   5. 前端与后端接得上（onWheelSwipe 有人注册）。
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

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

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

const num = (name) =>
  Number((gestures.match(new RegExp(`const ${name} = ([\\d.]+);`)) || [])[1]);
const switchMs = Number((viewer.match(/const SWITCH_MS = (\d+);/) || [])[1]);
const lockMs = num('WHEEL_SWITCH_LOCK_MS');
const tailGap = num('WHEEL_TAIL_GAP_MS');
const restartRatio = num('WHEEL_RESTART_RATIO');

ok(
  '锁定时长 ≥ 切换动画时长（动画没走完不许再翻一张）',
  lockMs > 0 && switchMs > 0 && lockMs >= switchMs,
  `LOCK_MS=${lockMs} SWITCH_MS=${switchMs}`
);

ok(
  '解锁条件是「尾巴停息」而不是固定倒计时（静默窗口存在且 > 0）',
  tailGap > 0 && /if \(sincePrev >= WHEEL_TAIL_GAP_MS\) return true;/.test(gestures),
  `TAIL_GAP=${tailGap}`
);

ok(
  '「重新发力」用峰值比例判定（鼠标滚轮靠这条做到一格一张）',
  restartRatio > 0 &&
    /return mag >= s\.peak \* WHEEL_RESTART_RATIO;/.test(gestures),
  `ratio=${restartRatio}`
);

ok(
  '锁定期间不看阈值、不落到缩放（直接吞掉）',
  /if \(s\.locked\) \{[\s\S]*?if \(!this\.wheelTailOver\([^)]*\)\) \{\s*event\.preventDefault\(\);\s*return true;/.test(
    gestures
  )
);

ok(
  '先落锁再通知翻页（不是等回调回来才补保险）',
  /this\.lockWheelSwipe\(now, direction\);\s*if \(canFire\) this\.o\.onWheelSwipe\?\.\(direction\);/.test(
    gestures
  )
);

ok(
  '锁定有硬上限（异常长的尾巴不能把用户永久锁住）',
  num('WHEEL_LOCK_MAX_MS') > lockMs &&
    /if \(now - s\.lockedAt > WHEEL_LOCK_MAX_MS\) return true;/.test(gestures)
);

ok(
  '横向判定排在 enabled 闸门之前（切换动画那 300ms 也要记账）',
  (() => {
    const call = gestures.indexOf('this.handleWheelHorizontal(event, dx, dy, this.enabled)');
    const gate = gestures.indexOf('if (!this.enabled) return;', call);
    return call > 0 && gate > call;
  })()
);

/* ---------------- 3. 轴向归属：一次序列只认一种 ---------------- */

ok(
  '轴向在整串 wheel 序列里只判定一次（后续不再翻案）',
  /if \(s\.axis === null\) \{[\s\S]*?if \(s\.axis !== 'x'\) return false;/.test(gestures)
);

ok(
  '横向占比阈值存在且大于 1（斜向不算横滑）',
  (() => {
    const ratio = Number(
      (gestures.match(/const WHEEL_AXIS_RATIO = ([\d.]+);/) || [])[1]
    );
    return ratio > 1;
  })()
);

ok(
  '换手势后有明确的重置入口（轴 / 累积 / 锁定一起清）',
  /function freshWheelSwipe\(\) \{[\s\S]*?axis: null,[\s\S]*?locked: false,/.test(
    gestures
  ) &&
    /resetWheelSwipe\(\) \{\s*this\.wheelSwipe = freshWheelSwipe\(\);/.test(gestures) &&
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

/* ---------------- 4. 只在真正消费时 preventDefault ---------------- */

ok(
  'onWheel 里 preventDefault 排在横向判定之后（观察阶段不阻断默认行为）',
  /if \(this\.handleWheelHorizontal\(event, dx, dy, this\.enabled\)\) return;[\s\S]*?event\.preventDefault\(\);/.test(
    gestures
  ) &&
    !/onWheel\(event\) \{\s*if \(!this\.enabled\) return;\s*event\.preventDefault\(\);/.test(
      gestures
    )
);

/* ---------------- 4.5 方向必须与单指横滑一致 ---------------- */

// 单指横滑的写法是 `dx < 0 ? 1 : -1`（手指向左拖 → 下一张）。wheel 路径的
// 累积量同样是屏幕坐标系下的手势位移（向左为负），所以必须取负号才一致 ——
// 漏掉这个负号就是「触控板左右反了」。
ok(
  'wheel 的方向换算带负号（与单指横滑 dx < 0 → 下一张 一致）',
  /const direction = -Math\.sign\(t\.x\);/.test(gestures) &&
    /const direction = dx < 0 \? 1 : -1;/.test(gestures)
);

ok(
  '放大态横向平移时内容跟手（rawX 与手势位移同号）',
  /panByWheelX\(dx\) \{[\s\S]*?this\.rawX \+= dx;/.test(gestures)
);

/* ---------------- 5. 冲突规避必须在位 ---------------- */

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

/* ---------------- 6. 前后端接得上 ---------------- */

ok(
  'viewer 注册了 onWheelSwipe（否则手势认领了却没人翻页）',
  /onWheelSwipe: \(direction\) => \{[\s\S]*?this\.go\(direction\);/.test(viewer)
);

ok(
  'gestures 通过回调名调用它（ this.o.onWheelSwipe ）',
  /this\.o\.onWheelSwipe\?\.\(direction\);/.test(gestures)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}

console.log('\n✓ 触控板横向切换检查全部通过');
