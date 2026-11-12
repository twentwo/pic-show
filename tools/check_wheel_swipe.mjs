#!/usr/bin/env node
/**
 * 横向 wheel「一次滑动只切一张」的最小回归测试（Node 直接跑，不用浏览器）。
 *
 * 为什么单独存在：`ui/probe.html` 那条路要起无头浏览器、跑满两种尺寸，慢且
 * 依赖 Edge；而「一段 wheel 流会不会一次跨多张、跟不跟手、什么时候结算、
 * 边界会不会越界」本质上是 `handleWheelHorizontal` 的纯时序逻辑 —— 塞进
 * Node 里用**可控时钟 + 可控定时器**跑最合适，改坏了 1 秒内就能看到。
 *
 * 五条硬性纪律：
 *   1. 一次连续流**零次流中换页**（`onWheelAdvance` 恒不被调用），索引唯一
 *      可能变化的地方是流停下时的 `settleWheelSwipe`，命中也只切相邻一张；
 *   2. 距离 / 速度 / 惯性尾巴都不累加跨张：甩 5000px 与甩 500px 一样只切一张；
 *      显示位移渐近压缩到不足一屏，画面够不到再下一张；
 *   3. `settled` 闸门：重复结算回调、定时器重排都不许翻第二张；静默 ≥ 65ms
 *      才算新的一段，抬手再滑立刻重新起手；
 *   4. 跟手全程连续（1:1 + 渐近压缩），方向由最终净位移决定；到首张 / 末张
 *      继续往外滑**轨道一格都不动**（swipeX 恒 0、inline 恒基准），只把当前图
 *      的弹性量交给 `onWheelEdge`，流停下回弹到 0，不循环、不越界；
 *   5. 结算窗口默认 65ms（同时也是「新的一段」的刻度），轴向判定、接管 /
 *      回弹不丢位移、异常增量有上限；
 *   6. macOS 原生相位接成结算时机的主判据：`momentum ended` 改用 24ms 短刻度
 *      提前结算，`phase began` 不受 65ms 限制直接复位 `settled` 闸门（真机
 *      50~58ms 的连滑因此各切一张）；没有原生事件时逐字退回第 5 条的兜底，
 *      方向 / 位移 / 速度 / 边界回弹一律不动（第 29 组）。
 */

import { readFileSync } from 'node:fs';
import { Gestures } from '../ui/js/gestures.js';

/** 第 31 组要把真机实测的时间基线钉在**同一份源码常量**上，而不是抄一份数字 */
const gesturesSrc = readFileSync(new URL('../ui/js/gestures.js', import.meta.url), 'utf8');

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
        // 回弹曲线的交接要在纯逻辑层可断言：把这次动画实际用的时长 / 缓动留下
        duration: opts.duration,
        easing: opts.easing,
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
 * @param {number} [opts.viewW] 视口宽（= 一屏 = 显示位移的渐近上限）
 * @param {(direction:number)=>boolean} [opts.canSwipe] 该方向还有没有图（同时
 *   充当 `onWheelCanStep` 的回退，用来模拟首张 / 末张）
 * @param {(n:number)=>number|null} [opts.claim] 模拟 viewer.claimTrack()
 * @param {(direction:number, done:number)=>boolean} [opts.advance] 兼容旧用例的
 *   逐屏换页模拟；新契约下这条回调不应被调用，`advances` 用来断言「恒为零」
 */
