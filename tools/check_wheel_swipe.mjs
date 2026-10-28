#!/usr/bin/env node
/**
 * 横向 wheel 切换状态机的最小回归测试（Node 直接跑，不用浏览器）。
 *
 * 为什么单独存在：`ui/probe.html` 那条路要起无头浏览器、跑满两种尺寸，慢且
 * 依赖 Edge；而「一段 wheel 流会不会翻页、会不会连翻、跟不跟手、延迟多少」
 * 本质上是 `handleWheelHorizontal` 的纯时序逻辑 —— 塞进 Node 里用**可控时钟 +
 * 可控定时器**跑最合适，改坏了 1 秒内就能看到。
 *
 * 四条硬性纪律：
 *   1. 一段连续的流最多结算一次（一次手势一张），甩得再远也不连翻；
 *   2. 抬手（静默）之后再滑，必须立刻能再翻 —— 这是「不灵敏」的反面用例；
 *   3. 流还在跑的时候轨道必须实时跟着手指走，且逐事件都对得上（跟手度 100%）；
 *   4. 结算要快：甩是流没停就结算，慢拖是流停后一个 65ms 窗口内结算。
 */

import { Gestures } from '../ui/js/gestures.js';

/* ---------------- 时钟、定时器与 DOM 的最小替身 ---------------- */

let clock = 0;
let seq = 0;
const timers = new Map();

globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };
globalThis.performance = { now: () => clock };
globalThis.clearTimeout = (id) => {
  timers.delete(id);
};
globalThis.setTimeout = (fn, ms) => {
  const id = ++seq;
  timers.set(id, { due: clock + (ms || 0), fn });
  return id;
};

/** 推进虚拟时钟，沿途按顺序触发到点的定时器 */
function advance(ms) {
  const target = clock + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) {
      if (t.due <= target && (!next || t.due < next.due)) next = { id, ...t };
    }
    if (!next) break;
    clock = next.due;
    timers.delete(next.id);
    next.fn();
  }
  clock = target;
}

/**
 * 轨道替身。要点是**能反映「动画中的视觉位置」**：WAAPI 关键帧的优先级高于
 * 内联样式，所以 cancel 掉一个正在跑的动画会让画面瞬间掉回内联值 —— 这正是
 * 「前一段位移丢失」的机制，测试必须能把它造出来。
 *
 *   `visual` = 有动画在跑就取动画的当前插值，否则取内联样式（真实浏览器一致）
 */
