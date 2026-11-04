#!/usr/bin/env node
/**
 * 横向 wheel **连续滚动流**的最小回归测试（Node 直接跑，不用浏览器）。
 *
 * 为什么单独存在：`ui/probe.html` 那条路要起无头浏览器、跑满两种尺寸，慢且
 * 依赖 Edge；而「一段 wheel 流会跨几张、跟不跟手、什么时候吸附、延迟会不会
 * 累积」本质上是 `handleWheelHorizontal` 的纯时序逻辑 —— 塞进 Node 里用
 * **可控时钟 + 可控定时器**跑最合适，改坏了 1 秒内就能看到。
 *
 * 四条硬性纪律（连续语义，与旧版「一次手势一张」不同）：
 *   1. 累计位移连续映射：每跨过一整屏就同步换一张，甩得越远换得越多；
 *   2. 一段流只在**真正停下来**时吸附一次（补完最后一张或回弹），流中间
 *      不插收尾动画 —— 这是「延迟累积」的根治点；
 *   3. 流还在跑的时候轨道必须实时跟着手指走，且逐事件都对得上（跟手度 100%）；
 *   4. 结算窗口统一 65ms；首尾有阻尼、异常增量有上限、接管/回弹不丢位移。
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

/**
 * @param {object} opts
 * @param {number} [opts.viewW] 视口宽（= 一屏 = 换一张所需的累计位移）
 * @param {(direction:number)=>boolean} [opts.canSwipe] 该方向还有没有图
 * @param {(n:number)=>number|null} [opts.claim] 模拟 viewer.claimTrack()
 * @param {(direction:number, done:number)=>boolean} [opts.advance] 模拟连续换页，
 *   返回 false = 到首尾（默认永远可换，图库无限）
 */