function harness({ viewW = 1440, canSwipe = () => true, step = null, claim = null, advance: canAdvance = null, settleTiming = null } = {}) {
  const fired = [];
  const intents = [];
  const advances = [];
  const rests = [];
  /** 贴边跟随回调：记录时顺手记下「轨道还没写」之前的 inline 位置 */
  const follows = [];
  /** 边界弹性回调：到首 / 末张时只给当前图的那一小段位移 */
  const edges = [];
  /** 流结束回调：rebound=true 表示取消回弹，velocity 是交接给落位的跟手速度 */
  const settles = [];
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
      // viewer 注册的 wheel 专用边界判定；不传时走 gestures 里的 canSwipe 回退
      onWheelCanStep: step ? (direction) => step(direction) : null,
      view: () => ({ left: 0, top: 0, w: viewW, h: 800 }),
      // 逐屏换页通道：新契约下 handleWheelHorizontal 不该调用它。保留记录
      // 是为了把「一段流零次换页」钉成可执行的断言。
      onWheelAdvance: (direction) => {
        const allowed = canAdvance ? canAdvance(direction, advances.length) : true;
        if (allowed) advances.push({ direction, at: clock });
        return allowed;
      },
      onSwipeIntent: (direction) => intents.push({ direction, at: clock }),
      onWheelFollow: (swipeX, width) => follows.push({
        swipeX, width, at: clock, inlineBefore: track.inline
      }),
      onWheelEdge: (offset) => edges.push({ offset, at: clock, inline: track.inline }),
      onWheelSettle: (rebound, velocity) => {
        settles.push({ rebound, velocity, at: clock });
        // viewer 的 releaseWheelSeam() 会把回弹 timing 返回给 gestures；
        // settleTiming 用来在纯逻辑层模拟这份返回值（默认没有 → 退回旧曲线）。
        return rebound && settleTiming ? settleTiming(velocity) : settles.length;
      },
      // 整段流的唯一结算点：viewer 在这里走 go(fromWheel)（不重建手势、时长随
      // 剩余距离收缩）。替身记录后把轨道归位，模拟收尾动画落地。
      onWheelSwipe: (direction, opts = {}) => {
        fired.push({
          direction,
          at: clock,
          fromSwipe: Boolean(opts?.fromSwipe),
          velocity: opts?.velocity,
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
    follows,
    edges,
    settles,
    push,
    claimCalls: () => claimCalls,
    /** 推一串横向事件（dx 已归一化：向左为负） */
    stream: (dxs, gapMs = 16) => dxs.forEach((dx) => push(dx, 0, gapMs)),
    /** 静默 ms 毫秒 —— 相当于抬手 */
    idle: (ms) => advance(ms),
    /** 最后一次**吸附**相对最后一个事件的时间差 */
    latency: () => (fired.length ? fired[fired.length - 1].at - lastEventAt : -1),
    /** 保留用于断言「从未推进」；没有推进记录时返回 -1 */
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

/* ---------------- 2. 显示位移渐近压缩到不足一屏 ---------------- */
{
  const { g } = harness({ viewW: 1440 });
  const small = Math.abs(g.wheelFollowOffset(-300, 1440));
  const mid = Math.abs(g.wheelFollowOffset(-1100, 1440));
  const far = Math.abs(g.wheelFollowOffset(-3000, 1440));
  const huge = Math.abs(g.wheelFollowOffset(-20000, 1440));
  ok(
    '跟手量始终不足一屏（不会把再下一张 / 黑边拖进来）',
    far < 1440 && huge < 1440,
    `3000px→${far.toFixed(1)} 20000px→${huge.toFixed(1)}`
  );
  ok(
    '前半段仍 1:1 跟手，后半段单调渐近（惯性尾巴不是「画面死住」）',
    Math.abs(small - 300) < 0.001 && mid > small && far > mid && huge > far,
    `${small.toFixed(1)} → ${mid.toFixed(1)} → ${far.toFixed(1)} → ${huge.toFixed(1)}`
  );
  ok(
    '首尾方向只给一小段阻尼（当前图轻轻一弹）',
    Math.abs(g.wheelFollowOffset(-3000, 91)) < 90.001,
    `${Math.abs(g.wheelFollowOffset(-3000, 91)).toFixed(1)}px`
  );
}

/* ---------------- 3. 一次长滑：流中零换页、流末只切一张 ---------------- */
// 一次手势 = 从起手到静默 65ms 的整段 wheel 事件，不管甩多远、惯性尾巴多长，
// 索引只能在流停下时变化一次，且只到相邻那张。
{
  const { fired, advances, stream, idle, rests, settles } = harness({ viewW: 1000 });
  stream(new Array(50).fill(-100)); // 5000px = 旧契约里的 5 张
  ok(
    '一次长距离横滑流中间零次换页（onWheelAdvance 恒不被调用）',
    advances.length === 0,
    `推进 ${advances.length} 张：${JSON.stringify(advances)}`
  );
  ok('流还在跑时不插入任何吸附收尾', fired.length === 0, `结算 ${fired.length} 次`);
  idle(200);
  ok('流停了才结算，且只切一张', fired.length === 1, `结算 ${fired.length} 次`);
  ok('方向正确（向左滑 = 下一张）', fired[0]?.direction === 1,
    JSON.stringify(fired.map((f) => f.direction)));
  ok('整段流只做一次结算通知（不是每翻一张一次）', rests.length === 1,
    `通知 ${rests.length} 次`);
  ok('贴边归位也只通知一次', settles.length === 1, `通知 ${settles.length} 次`);
}

/* ---------------- 4. 力度 / 行程不影响张数 ---------------- */
{
  const light = harness({ viewW: 1000 });
  light.stream(new Array(5).fill(-100));   // 500px，不足一屏
  const medium = harness({ viewW: 1000 });
  medium.stream(new Array(25).fill(-100)); // 2500px，旧契约 2 张 + 补 1 张
  const heavy = harness({ viewW: 1000 });
  heavy.stream(new Array(50).fill(-100));  // 5000px，旧契约 5 张

  ok('轻推流中不换页', light.advances.length === 0, `${light.advances.length} 张`);
  ok('中等力度流中不换页', medium.advances.length === 0, `${medium.advances.length} 张`);
  ok('大力度流中不换页', heavy.advances.length === 0, `${heavy.advances.length} 张`);
  light.idle(200);
  medium.idle(200);
  heavy.idle(200);
  ok(
    '甩 500 / 2500 / 5000px 都只结算一张，张数与行程无关',
    light.fired.length === 1 && medium.fired.length === 1 && heavy.fired.length === 1,
    `${light.fired.length} / ${medium.fired.length} / ${heavy.fired.length}`
  );
  ok(
    '三种力度的结算方向一致（都是下一张）',
    [light, medium, heavy].every((h) => h.fired[0]?.direction === 1)
  );
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

/* ---------------- 10. 同一段里掉头：零换页，方向由最终净位移定 ---------------- */
{
  const { advances, fired, stream, idle } = harness({ viewW: 1440 });
  stream(new Array(20).fill(-150)); // 推出去
  ok('向前推出去，流中间零次换页', advances.length === 0 && fired.length === 0,
    `推进 ${advances.length} 张 / 结算 ${fired.length} 次`);

  stream(new Array(20).fill(150)); // 没抬手直接掉头，正好抵消
  idle(200);
  ok('同一段里掉头抵消后不翻页（回弹到当前张）', fired.length === 0,
    `结算 ${fired.length} 次`);

  const turned = harness({ viewW: 1440 });
  turned.stream(new Array(20).fill(-150));
  turned.stream(new Array(30).fill(150)); // 净位移翻到反方向
  turned.idle(200);
  ok(
    '掉头后继续往反方向推：只结算一张，方向反过来',
    turned.fired.length === 1 && turned.fired[0].direction === -1 &&
      turned.advances.length === 0,
    `结算 ${turned.fired.length} 次 / 方向 ${turned.fired[0]?.direction}`
  );
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

/* ---------------- 21. 连续快滑：整段只结算一张，延迟不累积 ---------------- */
{
  const { fired, advances, rests, stream, idle, advanceLatency } = harness({ viewW: 1000 });
  stream(new Array(40).fill(-100)); // 4000px，旧契约里的 4 张
  ok('整段流零次推进', advances.length === 0 && advanceLatency() === -1,
    `${advances.length} 张`);
  ok('整段流里没有一次逐张收尾动画', fired.length === 0, `结算 ${fired.length} 次`);
  idle(200);
  ok('流结束最多只结算一次吸附', fired.length <= 1, `结算 ${fired.length} 次`);
  ok('结算通知只发一次（上层补给最终那一张）', rests.length === 1,
    `通知 ${rests.length} 次`);
}

/* ---------------- 22. 首张 / 末张：不循环、不越界、轨道不动、只反弹 ------- */
{
  const { g, track, advances, fired, settles, edges, follows, intents, stream, idle } = harness({
    viewW: 1000,
    canSwipe: (d) => d < 0 // 下一张方向已到末张，上一张方向还有图
  });
  stream(new Array(30).fill(-100)); // 一直往没有图的方向推
  ok('到末张后零次换页', advances.length === 0 && fired.length === 0,
    `${advances.length} 张 / ${fired.length} 次结算`);
  ok(
    '边界段轨道恒在基准（不再把 90px 阻尼 / 越界槽拉进视口）',
    g.swipeX === 0 && track.inline === 0,
    `swipeX=${g.swipeX} inline=${track.inline}`
  );
  ok(
    '边界段不贴边、不预取目标图（越界槽一个像素都不画）',
    follows.length === 0 && intents.length === 0,
    `follow=${follows.length} intent=${intents.length}`
  );
  ok(
    '只给当前图一点弹性位移，且被 WHEEL_EDGE_RUBBER 夹住',
    edges.length > 0 && edges.every((e) => Math.abs(e.offset) <= 22.001 && e.inline === 0),
    `edges=${edges.length} max=${Math.max(0, ...edges.map((e) => Math.abs(e.offset)))}`
  );
  idle(200);
  ok('末张继续请求下一张：不切图、不循环、不越界', fired.length === 0,
    `结算 ${fired.length} 次`);
  ok('只让当前图回弹（onWheelSettle(true)），结算后轨道仍在基准',
    settles.length === 1 && settles[0].rebound === true &&
      g.swipeX === 0 && track.inline === 0,
    `${JSON.stringify(settles)} swipeX=${g.swipeX} inline=${track.inline}`);

  // 回弹（上层 200ms CSS 过渡）还没走完就再滑：新的一段要立刻响应，既不被
  // 上一段的 settled 挡住，也不能把轨道推偏或再翻一张。
  const edgesBefore = edges.length;
  stream(new Array(8).fill(-100));
  idle(70);
  stream(new Array(8).fill(-100));
  idle(200);
  ok(
    '回弹过程中再滑：两段各结算一次、无重复切换、轨道无残留偏移',
    settles.length === 3 && settles.every((s) => s.rebound === true) &&
      fired.length === 0 && g.swipeX === 0 && track.inline === 0 &&
      edges.length > edgesBefore,
    `settles=${settles.length} fired=${fired.length} swipeX=${g.swipeX} inline=${track.inline}`
  );

  const back = harness({ viewW: 1000, canSwipe: (d) => d < 0 });
  back.stream(new Array(30).fill(-100));
  back.stream(new Array(10).fill(100)); // 立刻往回推（累计有上限，不必抵消几千 px）
  ok('反向立刻响应（累计夹在两屏内）', back.g.swipeX > -90,
    `swipeX=${back.g.swipeX}`);
  back.idle(200);
  ok('往还有图的方向推，照常只切一张', back.fired.length === 1 &&
    back.fired[0].direction === -1, JSON.stringify(back.fired));
}

/* ---------------- 23. 异常增量：单个事件也不能一次跨多张 ---------------- */
{
  const { g, advances, fired, push, idle } = harness({ viewW: 1000 });
  push(-20000, 0, 16); // 一个事件横跨 20 屏（异常设备 / 合成器）
  ok('一个事件不会推进任何一张', advances.length === 0, `${advances.length} 张`);
  ok(
    '异常增量被压到不足一屏（wheelFollowOffset 不会把视觉位置压到另一侧）',
    Math.abs(g.swipeX) < 1000,
    `swipeX=${g.swipeX}`
  );
  idle(200);
  ok('异常增量也只结算一张', fired.length === 1, `结算 ${fired.length} 次`);
}

/* ---------------- 24. 目标图贴边跟随：起手每个事件都要有对齐机会 -------- */
{
  const h = harness({ viewW: 1000 });
  h.stream([-12, -20, -30, -24, -16]);
  ok(
    '每个跟手事件都在写轨道 transform 之前通知贴边（起手第一帧就对齐目标图）',
    h.follows.length === 5 &&
      h.follows.every((f) => f.width === 1000 && f.inlineBefore !== f.swipeX),
    h.follows.map((f) => `${f.swipeX}/${f.inlineBefore}`).join(' ')
  );
  ok(
    '贴边回调拿到的是本帧最终位移（与轨道随后写入的值一致）',
    Math.abs(h.follows[4].swipeX - h.g.swipeX) < 0.001 &&
      Math.abs(h.follows[4].swipeX - h.track.inline) < 0.001,
    `follow=${h.follows[4].swipeX} swipeX=${h.g.swipeX} inline=${h.track.inline}`
  );
  h.idle(200);
  ok('一段流只通知一次归位', h.settles.length === 1, `${h.settles.length} 次`);
}

{
  const done = harness({ viewW: 1000 });
  done.stream(new Array(15).fill(-30)); // 450px > 22% 视口 → 补完最后一张
  done.idle(200);
  ok(
    '补完最后一张时 onWheelSettle(false)（与 180ms 收尾动画同步归零）',
    done.settles.length === 1 && done.settles[0].rebound === false,
    JSON.stringify(done.settles)
  );

  const cancelled = harness({ viewW: 1000 });
  cancelled.push(-6, 0, 16);
  cancelled.push(-4, 0, 16); // 累计 10px，远不到阈值 → 回弹
  cancelled.idle(200);
  ok(
    '取消回弹时 onWheelSettle(true)（与 200ms 回弹同步归零）',
    cancelled.settles.length === 1 && cancelled.settles[0].rebound === true,
    JSON.stringify(cancelled.settles)
  );
}

/* ---------------- 25. 结算闸门：重复回调 / 惯性尾巴只认一次 ---------------- */
{
  const h = harness({ viewW: 1000 });
  h.stream(new Array(15).fill(-30));
  h.idle(80); // 静默 65ms 到点 → 唯一一次结算
  ok('流停下只结算一张', h.fired.length === 1, `结算 ${h.fired.length} 次`);
  ok('闸门已置起', h.g.wheelSwipe.settled === true,
    String(h.g.wheelSwipe.settled));

  // 上层重复触发结算（定时器被重排、回调被调两次）——不许翻第二张
  h.g.settleWheelSwipe(0);
  h.g.settleWheelSwipe(0);
  ok('重复结算调用不会再翻页', h.fired.length === 1, `结算 ${h.fired.length} 次`);
  ok('onWheelRest / 贴边归位也各只发一次',
    h.rests.length === 1 && h.settles.length === 1,
    `rest=${h.rests.length} settle=${h.settles.length}`);

  // 静默够久 = 新的一次滑动，闸门复位，抬手再滑照常切下一张
  h.stream(new Array(15).fill(-30));
  h.idle(200);
  ok('抬手再滑闸门复位，仍只切一张', h.fired.length === 2,
    `共 ${h.fired.length} 次`);

  // 闸门置起之后仍到达的事件（定时器重排 / 惯性尾巴 / 重复回调）：只消费
  // 默认行为，不累计位移、不写轨道、不重排结算。没有这道闸，尾巴会把画面
  // 再推到半张图上，或重排出第二次 `onWheelSwipe`（一次手势翻两张）。
  const gated = harness({ viewW: 1000 });
  gated.push(-30, 0, 16); // 只锁轴向，不推时钟 —— 仍是同一段流
  gated.g.wheelSwipe.settled = true;
  const xBefore = gated.g.wheelSwipe.x;
  const inlineBefore = gated.track.inline;
  const settleTimerBefore = gated.g._wheelSettle;
  let consumed = false;
  gated.g.handleWheelHorizontal(
    {
      ctrlKey: false,
      clientX: 700,
      preventDefault() { consumed = true; }
    },
    -40,
    0
  );
  ok('闸门置起后到达的事件只被消费，不记账 / 不写轨道 / 不重排结算',
    consumed &&
      gated.g.wheelSwipe.x === xBefore &&
      gated.track.inline === inlineBefore &&
      gated.g._wheelSettle === settleTimerBefore,
    `x=${gated.g.wheelSwipe.x}/${xBefore} inline=${gated.track.inline}/${inlineBefore} ` +
      `timer=${gated.g._wheelSettle}/${settleTimerBefore}`);
  gated.idle(200);
}

/* ---------------- 26. wheel 专用边界：循环开关不参与 ---------------- */
{
  const h = harness({
    viewW: 1000,
    canSwipe: () => true, // 单指 / 键盘可能开了循环
    step: () => false     // wheel 的相邻一张不存在
  });
  h.stream(new Array(20).fill(-100));
  ok('边界判定优先用 onWheelCanStep（轨道完全不动，只弹当前图）',
    h.g.swipeX === 0 && h.track.inline === 0 && h.follows.length === 0 &&
      h.edges.length > 0 && h.edges.every((e) => Math.abs(e.offset) <= 22.001),
    `swipeX=${h.g.swipeX} inline=${h.track.inline} follow=${h.follows.length} edge=${h.edges.length}`);
  h.idle(200);
  ok('即使 canSwipe 允许循环，wheel 也不绕回另一头',
    h.fired.length === 0 && h.advances.length === 0,
    `结算 ${h.fired.length} 次 / 推进 ${h.advances.length} 张`);
  ok('只回弹当前图', h.settles.length === 1 && h.settles[0].rebound === true,
    JSON.stringify(h.settles));
}

/* ---------------- 27. 落位初速交接：一段一次、双向一致、力度相关 ---------------- */
// viewer 靠这份速度算落位时长 / 缓动（起点速度 = v0、终点 = 0），所以时序层
// 必须保证：结算只交一次、补完与贴边归零拿到的是同一份、反向与连滑都不丢。
{
  const h = harness({ viewW: 1000 });
  h.stream(flick(-1));
  h.idle(200);
  ok('一段流只交接一次速度（贴边归零与轨道落位各拿一份，值相同）',
    h.settles.length === 1 && h.fired.length === 1 &&
      Number.isFinite(h.settles[0].velocity) && h.settles[0].velocity >= 0 &&
      h.fired[0].velocity === h.settles[0].velocity,
    `settle=${JSON.stringify(h.settles)} fired=${JSON.stringify(h.fired)}`);

  const back = harness({ viewW: 1000 });
  back.stream(flick(1));
  back.idle(200);
  ok('反方向同样交接速度，且补完分支 rebound=false',
    back.settles.length === 1 && back.settles[0].rebound === false &&
      Number.isFinite(back.settles[0].velocity) && back.settles[0].velocity >= 0 &&
      back.fired[0].velocity === back.settles[0].velocity,
    JSON.stringify(back.settles));

  // 力度相关：同样的总行程、不同的事件节奏，交接的速度必须不同（都靠位移达标
  // 触发，避免把「一段没达标」误当成力度差异）。
  const soft = harness({ viewW: 1000 });
  soft.stream(new Array(40).fill(-8), 40); // 320px / 0.2 px·ms⁻¹
  soft.idle(200);
  const hard = harness({ viewW: 1000 });
  hard.stream(new Array(40).fill(-8), 16); // 320px / 0.5 px·ms⁻¹
  hard.idle(200);
  ok('交接速度与本段手势力度相关（快甩 > 慢拖），落位节奏因此跟着手势走',
    soft.fired.length === 1 && hard.fired.length === 1 &&
      hard.fired[0].velocity > soft.fired[0].velocity,
    `soft=${soft.fired[0]?.velocity} hard=${hard.fired[0]?.velocity}`);

  // 连续快滑：每段各自交接自己的速度，不会被上一段的峰值污染
  const twice = harness({ viewW: 1000 });
  twice.stream(new Array(14).fill(-40));
  twice.idle(200);
  twice.stream(new Array(14).fill(20));
  twice.idle(200);
  ok('连续快滑每段各交一次速度，速度不被上一段残留污染',
    twice.settles.length === 2 && twice.fired.length === 2 &&
      twice.settles.every((s, i) => s.velocity === twice.fired[i].velocity) &&
      twice.fired[0].velocity !== twice.fired[1].velocity,
    `settles=${JSON.stringify(twice.settles)} fired=${JSON.stringify(twice.fired.map((f) => f.velocity))}`);

  // 取消回弹也要拿到同一份（viewer 的回弹分支虽然不用它，回调契约保持一致）
  const cancelled = harness({ viewW: 1000 });
  cancelled.push(-6, 0, 16);
  cancelled.push(-4, 0, 16);
  cancelled.idle(200);
  ok('取消回弹也携带速度（rebound=true），补完/取消两条分支契约一致',
    cancelled.settles.length === 1 && cancelled.settles[0].rebound === true &&
      Number.isFinite(cancelled.settles[0].velocity),
    JSON.stringify(cancelled.settles));
}

/* ---------------- 28. 连续快滑到末张：边界立刻生效、不重复切换 ------------ */
// 真机症状：切到末张的那一下收尾还没播完，用户已经又甩了一下。这一段既不能
// 因为「上一张还能切」再翻一张，也不能沿用上一段的跟手位移把越界槽拉进视口。
{
  let atEnd = false;
  const hasStep = (d) => !(atEnd && d > 0);
  const h = harness({ viewW: 1000, canSwipe: hasStep, step: hasStep });
  h.stream(new Array(14).fill(-40));
  h.idle(200);
  ok('第一下正常切一张（未到末张）', h.fired.length === 1 &&
    h.fired[0].direction === 1, JSON.stringify(h.fired));

  atEnd = true; // 这一次结算落到了末张
  const inlineAfterSwitch = h.track.inline;
  const followsBefore = h.follows.length;
  h.stream(new Array(14).fill(-40)); // 立刻继续往「下一张」甩
  ok('到末张后紧接着快滑：轨道仍停在基准，不出现过渡边缘',
    h.g.swipeX === 0 && h.track.inline === inlineAfterSwitch &&
      h.follows.length === followsBefore && h.intents.length === 1,
    `swipeX=${h.g.swipeX} inline=${h.track.inline}/${inlineAfterSwitch} ` +
      `follow=${h.follows.length}/${followsBefore} intent=${h.intents.length}`);
  h.idle(200);
  ok('连续快滑到末张不重复切换、只回弹',
    h.fired.length === 1 && h.settles.length === 2 &&
      h.settles[1].rebound === true && h.g.swipeX === 0,
    `fired=${h.fired.length} settles=${JSON.stringify(h.settles)}`);

  // 回弹过程中反向滑回上一张：必须照常只切一张，方向正确、无残留偏移
  h.stream(new Array(14).fill(40));
  h.idle(200);
  ok('边界回弹中反向再滑：照常切回相邻一张，索引不越界',
    h.fired.length === 2 && h.fired[1].direction === -1 && h.g.swipeX === 0,
    JSON.stringify(h.fired.map((f) => f.direction)));
}

/* ---------------- 29. 原生 wheel 相位：结算时机主判据 + 65ms 兜底 ---------- */
// 真机依据：IPC 单程 0~3ms、14 次手势的 began/ended 四件套齐全；旧版只靠
// 65ms 静默时，两次间隔 50~58ms 的连滑会被 settled 闸门合成一段、少切一张。
// 这组钉住：有原生相位时按系统给的开始/结束结算，没有时逐字退回 65ms。
{
  // 29.1 完全没有原生相位事件：兜底行为与改动前一致
  const a = harness({ viewW: 1000 });
  a.stream(flick());
  a.idle(64);
  ok('29.1a 无原生相位时 65ms 前不提前结算', a.fired.length === 0,
    `fired=${a.fired.length}`);
  a.idle(2);
  ok('29.1b 无原生相位时仍在 65ms 结算一次', a.fired.length === 1 &&
    a.fired[0].direction === 1 && a.fired[0].fromSwipe === true,
    JSON.stringify(a.fired));

  // 29.2 momentum ended 把结算提前到 24ms，且只结算一次
  const b = harness({ viewW: 1000 });
  b.stream(flick());
  b.g.onWheelPhaseEnd();
  b.idle(23);
  ok('29.2a 原生 ended 后 24ms 短刻度内不提前结算', b.fired.length === 0,
    `fired=${b.fired.length}`);
  b.idle(1);
  ok('29.2b 原生 ended 提前结算（延迟 ≤24ms，不是 65ms）',
    b.fired.length === 1 && b.latency() <= 24 && b.latency() >= 0,
    `fired=${b.fired.length} latency=${b.latency()}`);
  b.g.onWheelPhaseEnd();
  b.g.onWheelPhaseEnd();
  b.idle(200);
  ok('29.2c 重复的 ended / 惯性尾巴不再翻第二张',
    b.fired.length === 1 && b.settles.length === 1,
    `fired=${b.fired.length} settles=${b.settles.length}`);

  // 29.3 两段只隔 50ms 的连滑：原生 began 复位闸门 → 各切一张
  const c = harness({ viewW: 1000 });
  c.stream(flick());
  c.g.onWheelPhaseEnd();
  c.idle(24);
  c.idle(10); // 新段首个 wheel 距上段末尾 = 24 + 10 + 16 = 50ms < 65ms
  c.g.onWheelPhaseBegin();
  c.stream(flick());
  c.g.onWheelPhaseEnd();
  c.idle(24);
  ok('29.3a 50ms 连滑被原生 began 分成两段，各切相邻一张',
    c.fired.length === 2 && c.fired[0].direction === 1 && c.fired[1].direction === 1 &&
      c.settles.length === 2,
    `fired=${JSON.stringify(c.fired.map((f) => f.direction))} settles=${c.settles.length}`);
  c.idle(200);
  ok('29.3b 连滑后没有残留结算 / 残留偏移',
    c.fired.length === 2 && c.g.swipeX === 0, `swipeX=${c.g.swipeX}`);

  // 29.4 同样的 50ms 连滑但没有原生 began：退回兜底，仍只切一张
  const d = harness({ viewW: 1000 });
  d.stream(flick());
  d.g.onWheelPhaseEnd();
  d.idle(24);
  d.idle(10);
  d.stream(flick());
  d.idle(200);
  ok('29.4 缺原生 began 时 settled 闸门照旧吞掉第二段（兜底未被绕过）',
    d.fired.length === 1, `fired=${d.fired.length}`);

  // 29.5 新的 began 必须把短刻度清掉：下一段没收到 ended 就回到 65ms 兜底
  const e = harness({ viewW: 1000 });
  e.stream(flick());
  e.g.onWheelPhaseEnd();
  e.idle(24);
  e.g.onWheelPhaseBegin();
  e.stream(new Array(10).fill(-60)); // 这一段故意不发 ended
  e.idle(64);
  ok('29.5a 新段没收到 ended 时 65ms 前不结算（短刻度没泄漏到下一段）',
    e.fired.length === 1, `fired=${e.fired.length}`);
  e.idle(2);
  ok('29.5b 新段在 65ms 兜底处照常结算', e.fired.length === 2,
    `fired=${e.fired.length}`);

  // 29.6 末张边界：原生相位不改动「只回弹、索引不动、轨道不动」
  const f = harness({ viewW: 1000, canSwipe: (dir) => dir < 0, step: (dir) => dir < 0 });
  const edgeInline = f.track.inline;
  f.stream(new Array(12).fill(-40));
  f.g.onWheelPhaseEnd();
  f.idle(24);
  ok('29.6 末张 + 原生 ended：仍只回弹，轨道恒基准、不切图',
    f.fired.length === 0 && f.settles.length === 1 &&
      f.settles[0].rebound === true && f.track.inline === edgeInline &&
      f.g.swipeX === 0,
    `fired=${f.fired.length} settles=${JSON.stringify(f.settles)} inline=${f.track.inline}`);
}

/* ---------------- 30. 慢滑复位的曲线交接（只改取消回弹） ---------------- */
// 快滑达标走补完（wheelLandTiming），根本不进 reboundWheelSwipe；只有慢滑未达标
// 与边界段会回弹。这里验证：上层算好的低速曲线被原样交给轨道动画、快滑路径
// 一行不动、回弹中连续滑动不重复触发 / 不残留、无上层计时信息时逐字退回旧值。
{
  const SLOW_EASE = 'cubic-bezier(0.333, 0.211, 0.667, 1)';
  const OLD_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';
  const slowTiming = () => ({ duration: 200, easing: SLOW_EASE });
  const lastAnim = (h) => h.track.anims[h.track.anims.length - 1];

  const slow = harness({ settleTiming: slowTiming });
  slow.stream([-6, -8, -10, -8, -6], 40);
  slow.idle(80);
  const slowAnim = lastAnim(slow);
  ok('30.1 慢滑回弹：上层低速曲线原样交给轨道动画，仍只回弹不切图',
    slow.fired.length === 0 && slow.settles.length === 1 &&
      slow.settles[0].rebound === true && slow.g.swipeX === 0 &&
      slowAnim?.duration === 200 && slowAnim?.easing === SLOW_EASE,
    `fired=${slow.fired.length} settles=${slow.settles.length} ` +
      `anim=${JSON.stringify(slowAnim && { duration: slowAnim.duration, easing: slowAnim.easing })}`);

  const fast = harness({ settleTiming: slowTiming });
  fast.stream(flick(), 16);
  fast.idle(80);
  ok('30.2 快滑达标走补完：只切一张、回弹动画一次都不播（快滑行为不变）',
    fast.fired.length === 1 && fast.settles.length === 1 &&
      fast.settles[0].rebound === false &&
      fast.track.anims.every((a) => a.easing !== SLOW_EASE),
    `fired=${fast.fired.length} settles=${JSON.stringify(fast.settles)} ` +
      `anims=${fast.track.anims.length}`);

  const cont = harness({ settleTiming: slowTiming });
  cont.stream([-12, -12, -12], 60);
  cont.idle(80);
  cont.push(-20, 0, 0); // 回弹没播完就再滑
  cont.idle(300);
  ok('30.3 慢滑回弹中连续再滑：两段各结算一次、无重复切换、无残留偏移',
    cont.fired.length === 0 && cont.settles.length === 2 &&
      cont.g.swipeX === 0 && cont.g.wheelSwipe.base === null &&
      cont.track.anims.length === 2 &&
      cont.track.anims.every((a) => a.easing === SLOW_EASE && a.duration === 200),
    `fired=${cont.fired.length} settles=${cont.settles.length} ` +
      `anims=${cont.track.anims.length} base=${cont.g.wheelSwipe.base}`);

  const legacy = harness();
  legacy.stream([-6, -8, -10, -8, -6], 40);
  legacy.idle(80);
  const legacyAnim = lastAnim(legacy);
  ok('30.4 无上层 timing 的替身逐字退回 200ms / EASE_SOFT（非 viewer 调用不受影响）',
    legacyAnim?.duration === 200 && legacyAnim?.easing === OLD_EASE,
    `anim=${JSON.stringify(legacyAnim && { duration: legacyAnim.duration, easing: legacyAnim.easing })}`);
}

/* ---------------- 31. 成对阈值基线 + 控制权显式释放 ---------------- */
// Swiper 的 thresholdDelta / thresholdTime 是**成对**的旋钮；本项目的时间刻度
// （65 / 24 / 60）必须与实测的位移节奏（段内 ≤37ms、连滑 58ms）一起判读，
// 单独调一个就会把「50~58ms 连滑」重新吞掉。这里把关系写成可执行断言。
{
  const num = (name) =>
    Number((gesturesSrc.match(new RegExp(`const ${name} = ([\\d.]+);`)) || [])[1]);
  const endMs = num('WHEEL_GESTURE_END_MS');
  const phaseMs = num('WHEEL_PHASE_SETTLE_MS');
  const retryMs = num('WHEEL_SETTLE_RETRY_MS');
  const maxMs = num('WHEEL_SETTLE_MAX_MS');
  const gapMs = num('WHEEL_GESTURE_GAP_MS');
  /** 2026-11-09 Swift 探针真机实测：段内 wheel 间隔上限 / 两次连滑的静默 */
  const INTRA_FRAME_MAX_MS = 37;
  const FAST_RELATCH_MS = 58;

  ok('31.1 24 < 37 < 58 < 65：短刻度不会段内提前结算，65ms 兜底会合并 58ms 连滑',
    phaseMs === 24 && endMs === 65 && retryMs === 60 && maxMs === 600 &&
      phaseMs < INTRA_FRAME_MAX_MS && INTRA_FRAME_MAX_MS < FAST_RELATCH_MS &&
      FAST_RELATCH_MS < endMs && retryMs < endMs && endMs < gapMs,
    JSON.stringify({ phaseMs, endMs, retryMs, maxMs, gapMs }));

  ok('31.2 时间刻度与位移/速度判据同源：65ms 同时管「新的一段」与「兜底结算」',
    /if \(sincePrev >= WHEEL_GESTURE_END_MS\)/.test(gesturesSrc) &&
      /WHEEL_PHASE_SETTLE_MS\s*:\s*WHEEL_GESTURE_END_MS/.test(gesturesSrc) &&
      /SWIPE_DISTANCE_RATIO/.test(gesturesSrc) &&
      /SWIPE_MIN_PX/.test(gesturesSrc) &&
      /SWIPE_VELOCITY/.test(gesturesSrc) &&
      /WHEEL_AXIS_LOCK_PX/.test(gesturesSrc) &&
      /WHEEL_SWIPE_DEADZONE/.test(gesturesSrc));

  // 失焦 = 交还 wheel 控制权：没有指针按着时旧实现会直接 return，结算定时器
  // 挂在后台到点仍会翻一页，回来后第一帧还沿用旧的 base / settled。
  const blurred = harness({ viewW: 1000 });
  blurred.stream(flick());
  blurred.g.abort();
  blurred.idle(200);
  ok('31.3 失焦释放：撤掉待结算定时器、不后台翻页、状态全清',
    blurred.fired.length === 0 && blurred.settles.length === 0 &&
      blurred.g._wheelSettle === 0 && blurred.g.wheelSwipe.x === 0 &&
      blurred.g.wheelSwipe.base === null && blurred.g.wheelSwipe.settled === false &&
      blurred.g.wheelSwipe.axis === null,
    JSON.stringify({ fired: blurred.fired.length, settles: blurred.settles.length,
      timer: blurred.g._wheelSettle, state: blurred.g.wheelSwipe }));

  // 回来之后重新起手仍是一次干净的一段（释放不是把交互锁死）。
  blurred.stream(flick());
  blurred.idle(80);
  ok('31.4 失焦后再滑：新的手势照常只切相邻一张，无残留偏移',
    blurred.fired.length === 1 && blurred.fired[0].direction === 1 &&
      blurred.settles.length === 1 && blurred.g.swipeX === 0,
    JSON.stringify({ fired: blurred.fired.length, settles: blurred.settles.length }));

  // ctrl+wheel 走同一个命名释放入口：同一次物理手势改判，不留在半张图上。
  const pinched = harness({ viewW: 1000 });
  pinched.stream(flick());
  pinched.g.handleWheelHorizontal(
    { deltaX: -20, deltaY: 0, ctrlKey: true, clientX: 700, clientY: 400,
      preventDefault() {} },
    -20, 0
  );
  pinched.idle(200);
  ok('31.5 ctrl+wheel 改判走同一释放入口：不结算、不切图、轴向作废',
    pinched.fired.length === 0 && pinched.settles.length === 0 &&
      pinched.g.wheelSwipe.axis === null && pinched.g.wheelSwipe.x === 0,
    JSON.stringify({ fired: pinched.fired.length, settles: pinched.settles.length }));
}

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 横向 wheel 一次一张 / 跟手 / 唯一结算 / 边界反弹 / 落位速度交接 检查全部通过');