function makeTrack() {
  const num = (t) => parseFloat(/translate3d\(\s*(-?[\d.]+)px/.exec(String(t))[1]);
  const track = {
    inline: 0,
    anims: [],
    get visual() {
      const live = this.anims.filter((a) => a.playState === 'running');
      return live.length ? live[live.length - 1].value() : this.inline;
    },
    addEventListener() {},
    removeEventListener() {},
    animate(kf, opts) {
      const from = num(kf.transform[0]);
      const to = num(kf.transform[1]);
      const start = clock;
      const a = {
        playState: 'running',
        finished: Promise.resolve(),
        cancel() {
          this.playState = 'idle';
        },
        value() {
          const k = Math.min(1, Math.max(0, (clock - start) / (opts.duration || 1)));
          return from + (to - from) * k;
        }
      };
      track.anims.push(a);
      setTimeout(() => {
        if (a.playState === 'running') a.playState = 'finished';
      }, opts.duration || 0);
      return a;
    }
  };
  track.style = new Proxy(
    {},
    {
      set(_t, k, v) {
        if (k === 'transform') {
          const m = /translate3d\(\s*(-?[\d.]+)px/.exec(String(v));
          if (m) track.inline = parseFloat(m[1]);
        }
        return true;
      },
      get() {
        return '';
      }
    }
  );
  return track;
}

const noopAnim = () => ({ finished: Promise.resolve(), cancel() {} });

// `trackVisualOffset()` 走的是 computed transform —— 浏览器里由真实 DOM 提供
globalThis.getComputedStyle = (el) => ({
  get transform() {
    return `translate3d(${el.visual}px, 0, 0)`;
  }
});
globalThis.DOMMatrixReadOnly = class {
  constructor(t) {
    const m = /translate3d\(\s*(-?[\d.]+)px/.exec(String(t));
    this.m41 = m ? parseFloat(m[1]) : 0;
  }
};

/** 一次典型的触控板轻甩：起手加速 → 抬手后的惯性尾巴（合计约 285px） */
const flick = (sign = -1) =>
  [4, 9, 16, 24, 30, 34, 32, 28, 24, 20, 16, 13, 10, 8, 6, 4, 3, 2, 1].map(
    (v) => sign * v
  );

function harness({ viewW = 1440, canSwipe = () => true, claim = null } = {}) {
  const fired = [];
  const intents = [];
  let claimCalls = 0;
  const track = makeTrack();
  const g = new Gestures(
    { style: {}, animate: noopAnim },
    {
      track,
      trackBase: () => 0,
      // 模拟 viewer.claimTrack()：把「正在跑的切换动画」就地结束，返回画面
      // 当前停留的偏移。每段手势只该被问一次。
      claimTrack: claim
        ? () => {
            claimCalls += 1;
            return claim(claimCalls);
          }
        : null,
      canSwipe,
      view: () => ({ left: 0, top: 0, w: viewW, h: 800 }),
      onSwipeIntent: (direction) => intents.push({ direction, at: clock }),
      onWheelSwipe: (direction, opts = {}) =>
        fired.push({
          direction,
          at: clock,
          fromSwipe: Boolean(opts?.fromSwipe),
          carried: g.swipeX
        })
    }
  );

  let lastEventAt = 0;
  const push = (dx, dy = 0, gapMs = 16) => {
    advance(gapMs);
    lastEventAt = clock;
    g.handleWheelHorizontal(
      {
        deltaX: dx,
        deltaY: dy,
        ctrlKey: false,
        clientX: 700,
        clientY: 400,
        preventDefault() {}
      },
      dx,
      dy
    );
  };

  return {
    g,
    track,
    fired,
    intents,
    push,
    claimCalls: () => claimCalls,
    /** 推一串横向事件（dx 已归一化：向左为负） */
    stream: (dxs, gapMs = 16) => dxs.forEach((dx) => push(dx, 0, gapMs)),
    /** 静默 ms 毫秒 —— 相当于抬手 */
    idle: (ms) => advance(ms),
    /** 最后一次结算相对**最后一个事件**的时间差：负数 = 流还没停就结算了 */
    latency: () => (fired.length ? fired[fired.length - 1].at - lastEventAt : -1)
  };
}

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.log(`✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

/* ---------------- 1. 跟手：慢拖必须逐事件跟上 ---------------- */
// 慢拖的判据：每个事件的 dx/dt 都不足以算「甩」，于是全程都该 1:1 跟着手走。
{
  const { g, stream, idle, fired } = harness();
  const deltas = [-6, -7, -8, -9, -10, -11, -12];
  let sum = 0;
  let worst = 0;
  for (const dx of deltas) {
    stream([dx], 40); // 40ms 一帧、每帧 6~12px ≈ 0.2px/ms，远低于甩的门槛
    sum += dx;
    if (Math.abs(sum) > 8) worst = Math.max(worst, Math.abs(g.swipeX - sum));
  }
  ok(
    '慢拖时轨道逐事件 1:1 跟手（跟手度 100%，最大误差 < 0.5px）',
    worst < 0.5,
    `最大误差 ${worst.toFixed(2)}px，swipeX=${g.swipeX} 期望 ${sum}`
  );
  ok('慢拖没有中途结算（没到甩的门槛）', fired.length === 0, `触发 ${fired.length} 次`);

  idle(200);
  ok('松手后回弹归位', g.swipeX === 0, String(g.swipeX));
  ok('位移不足不翻页', fired.length === 0, String(fired.length));
}

/* ---------------- 2. 超过一屏只剩阻尼（不会把黑边拖进来） ---------------- */
{
  const { g } = harness({ viewW: 1440 });
  const out = Math.abs(g.wheelFollowOffset(-3000, 1440));
  ok(
    '跟手量被夹在一屏 + 阻尼之内（黑边不会被拖进来）',
    out > 1440 && out < 1440 + 120,
    `${out.toFixed(1)}px`
  );
}

/* ---------------- 3. 一次手势只结算一次 ---------------- */
{
  // 一次「滑得很远」的长流：连推 40 帧再加惯性尾巴，全程没有任何 > 65ms 的静默
  const { fired, stream, idle } = harness();
  stream(new Array(40).fill(-25));
  stream([-22, -19, -16, -13, -10, -8, -6, -4, -3, -2]);
  idle(200);
  ok(
    '一次长距离横滑（推 + 惯性尾巴）只翻一张',
    fired.length === 1,
    `触发 ${fired.length} 次：${JSON.stringify(fired)}`
  );
  ok('方向正确（向左滑 = 下一张）', fired[0]?.direction === 1, String(fired[0]?.direction));
  ok(
    '结算是从当前跟手位置接着播的（fromSwipe + 非零 carry）',
    fired[0]?.fromSwipe === true && Math.abs(fired[0]?.carried ?? 0) > 20,
    `carry=${fired[0]?.carried}`
  );
}

/* ---------------- 4. 甩：流还没停就结算 ---------------- */
{
  const { fired, stream, latency } = harness();
  stream(new Array(6).fill(-40)); // 一帧 40px、16ms → 明显是甩
  ok('甩到门槛就当场结算', fired.length === 1, `触发 ${fired.length} 次`);
  ok(
    '甩是在惯性尾巴还没走完时就结算的（负延迟 = 提前结算，不再等 120ms 静默）',
    latency() < 0,
    `${latency()}ms`
  );
}

/* ---------------- 5. 慢拖：等流停（65ms）才结算，且只等这一个窗口 ---------------- */
{
  const { fired, stream, idle, latency } = harness();
  // 慢拖：每 60ms 走 12px ≈ 0.2px/ms；累计 360px > 22% × 1440 = 316.8
  for (let i = 0; i < 30; i += 1) stream([-12], 60);
  ok('慢拖期间不结算', fired.length === 0, `触发 ${fired.length} 次`);
  idle(80);
  ok('流停了就结算', fired.length === 1, `触发 ${fired.length} 次`);
  ok(
    '结算窗口 = 65ms（上一版 120ms，白等两帧还有余）',
    latency() >= 60 && latency() <= 70,
    `窗口 ${latency()}ms`
  );
}

/* ---------------- 6. 抬手后再滑必须立刻还能翻 ---------------- */
// 上一版的回归点：那时「锁满 380ms + 静默 180ms」的双条件会把第二段流整个吞掉，
// 表现就是「不灵敏 / 第二次滑没反应」。
{
  const { fired, stream, idle } = harness();
  stream(flick(-1));
  idle(200);
  ok('第一下翻一张', fired.length === 1, String(fired.length));

  stream(flick(-1));
  idle(200);
  ok(
    '抬手后再滑：立刻还能翻（不会被上一段的锁吞掉）',
    fired.length === 2,
    `共 ${fired.length} 次`
  );

  stream(flick(-1));
  idle(200);
  ok('连着第三下同样响应', fired.length === 3, `共 ${fired.length} 次`);
}

/* ---------------- 7. 轻微位移 + 低速：回弹、不翻页 ---------------- */
{
  const { g, fired, stream, idle } = harness();
  stream([-5, -6, -4], 50);
  idle(200);
  ok('轻微位移 + 低速不翻页', fired.length === 0, String(fired.length));
  ok('没达标的这一段把轨道带回 0', g.swipeX === 0, String(g.swipeX));
}

/* ---------------- 8. 快速轻甩：靠速度也要能翻 ---------------- */
{
  const { fired, stream, idle } = harness();
  stream([-30, -34, -30]); // 累计不到一屏的 22%，但每 16ms 走 30+px
  idle(200);
  ok('快速轻甩靠速度门槛也能翻页', fired.length === 1, String(fired.length));
}

/* ---------------- 9. 推出去整一屏当场结算；同一段里掉头只再给一张 ---------------- */
{
  const { fired, stream, idle } = harness();
  stream(new Array(10).fill(-150));
  const afterCommit = fired.length;
  ok('推出去很远就当场结算', afterCommit === 1, `触发 ${afterCommit} 次`);

  // 同一段（全程没有 > 65ms 的静默）里掉头，并且一路推了 800px
  stream(new Array(20).fill(40));
  ok(
    '没抬手直接掉头：允许再翻一张',
    fired.length === afterCommit + 1,
    `新增 ${fired.length - afterCommit} 次`
  );
  ok(
    '掉头的方向是反的',
    fired[fired.length - 1]?.direction === -1,
    String(fired[fired.length - 1]?.direction)
  );

  // 紧跟着继续同向推（仍然没有静默，属于同一段）：不许再翻
  const afterTurn = fired.length;
  stream(new Array(8).fill(40));
  ok(
    '掉头之后继续同向推，不会连翻',
    fired.length === afterTurn,
    `新增 ${fired.length - afterTurn} 次`
  );
  idle(200);
}

/* ---------------- 10. 只有一张图时既不跟手也不结算 ---------------- */
{
  const { g, fired, intents, stream, idle } = harness({ canSwipe: () => false });
  stream(flick(-1));
  idle(200);
  ok('单图时横向不跟手', g.swipeX === 0, String(g.swipeX));
  ok('单图时横向不结算', fired.length === 0, String(fired.length));
  ok('单图时不去预取邻图', intents.length === 0, String(intents.length));
}

/* ---------------- 11. 纵向主导的一整串都不许翻页 ---------------- */
{
  const { fired, push, stream, idle } = harness();
  push(10, 60); // 起手就是纵向
  stream([-60, -80]);
  idle(200);
  ok('起手判给纵向之后，后面这一串横向不再翻页', fired.length === 0, String(fired.length));
}

/* ---------------- 12. 轴向判定不被起手噪声带偏（「第一次滑不动」的真因） ---------------- */
// 旧实现拿**第一个事件**定轴向：dx=3 / dy=4 时 `|dx| > 1.7·|dy|` 不成立，于是
// `else if (dy !== 0)` 把它钉成纵向 —— 整段横滑被当成缩放丢掉，用户必须再滑一次。
{
  const { fired, push, stream, idle } = harness();
  push(3, 4); // 起手噪声：纵向略大
  push(4, 3);
  stream([-20, -30, -40]); // 真正的横向推力
  idle(200);
  ok(
    '起手噪声（dx=3/dy=4）不会把整段横滑误判成缩放',
    fired.length === 1 && fired[0].direction === 1,
    `触发 ${fired.length} 次 ${JSON.stringify(fired)}`
  );
}

/* ---------------- 13. 预取意图：方向一确定就通知上层 ---------------- */
{
  const { intents, stream } = harness();
  stream([-10, -12, -14], 40);
  ok('跟手开始就通知目标方向（提前取/解码邻图）', intents.length === 1, String(intents.length));
  ok(
    '方向与手势一致（向左 → 下一张 = +1）',
    intents[0]?.direction === 1,
    String(intents[0]?.direction)
  );
}

/* ---------------- 14. 接管正在跑的切换动画（连续切换后不跟手的真因） ---------------- */
// 连续快切时用户几乎总在上一次的收尾动画里再次起手。那段动画跑在 track 上
// （WAAPI），关键帧优先级高于内联样式：不接管的话，这一整段跟手位移都被盖住，
// 要等动画播完才突然生效 —— 观感正是「连续切几张之后，再滑不动、要等一下」。
{
  const { g, fired, stream, idle, claimCalls } = harness({
    // 画面停在两张图中间：相对中间槽基准已经偏出去 620px
    claim: (n) => (n === 1 ? -620 : 0)
  });

  stream([-3, -4]); // 累计 -7，还在死区里
  ok('死区里不去接管动画（还没真正开始跟手）', claimCalls() === 0, `调用 ${claimCalls()} 次`);

  stream([-10]);
  ok('越过死区就接管一次', claimCalls() === 1, `调用 ${claimCalls()} 次`);
  ok(
    '接管那一帧的跟手量 = 接管偏移 + 本段位移（视觉不跳、也不丢位移）',
    Math.abs(g.swipeX - (-620 - 17)) < 0.5,
    `swipeX=${g.swipeX} 期望 -637`
  );
  ok(
    '接管偏移不参与翻页判定（只推了 17px，不能因为「画面在中间」就结算）',
    fired.length === 0,
    `触发 ${fired.length} 次`
  );

  stream(new Array(4).fill(-40));
  ok('接管之后继续推，照常结算', fired.length === 1, `触发 ${fired.length} 次`);
  ok(
    '结算的 carry 里含着接管偏移（收尾才能从当前位置接着播）',
    (fired[0]?.carried ?? 0) < -600,
    `carry=${fired[0]?.carried}`
  );
  ok(
    '翻页之后接管偏移作废（下一段重新接管）',
    g.wheelSwipe.base === null,
    String(g.wheelSwipe.base)
  );

  idle(200);
}

/* ---------------- 15. 接管后没达标：回弹到位，偏移作废 ---------------- */
{
  const { g, fired, stream, idle } = harness({ claim: () => -300 });
  stream([-20, -20], 60);
  ok('接管 + 小幅慢速位移不结算', fired.length === 0, String(fired.length));
  idle(200);
  ok('回弹到基准（这一格算切完）', g.swipeX === 0, String(g.swipeX));
  // 回弹的**终点**是 0，但被打断时画面并不在 0 —— 交回 null，让下一段跟手去
  // 读实际位置（写成 0 会把没走完的那段位移整段丢掉，见第 19 组）
  ok('回弹后接管偏移交回 null（等下一段重新量）', g.wheelSwipe.base === null, String(g.wheelSwipe.base));
}

/* ---------------- 16. 每次起手最多接管一次（不能每帧都去要） ---------------- */
{
  let calls = 0;
  const { stream } = harness({
    claim: () => {
      calls += 1;
      return -100;
    }
  });
  stream(new Array(10).fill(-12), 40);
  ok('一段手势只接管一次', calls === 1, `${calls} 次`);
}

/* ---------------- 17. 抬手 100ms 后再滑：必须重新接管 ---------------- */
// 65~600ms 这段窗口是「抬手之后马上又滑」的常态。以前只把 >600ms 当作换手势，
// 中间那段会带着上一段的 `base` 继续算 —— 于是第二段**不会**去接管新动画，
// 跟手整整错开一屏，观感就是「连续切几张之后就不跟手」。
{
  let pending = -400;
  const { g, stream, idle, claimCalls } = harness({
    claim: () => {
      const v = pending;
      pending = -500;
      return v;
    }
  });

  stream([-20], 40);
  ok('第一段接管动画', claimCalls() === 1, `${claimCalls()} 次`);
  idle(100); // 抬手，但远不到「换手势」的 600ms
  stream([-20], 40);
  ok('抬手 100ms 后再滑：重新接管一次', claimCalls() === 2, `${claimCalls()} 次`);
  ok(
    '第二段用的是新的接管偏移（不是上一段残留的 0）',
    Math.abs(g.swipeX - (-500 - 20)) < 0.5,
    `swipeX=${g.swipeX} 期望 -520`
  );
  idle(200);
}

/* ---------------- 18. 峰值速度不跨段残留 ---------------- */
// 上一段的「快甩」峰值若留到下一段，慢慢拖 30px 也会被判成甩 —— 一碰就翻。
{
  const { fired, stream, idle } = harness();
  stream([-60, -60], 16); // 快：peakV ≈ 1.5，当帧结算
  ok('快甩先翻一张', fired.length === 1, String(fired.length));
  idle(200);

  stream([-30], 60); // 慢：0.2px/ms，只是越过 28px 的门槛
  idle(200);
  ok(
    '慢拖不会被上一段的峰值速度判成甩',
    fired.length === 1,
    `又多了 ${fired.length - 1} 次`
  );
}

/* ---------------- 19. 回弹被打断：必须接住回弹中途的那一截 ---------------- */
// 没达标的那一段会回弹（200ms）。回弹是 WAAPI 关键帧，优先级高于内联样式：
// 直接 cancel 会让视觉瞬间掉回内联值（= 0 偏移）。以前 base 在回弹开始就被
// 写成 0，于是「回弹还没播完就再滑一次」时，那段没走完的位移会被整段丢掉、
// 画面往回跳一下 —— 用户口中的「前一段位移丢失、不跟手」。
{
  const { g, track, fired, stream, idle, push } = harness(); // 没有 claimTrack：这一段没有切换动画
  // 60ms 一帧、每帧 12px ≈ 0.2px/ms：远低于「慢拖松手」的 0.45，必然不达标
  stream([-12, -12, -12], 60);
  idle(80); // 结算定时器 65ms 到点 → 回弹开始（200ms，从 -36 回到 0）
  ok(
    '回弹进行中（画面还没回到 0）',
    track.visual < -1 && fired.length === 0,
    `visual=${track.visual.toFixed(1)} fired=${fired.length}`
  );

  idle(40);                    // 回弹走到一半
  const mid = track.visual;    // 打断前画面所在的位置
  push(-20, 0, 0);             // 回弹没播完就再滑（0ms：同一时刻，便于比对）
  ok(
    '打断回弹后从画面实际所在的位置接着跟手（不往回跳）',
    Math.abs(g.swipeX - (mid - 20)) < 1,
    `swipeX=${g.swipeX.toFixed(1)} 期望 ${(mid - 20).toFixed(1)}`
  );
  ok(
    '接管偏移 = 回弹中途的位置（不是写死的 0）',
    Math.abs(g.wheelSwipe.base - mid) < 1,
    `base=${g.wheelSwipe.base} 期望 ${mid.toFixed(1)}`
  );
  ok('打断回弹本身不会误翻页', fired.length === 0, `触发 ${fired.length} 次`);
  idle(300);
}

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 横向 wheel 跟手 / 一次一张 / 结算延迟 检查全部通过');