function harness({ viewW = 1440, canSwipe = () => true, claim = null, advance: canAdvance = null } = {}) {
  const fired = [];
  const intents = [];
  const advances = [];
  const rests = [];
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
      // 连续推进：跨过一整屏就同步换一张。真实 viewer 在这里只轮转三槽、
      // 不播动画也不重建手势，所以替身只记录、不动轨道。
      onWheelAdvance: (direction) => {
        const allowed = canAdvance ? canAdvance(direction, advances.length) : true;
        if (allowed) advances.push({ direction, at: clock });
        return allowed;
      },
      onSwipeIntent: (direction) => intents.push({ direction, at: clock }),
      // 流结束吸附：viewer 在这里走 go(fromWheel)（不重建手势、固定短收尾）。
      // 替身记录后把轨道归位，模拟那次收尾动画落地，下一段流才能从 0 起手。
      onWheelSwipe: (direction, opts = {}) => {
        fired.push({
          direction,
          at: clock,
          fromSwipe: Boolean(opts?.fromSwipe),
          carried: g.swipeX
        });
        g.swipeX = 0;
        track.inline = 0;
      },
      onWheelRest: () => rests.push({ at: clock })
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
    advances,
    rests,
    push,
    claimCalls: () => claimCalls,
    /** 推一串横向事件（dx 已归一化：向左为负） */
    stream: (dxs, gapMs = 16) => dxs.forEach((dx) => push(dx, 0, gapMs)),
    /** 静默 ms 毫秒 —— 相当于抬手 */
    idle: (ms) => advance(ms),
    /** 最后一次**吸附**相对最后一个事件的时间差 */
    latency: () => (fired.length ? fired[fired.length - 1].at - lastEventAt : -1),
    /** 最后一次**连续推进**相对最后一个事件的时间差（≤0 = 当帧推进） */
    advanceLatency: () =>
      advances.length ? advances[advances.length - 1].at - lastEventAt : -1
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
  const { g, stream, idle, fired, advances } = harness();
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
  ok('慢拖没有中途结算，也没有跨屏推进', fired.length === 0 && advances.length === 0,
    `结算 ${fired.length} 次 / 推进 ${advances.length} 张`);

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

/* ---------------- 3. 连续跨多张：跨过的张数与行程成比例 ---------------- */
// 旧契约在这里是「推得再远也只翻一张」；现在一屏 = 一张，惯性尾巴一路把
// 画面推过去，跨过的张数由**总行程**决定，而不是由一次结算决定。
{
  const { fired, advances, stream, idle, rests } = harness({ viewW: 1000 });
  stream(new Array(50).fill(-100)); // 5000px / 1000 = 5 张
  ok(
    '一次长距离横滑连续推进 5 张（不再只翻一张）',
    advances.length === 5,
    `推进 ${advances.length} 张：${JSON.stringify(advances)}`
  );
  ok('方向正确（向左滑 = 下一张）', advances.every((a) => a.direction === 1),
    JSON.stringify(advances.map((a) => a.direction)));
  ok('流还在跑时不插入任何吸附收尾', fired.length === 0, `结算 ${fired.length} 次`);
  idle(200);
  ok('流停了才做一次结算通知（不是每翻一张一次）', rests.length === 1,
    `通知 ${rests.length} 次`);
  ok('余数刚好为 0 时不额外补一张', fired.length === 0, `结算 ${fired.length} 次`);
}

/* ---------------- 4. 力度/行程越大，跨得越多 ---------------- */
{
  const light = harness({ viewW: 1000 });
  light.stream(new Array(5).fill(-100)); // 500px，不足一屏
  const medium = harness({ viewW: 1000 });
  medium.stream(new Array(25).fill(-100)); // 2500px → 2 张 + 吸附补 1 张
  const heavy = harness({ viewW: 1000 });
  heavy.stream(new Array(50).fill(-100)); // 5000px → 5 张

  ok('轻推（不足一屏）不连续推进', light.advances.length === 0,
    `${light.advances.length} 张`);
  ok('中等力度推进 2 张', medium.advances.length === 2, `${medium.advances.length} 张`);
  ok('大力度推进 5 张', heavy.advances.length === 5, `${heavy.advances.length} 张`);
  medium.idle(200);
  ok('中等力度的余数会由流结束吸附补完最后一张', medium.fired.length === 1,
    `结算 ${medium.fired.length} 次`);
  ok('跨张数随行程单调不减',
    light.advances.length <= medium.advances.length &&
      medium.advances.length <= heavy.advances.length);
}

/* ---------------- 5. 甩：流结束窗口内补完最后一张 ---------------- */
{
  const { fired, stream, idle, latency } = harness();
  stream(new Array(6).fill(-40)); // 一帧 40px、16ms → 明显是甩
  ok('甩的过程中不插收尾（画面全程跟手）', fired.length === 0,
    `结算 ${fired.length} 次`);
  idle(80);
  ok('流停了就吸附补完最后一张', fired.length === 1, `结算 ${fired.length} 次`);
  ok(
    '结算窗口 = 65ms（结算与「新的一段」共用同一个刻度）',
    latency() >= 60 && latency() <= 70,
    `窗口 ${latency()}ms`
  );
}

/* ---------------- 6. 慢拖：沿用单指判据，等流停才结算 ---------------- */
{
  const { fired, stream, idle, latency } = harness();
  // 慢拖：每 60ms 走 12px ≈ 0.2px/ms；累计 360px > 22% × 1440 = 316.8
  for (let i = 0; i < 30; i += 1) stream([-12], 60);
  ok('慢拖期间不结算', fired.length === 0, `结算 ${fired.length} 次`);
  idle(80);
  ok('流停了按 22% 视口判据翻一张（手感没退化）', fired.length === 1,
    `结算 ${fired.length} 次`);
  ok('慢拖结算窗口仍是 65ms', latency() >= 60 && latency() <= 70,
    `窗口 ${latency()}ms`);
}

/* ---------------- 7. 抬手后再滑必须立刻还能翻 ---------------- */
// 旧版的回归点：那时「锁满 380ms + 静默 180ms」的双条件会把第二段流整个吞掉。
// 现在没有锁，靠「静默 ≥ 65ms 就是新的一段」重新起手。
{
  const { fired, stream, idle } = harness();
  stream(flick(-1));
  idle(200);
  ok('第一下翻一张', fired.length === 1, String(fired.length));

  stream(flick(-1));
  idle(200);
  ok('抬手后再滑：立刻还能翻（不会被上一段吞掉）', fired.length === 2,
    `共 ${fired.length} 次`);

  stream(flick(-1));
  idle(200);
  ok('连着第三下同样响应', fired.length === 3, `共 ${fired.length} 次`);
}

/* ---------------- 8. 轻微位移 + 低速：回弹、不翻页 ---------------- */
{
  const { g, fired, stream, idle } = harness();
  stream([-5, -6, -4], 50);
  idle(200);
  ok('轻微位移 + 低速不翻页', fired.length === 0, String(fired.length));
  ok('没达标的这一段把轨道带回 0', g.swipeX === 0, String(g.swipeX));
}

/* ---------------- 9. 快速轻甩：靠速度也要能翻 ---------------- */
{
  const { fired, stream, idle } = harness();
  stream([-30, -34, -30]); // 累计不到一屏的 22%，但每 16ms 走 30+px
  idle(200);
  ok('快速轻甩靠速度门槛也能翻页', fired.length === 1, String(fired.length));
}

/* ---------------- 10. 同一段里掉头：反向连续推进 ---------------- */
{
  const { advances, stream, idle } = harness({ viewW: 1440 });
  stream(new Array(20).fill(-150)); // -3000 → 推进 2 张，余 -120
  const forward = advances.length;
  ok('向前推出去就连续推进', forward === 2, `推进 ${forward} 张`);

  stream(new Array(20).fill(150)); // 没抬手直接掉头，+3000 → 反向推进 2 张
  const back = advances.slice(forward);
  ok(
    '没抬手直接掉头：反向也能连续推进（旧版只给「再翻一张」）',
    back.length === 2,
    `反向 ${back.length} 张`
  );
  ok('掉头的方向是反的', back.every((a) => a.direction === -1),
    JSON.stringify(back.map((a) => a.direction)));
  idle(200);
}

/* ---------------- 11. 只有一张图时既不跟手也不结算 ---------------- */
{
  const { g, fired, intents, advances, stream, idle } = harness({ canSwipe: () => false });
  stream(flick(-1));
  idle(200);
  ok('单图时横向不跟手', g.swipeX === 0, String(g.swipeX));
  ok('单图时横向不结算', fired.length === 0, String(fired.length));
  ok('单图时不连续推进', advances.length === 0, String(advances.length));
  ok('单图时不去预取邻图', intents.length === 0, String(intents.length));
}

/* ---------------- 12. 纵向主导的一整串都不许翻页 ---------------- */
{
  const { fired, push, stream, idle } = harness();
  push(10, 60); // 起手就是纵向
  stream([-60, -80]);
  idle(200);
  ok('起手判给纵向之后，后面这一串横向不再翻页', fired.length === 0, String(fired.length));
}

/* ---------------- 13. 轴向判定不被起手噪声带偏（「第一次滑不动」的真因） ---------------- */
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

/* ---------------- 14. 预取意图：方向一确定就通知上层 ---------------- */
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

/* ---------------- 15. 接管正在跑的切换动画（连续切换后不跟手的真因） ---------------- */
// 连续快切时用户几乎总在上一次的收尾动画里再次起手。那段动画跑在 track 上
// （WAAPI），关键帧优先级高于内联样式：不接管的话，这一整段跟手位移都被盖住。
{
  const { g, fired, stream, idle, claimCalls } = harness({
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
    fired.length === 0 && g.wheelSwipe.x === -17,
    `触发 ${fired.length} 次 / x=${g.wheelSwipe.x}`
  );

  stream(new Array(4).fill(-40));
  ok('流没停就不结算', fired.length === 0, `触发 ${fired.length} 次`);
  idle(200);
  ok('流停了照常吸附一张', fired.length === 1, `触发 ${fired.length} 次`);
  ok(
    '吸附的 carry 里含着接管偏移（收尾才能从当前位置接着播）',
    (fired[0]?.carried ?? 0) < -600,
    `carry=${fired[0]?.carried}`
  );
  ok(
    '结算之后接管偏移作废（下一段重新量）',
    g.wheelSwipe.base === null,
    String(g.wheelSwipe.base)
  );
}

/* ---------------- 16. 接管后没达标：回弹到位，偏移作废 ---------------- */
{
  const { g, fired, stream, idle } = harness({ claim: () => -300 });
  stream([-20, -20], 60);
  ok('接管 + 小幅慢速位移不结算', fired.length === 0, String(fired.length));
  idle(200);
  ok('回弹到基准（这一格算切完）', g.swipeX === 0, String(g.swipeX));
  ok('回弹后接管偏移交回 null（等下一段重新量）',
    g.wheelSwipe.base === null, String(g.wheelSwipe.base));
}

/* ---------------- 17. 每次起手最多接管一次（不能每帧都去要） ---------------- */
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

/* ---------------- 18. 抬手 100ms 后再滑：必须重新接管 ---------------- */
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

/* ---------------- 19. 峰值速度不跨段残留 ---------------- */
{
  const { fired, stream, idle } = harness();
  stream([-60, -60], 16); // 快：peakV ≈ 3
  ok('快甩的过程中不插收尾', fired.length === 0, String(fired.length));
  idle(200);
  ok('流停了才翻一张', fired.length === 1, String(fired.length));

  stream([-30], 60); // 慢：0.2px/ms，只是越过 28px 的门槛
  idle(200);
  ok(
    '慢拖不会被上一段的峰值速度判成甩',
    fired.length === 1,
    `又多了 ${fired.length - 1} 次`
  );
}

/* ---------------- 20. 回弹被打断：必须接住回弹中途的那一截 ---------------- */
// 没达标的那一段会回弹（200ms）。回弹是 WAAPI 关键帧，优先级高于内联样式：
// 直接 cancel 会让视觉瞬间掉回内联值（= 0 偏移）。base 在回弹开始就被写成 0
// 的话，「回弹还没播完就再滑一次」时那段没走完的位移会被整段丢掉。
{
  const { g, track, fired, stream, idle, push } = harness(); // 没有 claimTrack
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

/* ---------------- 21. 连续快滑：没有逐张收尾，延迟不累积 ---------------- */
{
  const { fired, advances, rests, stream, idle, advanceLatency } = harness({ viewW: 1000 });
  stream(new Array(40).fill(-100)); // 4000px → 4 张
  ok('连续推进 4 张', advances.length === 4, `${advances.length} 张`);
  ok('推进发生在事件当帧（不排队、不重试）', advanceLatency() <= 0,
    `${advanceLatency()}ms`);
  ok('整段流里没有一次逐张收尾动画', fired.length === 0, `结算 ${fired.length} 次`);
  idle(200);
  ok('流结束最多只补一次吸附', fired.length <= 1, `结算 ${fired.length} 次`);
  ok('结算通知只发一次（上层补给最终那一张）', rests.length === 1,
    `通知 ${rests.length} 次`);
}

/* ---------------- 22. 首尾阻尼：不露黑边，反向立刻响应 ---------------- */
{
  const { g, advances, stream, idle } = harness({
    viewW: 1000,
    advance: () => false // 已经到最后一张
  });
  stream(new Array(30).fill(-100)); // 一直往没有图的方向推
  ok('到首尾后不再推进', advances.length === 0, `${advances.length} 张`);
  ok('跟手量夹在一小段阻尼内（不把整屏空槽拉进来）', Math.abs(g.swipeX) <= 90.001,
    `swipeX=${g.swipeX}`);

  stream(new Array(5).fill(100)); // 立刻往回推
  ok('反向不需要先「走完」之前堆的几千 px（累计没无限堆）', g.swipeX > -90,
    `swipeX=${g.swipeX}`);
  idle(200);
}

/* ---------------- 23. 异常增量：单次事件连续推进有上限 ---------------- */
{
  const { g, advances, push, idle } = harness({ viewW: 1000 });
  push(-20000, 0, 16); // 一个事件横跨 20 屏（异常设备 / 合成器）
  ok('一个事件不会把整个图库跳完（上限 8 张）', advances.length === 8,
    `${advances.length} 张`);
  ok(
    '异常增量被夹到不足一屏（wheelFollowOffset 不会把视觉位置压到另一侧）',
    Math.abs(g.swipeX) < 1000,
    `swipeX=${g.swipeX}`
  );
  idle(200);
}

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 横向 wheel 连续推进 / 跟手 / 流结束吸附 / 无延迟累积 检查全部通过');
