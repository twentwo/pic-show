/**
 * 手势控制器：滚轮 / 双击 / 双指捏合 / 拖拽平移 / 横滑切换 / 下拉关闭。
 *
 * 对外暴露三样东西：
 *   * `scale`、`tx`、`ty` —— 当前变换；
 *   * `onChange` —— 每次变换变化后回调（调用方用它同步 UI，如背景透明度）；
 *   * `animateTo()` —— 程序化动画（双击缩放、越界回弹、转场）。
 *
 * 内部维护两套平移量，这是关键：
 *   * `rawX/rawY` —— 「理想」平移，不含橡皮筋，是累加的基准；
 *   * `tx/ty`      —— 实际渲染用的平移 = clamp(raw) + rubberband(超出量)。
 * 分开存是为了避免橡皮筋位移被逐帧重复累加、导致越拖越偏。
 *
 * 两个变换目标（画廊模式下）：
 *   * `el`    —— 当前那张 slide，承载缩放 / 平移 / 下拉关闭；
 *   * `track` —— 横向轨道，承载左右滑动切换。
 * 一次手势只会写其中一个：未放大时按首次移动的方向在「横滑 / 下拉」里二选一，
 * 已放大时只能平移。事件统一挂在 track 上（它铺满视口），图片外的空白也能响应。
 *
 * 还有一条容易漏看的前提：**手指数 ≥ 2 就无条件进 pinch**（`updatePinch` 是
 * 双指唯一的去处），既不判轴向也不设阈值。双指横滑切图曾经存在过（由某个
 * `updateTwoFinger` 统一分发），因为和捏合共用同一份 scale/tx/ty、效果不好已经
 * 回退 —— 现在双指横向移动只会被当成捏合：间距变了就是缩放，没变就是平移，
 * 无论朝哪个方向、也无论是不是纯轴向。
 *
 * macOS 触控板的「双指横向滑动」是**另一条入口**，而且与上面这条毫无关系：
 *   多指手势在 DOM 里永远凑不出第二个 pointerId —— 它们在派发给页面之前就被
 *   系统翻译成了 wheel / ctrl+wheel / click。所以想接住触控板的双指横滑，只能
 *   看 wheel 的 deltaX（见 `handleWheelHorizontal`）。反过来，触屏上的双指是
 *   真·两个 pointer，那里的双指横向永远归 pinch，永不翻页。
 */

import { clamp, settle, zoomAround, isMostlyVertical, rubberband } from './geometry.js';

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_SOFT = 'cubic-bezier(0.33, 1, 0.68, 1)';

/** 橡皮筋允许的最大额外位移（px） */
const RUBBER = 140;
/** 松手后判定为「关闭」的位移阈值（视口高度的比例） */
const DISMISS_DISTANCE_RATIO = 0.2;
/** 松手后判定为「关闭」的速度阈值（px/ms） */
const DISMISS_VELOCITY = 0.55;
/**
 * 松手后判定为「切换」的位移阈值（视口宽度的比例）。
 *
 * 取比例的 1/5 而不是固定 px：同一个手势在 4K 屏和手机上才一致。
 * 0.22 是「画面已经明显拉开」的分界 —— 再大就得把整张拖掉一半才肯翻。
 * 与下面那条速度阈值是「或」的关系：慢慢挪过 1/5 屏翻，快速甩一下也翻。
 */
const SWIPE_DISTANCE_RATIO = 0.22;
/**
 * 松手后判定为「切换」的速度阈值（px/ms）。
 * 0.45 px/ms ≈ 60Hz 下一帧 27px，正好是「甩」与「拖」的分水岭；
 * 再低一点，慢慢移动也会被判成甩。必须与 `SWIPE_MIN_PX` 配套使用。
 */
const SWIPE_VELOCITY = 0.45;
/**
 * 只靠速度触发切换时的最小位移。
 * 有些设备/合成器会在一帧里丢出一个跨度很大的 pointermove，
 * 若只看「Δx ÷ Δt」会算出虚高的速度，手指几乎没动就被判成翻页。
 */
const SWIPE_MIN_PX = 28;
/** 已经到首尾时，横滑跟随的阻尼系数（还能拖，但明显拖不动） */
const SWIPE_EDGE_DAMP = 0.26;
/** 双击识别窗口 */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 26;
/** 超过这个距离才算拖拽，否则视为点击 */
const TAP_SLOP = 4;
/** 惯性衰减系数（每帧） */
const FLING_FRICTION = 0.93;
/**
 * 指针移动唤醒控件的最小间隔（ms）。
 * 高频鼠标一帧能塞进好几个 pointermove，而唤醒要 clearTimeout + setTimeout +
 * 改 class，没必要跟着鼠标事件一起刷 —— 节流到 ~8 次/秒，肉眼无差别。
 */
const MOTION_WAKE_MS = 120;

/** 触控板横向 wheel：横向增量必须比纵向大这么多，才认这一串是「在横滑」 */
const WHEEL_AXIS_RATIO = 1.7;
/**
 * 轴向判定要**累积**到这么多位移才下结论。
 *
 * 不能拿第一个事件定生死：触控板起手那一两帧常常是 `dx=3 / dy=4` 这种噪声，
 * `|dx| > 1.7·|dy|` 判不出来，旧代码那句 `else if (dy !== 0) axis = 'y'` 就把它
 * 钉成了纵向 —— 接下来整段横滑都被当成缩放丢掉，用户得再滑一次才有反应。
 * 观感正是「第一次滑不动、迟钝」。改看累积总和之后，几帧之内一定能判对，
 * 而 10px 的额外等待（不到一帧的位移量）肉眼无感。
 */
const WHEEL_AXIS_LOCK_PX = 10;
/**
 * 这么久没有新的 wheel 事件，就认为**这一段的流结束了**（相当于抬手）。
 *
 * 它同时是两个东西的刻度：既是「结算」的时机（流停下来这么久之后才判定要不要
 * 翻页），也是「下一段流」的起点（再次收到事件且间隔超过它 ⟹ 是新手势）。
 * 刻度必须一致 —— 若结算用 80ms、解锁用 180ms，中间那段就会出现「既不算写完、
 * 又不许重来」的窗口，表现正是「怎么滑都不动」。
 *
 * 取 65ms ≈ 60Hz 下 4 帧：macOS 的惯性尾巴按帧投递（8~16ms 一发），连丢 4 帧
 * 说明这一段真的停了；人抬手再落下则至少几百毫秒，两者分得开。这个值直接决定
 * 「松手 → 开始收尾」的延迟，上一版取 120ms，每次切图都白等两帧还有余。
 */
const WHEEL_GESTURE_END_MS = 65;
/**
 * 这一段没有 wheel 事件则认为换了手势（比"流结束"长得多，兜底用）。
 * 触控板「甩」一下会产出几十个事件（含惯性尾段），而人换一次手势至少要抬手
 * 再落下，远超这个量级。
 */
const WHEEL_GESTURE_GAP_MS = 600;
/**
 * 累积位移的前这段距离直接不计：双指虚按在触控板上会持续产出 1~2px 的噪点，
 * 跨过死区之后画面才开始跟着手指走。
 */
const WHEEL_SWIPE_DEADZONE = 8;
/**
 * 到首 / 末张时「累计行程」的夹取尺度（px）。
 *
 * 边界这一段轨道**一格都不动**，这个量只用来夹 `t.x`：惯性尾巴能把累计行程
 * 堆到几千 px，同段掉头时就得先抵消几千 px 才有反应。取 90 与旧阻尼同量级，
 * 反向最多回退两屏就能接上。
 */
const WHEEL_OVERSCROLL_RUBBER = 90;
/**
 * 边界弹性位移上限（px）：只写在**当前图**上，轨道与越界槽都不碰。
 *
 * 与键盘 / 按钮到头的 `NUDGE_PX`（22）同一量级：看得出「没有了」，又不会把
 * 背景拉出一大条。仍走 `wheelFollowOffset()` 渐近压缩，惯性尾巴再长也不越过。
 * 导出给 `viewer.js` 共用，免得两个模块各写一份、日后漂移。
 */
export const WHEEL_EDGE_RUBBER = 22;
/**
 * 跟手位移里 1:1 跟着手指走的比例，剩下的部分做橡皮筋压缩。
 *
 * 一次手势只允许切一张，画面就绝不能被推到「再下一张」那一格；但把累计位移
 * **硬夹**在一个数上，惯性尾巴后半段会完全没有视觉变化（手指还在推、画面像
 * 死住）。这里让前 75% 一屏内仍 1:1，之后渐近到 `视口宽 - 1`：既永不跨过
 * 第二张，又让整段流（含惯性尾巴）全程连续跟手。
 */
const WHEEL_FOLLOW_LINEAR_RATIO = 0.75;
/**
 * 结算时若碰上切换动画还在跑（`enabled === false`），隔这么久再试一次，
 * 而不是直接这一次手势丢掉。
 */
const WHEEL_SETTLE_RETRY_MS = 60;
/** 上面那个重试的总预算：超过就直接回弹，不能把轨道停在半张图上 */
const WHEEL_SETTLE_MAX_MS = 600;
/**
 * 原生 wheel 相位确认「这一段真的结束」后，留给最后几个 Web wheel 落地的
 * 收尾窗口（ms）。
 *
 * 真机 `momentum ended` 距该段最后一个 Web wheel 只有 0~17ms，Rust→viewer 的
 * 单程 IPC 实测 0~3ms —— 相位信号比 65ms 静默早约 48~65ms 到。这里再留一点
 * 余量让末尾那几帧（8~16ms 一发）计入累计，然后立即结算；没有原生相位事件时
 * （未开监视器 / 非 macOS / 权限缺失）这个刻度完全不生效，仍是原来的 65ms。
 * 它只换**结算时机**：触发判定、方向、位移、贴边、落位速度一律不动。
 */
const WHEEL_PHASE_SETTLE_MS = 24;
/**
 * 视口右边缘留给 macOS 通知中心的宽度。
 * 从右边缘起手的横向滑动系统会拉出通知中心，此时若我们也切图就成了「两头
 * 都响应」—— 抢不过系统，只能把这一片让出去。
 */
const EDGE_DEADZONE_PX = 48;

export class Gestures {
  constructor(el, opts) {
    this.el = el;
    this.o = {
      base: () => ({ w: 0, h: 0 }),
      view: () => ({ left: 0, top: 0, w: 0, h: 0 }),
      maxScale: 8,
      track: null,
      trackBase: () => 0,
      /**
       * 让调用方把「正在跑的轨道切换动画」就地结束，并返回画面当前停留的
       * 偏移量（相对中间槽基准）。不接管的话，那一笔跟手位移会被 WAAPI 的
       * 关键帧盖住 —— 见 `claimTrack()` 的注释。
       */
      claimTrack: null,
      /** 上一次实例的 `wheelSwipe`：切图会重建手势，本段状态要交接，见构造末尾 */
      wheelState: null,
      canSwipe: () => false,
      onChange: () => {},
      onDismissProgress: () => {},
      onDismissRelease: () => {},
      onSwipeRelease: () => {},
      /**
       * 单步同步换页原语，**当前 wheel 流不调用它**。保留接口是为了不牵动
       * `advanceBy` / `rebalance` / 预热那一串配套代码；一段连续横滑只在流停下
       * 时由 `onWheelSwipe` 结算一张，流中间绝不逐屏推进索引。
       */
      onWheelAdvance: () => true,
      /**
       * wheel 专用边界判定：目标方向是否还有**相邻的一张**。
       *
       * 与 `canSwipe` 分开是因为后者要照顾单指 / 键盘的循环开关（`loop`）；
       * 触控板横滑的契约是「到头不循环、不越界」，即使开了循环也只回弹。
       * 没接这个回调时回退到 `canSwipe`，便于纯逻辑用例模拟。
       */
      onWheelCanStep: null,
      /** 整段流的唯一结算点：切相邻一张（从当前跟手位置接着播），或回弹 */
      onWheelSwipe: () => {},
      /** 一段流结算完：通知调用方把当前项的原图 / 邻图补给上 */
      onWheelRest: () => {},
      /** 横滑方向一确定就通知（用来提前取/解码邻图），参数同 onWheelSwipe */
      onSwipeIntent: () => {},
      /**
       * 每一次横向跟手（写轨道 transform **之前**）：把当前跟手位移与视口宽
       * 交给上层，让「正从对应侧边缘进视口」的目标图贴住槽位近边、并确认
       * 那一槽装着目标图。回调只改槽内的图片对齐，不改轨道位移本身。
       */
      onWheelFollow: () => {},
      /**
       * 到首 / 末张时的边界跟手：参数是**当前图**的弹性位移（符号同 swipeX）。
       * 与 `onWheelFollow` 互斥：边界方向绝不碰越界槽、也绝不写轨道，只让当前
       * 图轻轻挪一下；流停下由 `onWheelSettle(true)` 弹回 0。
       */
      onWheelEdge: () => {},
      /**
       * 这一段流要收尾了：true = 回弹取消，false = 补完最后一张。上层据此把
       * 贴边 / 边界弹性偏移用与轨道收尾动画相同的时长/缓动同步归零，避免
       * 收尾时跳一下。
       */
      onWheelSettle: () => {},
      onTap: () => {},
      onDoubleTap: () => {},
      onUserActivity: () => {},
      ...opts
    };

    // 事件挂在哪：有 track 就挂 track（铺满视口），否则挂在变换目标本身
    this.host = this.o.track ?? el;

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.rawX = 0;
    this.rawY = 0;
    this.dismissProgress = 0;
    /** 相对轨道基准的额外横移（px），仅 swipe 模式使用 */
    this.swipeX = 0;
    /** 这一次「按下 → 抬起」是否已经消费过横滑（见 decideSwipeRelease） */
    this.swipeFired = false;

    this.pointers = new Map();
    this.start = null;
    this.moved = false;
    this.mode = null;
    this.dragging = false;
    this.anim = null;
    this.raf = 0;
    this.last = null;
    this.vel = { x: 0, y: 0 };
    this.lastTap = null;
    this._tapTimer = 0;
    this._lastMotion = 0;
    /** 横向 wheel 「流停了 → 结算」的定时器句柄，见 armWheelSettle */
    this._wheelSettle = 0;
    this.enabled = true;
    /**
     * 触控板横向 wheel 的累积状态，一次物理手势一份（见 handleWheelHorizontal）。
     * 可能由上一个实例交接而来：每次切换图片都会重建 Gestures，而对用户来说
     * 那一串 wheel 仍然是同一手势。
     */
    this.wheelSwipe = this.o.wheelState ?? freshWheelSwipe();

    this._onDown = (event) => this.onPointerDown(event);
    this._onMove = (event) => this.onPointerMove(event);
    this._onUp = (event) => this.onPointerUp(event);
    this._onCancel = (event) => this.onPointerCancel(event);
    this._onWheel = (event) => this.onWheel(event);
    this._onDbl = (event) => this.onDoubleClick(event);
    this._onBlur = () => this.abort();

    this.attach();
  }

  attach() {
    this.host.addEventListener('pointerdown', this._onDown);
    this.host.addEventListener('wheel', this._onWheel, { passive: false });
    this.host.addEventListener('dblclick', this._onDbl);
    // move / up 挂在 window 上：指针移出元素也不会丢失事件
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onCancel);
    // 窗口失焦 / 切到别的程序 / 最小化：指针序列会被系统截断，
    // pointerup 可能永远收不到 —— 必须有个兜底把状态清干净
    window.addEventListener('blur', this._onBlur);
  }

  detach() {
    this.host.removeEventListener('pointerdown', this._onDown);
    this.host.removeEventListener('wheel', this._onWheel);
    this.host.removeEventListener('dblclick', this._onDbl);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onCancel);
    window.removeEventListener('blur', this._onBlur);
    // 结算定时器也要跟着撤：它回调时会读 `this.o.track`，实例拆掉之后再跑
    // 就是在一个已经作废的对象上动了别人的轨道
    clearTimeout(this._wheelSettle);
    this._wheelSettle = 0;
    this.cancelAnim();
    this.resetPointerState();
  }

  /* ---------------- 状态 ---------------- */

  get isZoomed() {
    return this.scale > 1.02;
  }

  /**
   * 是否还有指针按着。
   *
   * 判断「正在交互」必须用这个，而不是 `dragging`：`dragging` 只是个标记，
   * 一旦某次 pointerup 丢失（窗口失焦、元素被移除、祖先被加了
   * `pointer-events:none`）它就再也不会复位；而 `pointers` 是真相来源，
   * 配合 blur / pointercancel 的兜底清理不会长期跑偏。
   */
  get busy() {
    return this.pointers.size > 0;
  }

  transformString() {
    return `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
  }

  apply() {
    this.el.style.transform = this.transformString();
    this.applyTrack();
  }

  /** 轨道只做水平位移；基准由调用方给（当前槽位对应的偏移） */
  applyTrack() {
    if (!this.o.track) return;
    const base = this.o.trackBase?.() ?? 0;
    this.o.track.style.transform = `translate3d(${base + this.swipeX}px, 0, 0)`;
  }

  /**
   * 轨道回弹 / 归位。
   *
   * 与 `viewer.animateTrack` 同一套提交方式：**起点**先写进 inline style，动画
   * `fill:'forwards'`，终点在 finished 里提交并 cancel。以前把终值先写进 inline、
   * 用 `fill:'none'` 靠关键帧盖住起点，收尾虽不闪回，但关键帧采样前那一帧显示的
   * 是 inline 的终点 —— 每次回弹都先「闪到终点再弹回起点」。起点落地之后两端都不跳。
   *
   * 被 `cancelAnim()`（下一段跟手 / 新的 pointerdown）掐掉时 `this.anim` 已经不是
   * 这一次，提交分支直接跳过，终值不会写回一个已经被接管的轨道。
   */
  animateTrackTo(swipeX, duration = 260, easing = EASE_OUT) {
    if (!this.o.track) return Promise.resolve();
    this.cancelAnim();

    const base = this.o.trackBase?.() ?? 0;
    const from = `translate3d(${base + this.swipeX}px, 0, 0)`;
    const to = `translate3d(${base + swipeX}px, 0, 0)`;

    this.swipeX = swipeX;
    this.o.track.style.transform = from;

    if (duration <= 0 || from === to) {
      this.o.track.style.transform = to;
      return Promise.resolve();
    }

    const anim = this.o.track.animate(
      { transform: [from, to] },
      { duration, easing, fill: 'forwards' }
    );
    this.anim = anim;

    return anim.finished
      .then(() => {
        if (this.anim !== anim) return;
        this.o.track.style.transform = to;
        try {
          anim.cancel();
        } catch {
          /* 已结束的动画忽略 */
        }
        this.anim = null;
      })
      .catch(() => {
        if (this.anim === anim) this.anim = null;
      });
  }

  emit() {
    this.o.onChange(this);
  }

  /** 无动画直接落位 */
  commit({ scale, tx, ty }) {
    this.scale = scale;
    this.tx = tx;
    this.ty = ty;
    this.rawX = tx;
    this.rawY = ty;
    this.swipeX = 0;
    this.apply();
    this.emit();
  }

  /**
   * 动画到目标变换（**当前 slide 的缩放 / 平移**，不是轨道位移）。
   * 技巧：动画一开始就先把终值写进 inline style；动画 fill:'none'，
   * 结束后样式自然接续，不会出现「闪回起点」的那一帧。
   *
   * 注意与轨道落位 / 回弹（`viewer.animateTrack()` / `animateTrackTo()`）区分：
   * 那两条跑在同一个 track 上、随时会被下一段手势接管，所以必须**起点**落地 +
   * `fill:'forwards'` + finished 提交终值；这里没有接管问题，终值预写反而最省事。
   */
  animateTo({ scale, tx, ty }, duration = 260, easing = EASE_OUT) {
    this.cancelAnim();

    const from = this.transformString();
    const to = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;

    this.scale = scale;
    this.tx = tx;
    this.ty = ty;
    this.rawX = tx;
    this.rawY = ty;
    this.dismissProgress = 0;

    if (duration <= 0 || from === to) {
      this.apply();
      this.emit();
      return Promise.resolve();
    }

    const anim = this.el.animate(
      { transform: [from, to] },
      { duration, easing, fill: 'none' }
    );
    this.anim = anim;
    this.apply();
    this.emit();

    return anim.finished
      .then(() => {
        this.anim = null;
      })
      .catch(() => {});
  }

  /** 越界回弹。缩放本身越界（捏合缩得比适配尺寸还小）时一并拉回 1。 */
  springBack() {
    const view = this.o.view();
    const base = this.o.base();
    const scale = this.scale < 1 ? 1 : this.scale;
    const bounds = panBoundsOf(view, base, scale);
    const cx = clamp(this.rawX, -bounds.maxX, bounds.maxX);
    const cy = clamp(this.rawY, -bounds.maxY, bounds.maxY);
    this.dismissProgress = 0;
    return this.animateTo({ scale, tx: cx, ty: cy }, 340, EASE_SOFT);
  }

  /**
   * 容器尺寸变化后重新收敛。
   *
   * 注意**不能**用 `reset()`：那会把用户手动放大的倍率一起丢掉，
   * 拖一下窗口就跳回 100% 很突兀。正确做法是保留倍率（只夹到新的
   * 上限内），把平移重新夹进新的边界 —— 内容变小了自然回到居中。
   */
  refit({ base, view, maxScale }) {
    if (maxScale != null) this.o.maxScale = maxScale;
    const scale = clamp(this.scale, 1, Math.max(1, this.o.maxScale));
    const bounds = panBoundsOf(view, base, scale);
    const tx = clamp(this.rawX, -bounds.maxX, bounds.maxX);
    const ty = clamp(this.rawY, -bounds.maxY, bounds.maxY);
    this.swipeX = 0;
    this.commit({ scale, tx, ty });
  }

  /**
   * 连续换页后把「变换目标」指向新的当前槽，**不重建实例**。
   *
   * 事件监听挂在 `track`（铺满视口）上，与 `el` 无关；横滑本身也只写 track。
   * 但换页之后当前 slide 换了，后续任何缩放 / 平移 / 回弹必须落在新的那张上
   * —— 若不换，手势会一直作用在已经轮转到视口外的旧槽上。
   *
   * 不直接重建 `Gestures`：连续流里每跨一张都重建一次，正是「连续快滑卡顿、
   * 反馈延迟累积」的来源。
   */
  retarget(el) {
    if (el && el !== this.el) this.el = el;
  }

  /** 回到适配尺寸 */
  reset(animate = true) {
    this.rawX = 0;
    this.rawY = 0;
    this.swipeX = 0;
    this.dismissProgress = 0;
    return this.animateTo(
      { scale: 1, tx: 0, ty: 0 },
      animate ? 280 : 0,
      EASE_OUT
    );
  }

  /** 以 p（视口中心为原点）为锚点缩放 */
  zoomTo(scale, p, animate = true) {
    const view = this.o.view();
    const base = this.o.base();
    const maxScale = Math.max(1, this.o.maxScale);
    const next = clamp(scale, 1, maxScale);
    const ratio = next / this.scale;

    const t = zoomAround({ x: this.tx, y: this.ty }, p, ratio);
    this.rawX = t.x;
    this.rawY = t.y;

    const st = settle(view, base, next, this.rawX, this.rawY, RUBBER);
    const target = { scale: next, tx: st.x, ty: st.y };

    return animate ? this.animateTo(target, 280, EASE_OUT) : this.commit(target);
  }

  zoomBy(ratio, p = { x: 0, y: 0 }) {
    return this.zoomTo(this.scale * ratio, p, false);
  }

  cancelAnim() {
    if (this.anim) {
      try {
        this.anim.cancel();
      } catch {
        /* 已结束的动画忽略 */
      }
      this.anim = null;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /* ---------------- 指针 ---------------- */

  onPointerDown(event) {
    // 先唤醒控件：切图动画期间 `enabled` 是关的，那时也要能唤醒，
    // 守卫得排在它后面
    this.o.onUserActivity?.();
    // 切图 / 展开 / 关闭的动画期间不接受新手势。
    // 少了这道闸门会留下一个死角：那时 `viewer.go()` 会因为 `switching` 直接
    // 返回，而这一次松手又会走回弹 —— 结果 track 停在了半张图的位置，只能靠
    // 再翻一页或改窗口尺寸自愈。
    if (!this.enabled) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.cancelAnim();
    this.dragging = true;

    if (this.pointers.size === 1) {
      this.start = {
        x: event.clientX,
        y: event.clientY,
        rawX: this.rawX,
        rawY: this.rawY
      };
      this.last = { x: event.clientX, y: event.clientY, t: performance.now() };
      this.vel = { x: 0, y: 0 };
      this.moved = false;
      /** 这一次「按下 → 抬起」是否已经切过一张（见 decideSwipeRelease） */
      this.swipeFired = false;
      // 放大状态下只能平移；未放大时先不决定，等第一次移动再判断方向
      this.mode = this.isZoomed ? 'pan' : 'undecided';
      try {
        this.host.setPointerCapture(event.pointerId);
      } catch {
        /* 某些浏览器对鼠标事件不支持捕获 */
      }
    } else if (this.pointers.size === 2) {
      this.moved = true; // 已进入多指，后续不再判定为点击
      this.beginPinch();
    }

    this.emit();
  }

  /**
   * 指针移动唤醒控件（节流到 `MOTION_WAKE_MS`）。
   *
   * 这一步不能省：空闲状态下 CSS 会把 `cursor` 设成 `none`，指针彻底不可见。
   * 如果只有 pointerdown / wheel / dblclick 能唤醒，那用户移动鼠标时屏幕上
   * 什么都不会发生 —— 观感就是「鼠标动不了、界面卡死了」。
   * 移动是最高频的交互，所以必须节流，不能每次事件都去续期计时器。
   */
  noteMotion() {
    const now = performance.now();
    if (now - this._lastMotion < MOTION_WAKE_MS) return;
    this._lastMotion = now;
    this.o.onUserActivity?.();
  }

  /**
   * 强制收尾：指针序列被系统截断（失焦、最小化、切程序）或元素即将被移除时调用。
   *
   * 不清干净的话 `pointers` 会一直留着那个 pointerId，之后每次 pointermove
   * 都会通过 `pointers.has(id)` 走进拖拽分支 —— 即使鼠标早就松开了，画面
   * 也会一直「粘」在指针上；而且 `dragging` 恒为 true 会让 `Viewer.onResize()`
   * 永远跳过手势收敛，改窗口尺寸后图片就不再重新适配。
   */
  abort() {
    if (this.pointers.size === 0) return;
    this.resetPointerState();
    this.cancelAnim();
    this.springBack();
    this.emit();
  }

  resetPointerState() {
    this.pointers.clear();
    this.dragging = false;
    this.moved = false;
    this.start = null;
    this.mode = null;
    this.last = null;
    this.vel = { x: 0, y: 0 };
    /** 这一次「按下 → 抬起」是否已经消费过横滑（见 decideSwipeRelease） */
    this.swipeFired = false;
  }

  onPointerMove(event) {
    // 无论是否按着，指针一动就把控件叫醒（见 noteMotion 注释）
    this.noteMotion();

    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size >= 2) {
      event.preventDefault();
      this.updatePinch();
      return;
    }

    const start = this.start;
    if (!start) return;

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (!this.moved && Math.hypot(dx, dy) > TAP_SLOP) {
      this.moved = true;
      if (this.isZoomed) this.mode = 'pan';
      else if (isMostlyVertical(dx, dy)) this.mode = 'dismiss';
      else this.mode = this.o.track ? 'swipe' : 'pan';
    }
    if (!this.moved) return;

    event.preventDefault();

    // 速度平滑（px/ms）
    const now = performance.now();
    const prev = this.last ?? { x: start.x, y: start.y, t: now - 16 };
    // 下限 4ms：同一毫秒里挤进来的多个 move 会算出离谱的速度
    const dt = Math.max(4, now - prev.t);
    this.vel.x = this.vel.x * 0.6 + ((event.clientX - prev.x) / dt) * 0.4;
    this.vel.y = this.vel.y * 0.6 + ((event.clientY - prev.y) / dt) * 0.4;
    this.last = { x: event.clientX, y: event.clientY, t: now };

    const view = this.o.view();
    const base = this.o.base();

    if (this.mode === 'dismiss') {
      const distance = Math.hypot(dx, dy);
      this.dismissProgress = Math.min(1, distance / (view.h * 0.55));
      this.scale = 1 - this.dismissProgress * 0.4;
      this.tx = dx * 0.9;
      this.ty = dy * 0.9;
      this.rawX = this.tx;
      this.rawY = this.ty;
      this.o.onDismissProgress(this.dismissProgress);
    } else if (this.mode === 'swipe') {
      // 手指向左拖（dx < 0）→ 看下一张。到首尾只剩阻尼，告诉用户「没了」
      const direction = dx < 0 ? 1 : -1;
      const damping = this.o.canSwipe?.(direction) ? 1 : SWIPE_EDGE_DAMP;
      this.swipeX = dx * damping;
    } else {
      this.rawX = start.rawX + dx;
      this.rawY = start.rawY + dy;
      const st = settle(view, base, this.scale, this.rawX, this.rawY, RUBBER);
      this.tx = st.x;
      this.ty = st.y;
    }

    this.apply();
    this.emit();
  }

  onPointerUp(event) {
    if (!this.pointers.delete(event.pointerId)) return;
    this.dragging = false;

    // 捏合中松开一根（2 → 1）：以剩下那根重建单指基准。
    // 这里曾经调的是 beginPinch()，但它对「只剩一根」是直接 return 的空操作
    // —— 基准和 mode 于是永远停在捏合那一刻，见 releasePinch()。
    if (this.pointers.size === 1) {
      this.releasePinch();
      return;
    }
    if (this.pointers.size > 1) return;

    if (!this.moved) {
      this.handleTap(event.clientX, event.clientY);
      this.mode = null;
      this.emit();
      return;
    }

    if (this.mode === 'dismiss') {
      const dy = event.clientY - this.start.y;
      const shouldClose =
        Math.abs(dy) > window.innerHeight * DISMISS_DISTANCE_RATIO ||
        Math.abs(this.vel.y) > DISMISS_VELOCITY;
      this.o.onDismissRelease(shouldClose);
    } else if (this.mode === 'swipe') {
      this.decideSwipeRelease(event.clientX);
    } else {
      const speed = Math.hypot(this.vel.x, this.vel.y);
      if (speed > 0.08) this.fling();
      else this.springBack();
    }

    this.mode = null;
    this.emit();
  }

  /**
   * 单指横滑的松手判定：**一次「按下 → 抬起」最多只换一张**。
   *
   * 判据是「位移」与「瞬时速度」二者取或，命中任意一条即认为这次手势成立：
   *   * 位移 —— 拖过视口宽的 `SWIPE_DISTANCE_RATIO`（22%，约 1/5 屏）。
   *     按屏幕比例而不是固定 px：同一个手势在 4K 屏和手机上才一致；
   *     22% 是「看得出来已经拉过半张了吗」的分界，再大就成了必须拖半屏。
   *   * 速度 —— `SWIPE_VELOCITY`（0.45 px/ms ≈ 60Hz 下 27px/帧）的甩动，
   *     且必须同时满足 `SWIPE_MIN_PX`（28px）的最小位移：某些合成器会在一帧
   *     里丢出一个跨度很大的 pointermove，只看 Δx/Δt 会算出虚高的速度。
   *
   * 命中之后立刻把 `swipeFired` 置起来 —— 这是本次手势的**消费凭证**。切换
   * 是「松手翻一张」，一次手势里这里只会走一次，这条标记是给将来任何想在
   * 拖拽过程中提前触发的路径留的闸门：没有它，位移基准不重置就会一路达标。
   *
   * 其余情况（没达标、已经到首尾、切换动画期间松手）一律走回弹：轨道必须回到
   * 0，否则会停在「两张图各露一半」的位置下不去。
   *
   * @param {number} clientX 松手时的指针横坐标
   */
  decideSwipeRelease(clientX) {
    const start = this.start;
    if (!start) return;

    const dx = clientX - start.x;
    const direction = dx < 0 ? 1 : -1; // 手指向左拖 → 下一张
    const far = Math.abs(dx) > this.o.view().w * SWIPE_DISTANCE_RATIO;
    const fast =
      Math.abs(dx) > SWIPE_MIN_PX && Math.abs(this.vel.x) > SWIPE_VELOCITY;

    if (this.swipeFired || !this.enabled || !(far || fast) || !this.o.canSwipe?.(direction)) {
      this.animateTrackTo(0, 280, EASE_SOFT);
      return;
    }

    this.swipeFired = true;
    // 交给调用方接着手指的当前位置播完剩下的位移
    this.o.onSwipeRelease(direction);
  }

  onPointerCancel(event) {
    this.pointers.delete(event.pointerId);
    this.dragging = false;
    if (this.pointers.size === 0) {
      if (this.mode === 'dismiss') this.o.onDismissRelease(false);
      else if (this.mode === 'swipe') this.animateTrackTo(0, 280, EASE_SOFT);
      else this.springBack();
      this.mode = null;
      this.emit();
    }
  }

  handleTap(x, y) {
    const now = performance.now();
    const isDouble =
      this.lastTap &&
      now - this.lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_TAP_SLOP;

    if (isDouble) {
      this.lastTap = null;
      clearTimeout(this._tapTimer);
      this.o.onDoubleTap(x, y);
    } else {
      this.lastTap = { x, y, t: now };
      // 延迟一拍再当单击处理，给双击留出识别窗口
      clearTimeout(this._tapTimer);
      this._tapTimer = setTimeout(() => {
        if (this.lastTap && this.lastTap.t === now) this.o.onTap(x, y);
      }, DOUBLE_TAP_MS);
    }
  }

  /* ---------------- 捏合 ---------------- */

  beginPinch() {
    const pts = [...this.pointers.values()].slice(0, 2);
    if (pts.length < 2) return;
    const view = this.o.view();

    // 单指横滑中途落下第二根手指：横滑就此作废，轨道必须归位。
    // pinch 全程只写缩放/平移、不碰 swipeX，不清的话那截偏移会一直挂在
    // 轨道上 —— 松手后画面停在「半张图」的位置，只能靠再翻一页（go 里会
    // 清 swipeX）或改窗口尺寸（refit）才自愈。
    if (this.swipeX !== 0) {
      this.animateTrackTo(0, 260, EASE_SOFT);
    }

    this.mode = 'pinch';
    this.pinch = {
      d0: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      m0: {
        x: (pts[0].x + pts[1].x) / 2 - (view.left + view.w / 2),
        y: (pts[0].y + pts[1].y) / 2 - (view.top + view.h / 2)
      },
      scale0: this.scale,
      t0: { x: this.rawX, y: this.rawY }
    };
  }

  /**
   * 捏合中抬起一根手指：把剩下那根当成一次全新的单指拖拽。
   *
   * 少了这一步会留下两个隐患（捏合期间没人管这两件事）：
   *   1. `start` 还停在**最初那根**手指的落点，而活下来的若是另一根，下一次
   *      移动算出的 dx 里会混进「两指间距」—— 画面瞬间跳几百 px；
   *   2. `mode` 卡在 'pinch'，可 `onPointerMove` 里根本没有 pinch 分支，于是
   *      静默落进通用 pan：行为看着能用，状态却是错的（连 `is-grabbing`
   *      这类靠 mode 判断的反馈都会失真）。
   *
   * 一律判为 'pan'，而不是交回 'undecided' 让首个移动再定方向：捏合刚结束时
   * 手指本来就带着余速，缩回适配尺寸后随手一划就被判成翻页太容易了。
   */
  releasePinch() {
    const remaining = [...this.pointers.values()][0];
    if (!remaining) return;

    this.start = {
      x: remaining.x,
      y: remaining.y,
      rawX: this.rawX,
      rawY: this.rawY
    };
    this.last = { x: remaining.x, y: remaining.y, t: performance.now() };
    this.vel = { x: 0, y: 0 };
    this.moved = true;
    this.mode = 'pan';
    this.pinch = null;
  }

  /* ---------------- 捏合续：每帧更新（双指唯一的去处） ---------------- */

  updatePinch() {
    if (!this.pinch) return;
    const pts = [...this.pointers.values()].slice(0, 2);
    const view = this.o.view();
    const base = this.o.base();
    const maxScale = Math.max(1, this.o.maxScale);

    const distance = Math.max(
      1,
      Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
    );
    const mid = {
      x: (pts[0].x + pts[1].x) / 2 - (view.left + view.w / 2),
      y: (pts[0].y + pts[1].y) / 2 - (view.top + view.h / 2)
    };

    const ratio = distance / this.pinch.d0;
    const next = clamp(this.pinch.scale0 * ratio, 0.5, maxScale * 1.3);
    const r = next / this.pinch.scale0;

    // 缩放锚在初始中点，同时跟随中点的整体位移
    this.rawX = mid.x - (this.pinch.m0.x - this.pinch.t0.x) * r;
    this.rawY = mid.y - (this.pinch.m0.y - this.pinch.t0.y) * r;

    const st = settle(view, base, next, this.rawX, this.rawY, RUBBER);
    this.scale = next;
    this.tx = st.x;
    this.ty = st.y;
    this.apply();
    this.emit();
  }

  /* ---------------- 滚轮 ---------------- */

  /**
   * 滚轮 / 触控板。
   *
   * 纵向（ `|deltaY|` 主导）= 缩放，这是自始就有的行为。
   * 横向（`|deltaX|` 主导）= 触控板双指横滑 → 切换上一张 / 下一张（未放大），
   * 或者横向平移（已放大）。这条新分支必须排在缩放**之前**：一次 wheel 序列
   * 只允许一种归属，否则斜向滑会一边缩放一边连翻好几张。
   */
  onWheel(event) {
    // 「滚动方向：自然」关掉时 delta 是整台翻转的，先归一化成手势方向，
    // 「向左划」在每台机器上才是同一个意思（见 wheelSign）
    const sign = wheelSign(event);
    const dx = normalizeWheel(event, 'x') * sign;
    const dy = normalizeWheel(event, 'y') * sign;

    // 唤醒控件要走节流：触控板流每秒上百个事件，每个都去
    // clearTimeout/setTimeout + 改 class，等于自己给自己制造主线程负载
    this.noteMotion();
    // 横向判定必须排在 `enabled` 闸门**之前**：切换 / 展开动画那几百毫秒里
    // `viewer.go()` 会把 enabled 关掉，但同一段流并没有跟着停 —— 那段时间若
    // 完全不记账，解锁判据会被误判成「早就结束了」。
    if (this.handleWheelHorizontal(event, dx, dy)) return;

    if (!this.enabled) return;

    this.cancelAnim();
    // 只有真正要消费的方向才阻止默认行为 —— 不消费时要还给系统
    event.preventDefault();

    const view = this.o.view();
    // 触控板捏合在浏览器里表现为 ctrlKey=true 的 wheel 事件
    const intensity = event.ctrlKey ? 0.012 : 0.0022;
    const ratio = Math.exp(-dy * intensity);
    const p = {
      x: event.clientX - (view.left + view.w / 2),
      y: event.clientY - (view.top + view.h / 2)
    };
    this.zoomBy(ratio, p);
  }

  /**
   * 触控板双指横向滑动 → **一次完整的 wheel 事件流**（未放大）/ 横向平移（已放大）。
   *
   * 为什么在这里而不是 pinch 分支里：Mac 的多指手势到 DOM 之前就被系统翻译
   * 成了 wheel / ctrl+wheel / click，`pointers.size >= 2` 那条 pinch 分支在
   * 触控板上永远进不去 —— 想在 Mac 上接住双指横滑，只有 wheel 这一个入口。
   *
   * 方向约定与其他入口一致：内容跟着手指走。deltaX > 0 表示内容向左移动
   * （等同于手指向左划）→ 下一张。
   *
   * **一次滑动 = 从起手到流停下的一整段 wheel 事件，最多切相邻一张。**
   * `t.x` 全程记真实行程用于跟手，但流中间**不换页**：显示位移经
   * `wheelFollowOffset()` 渐近压缩到不足一屏，画面够不到再下一张。目标方向
   * 已经没有图（首张 / 末张）时整段**不动轨道**、也不碰越界槽，只给当前图
   * 一点弹性位移（见 `wheelEdgeFollow`）。索引唯一可能变化的地方是
   * `settleWheelSwipe` —— 流真正停下来时按最终位置 / 峰值速度判「切一张」或
   * 「回弹」，并由 `settled` 闸门保证整段只结算一次。连续事件、惯性尾巴、
   * 重复回调都不会跨多张或多翻。
   *
   * @returns {boolean} true = 这次输入已被横向路径认领，调用方不要再当纵向处理。
   *   注意「认领」不等于「消费」：还在虚按噪点里时不调用 preventDefault，
   *   没有被这一条用掉的方向依旧还给浏览器。
   */
  handleWheelHorizontal(event, dx, dy) {
    const now = performance.now();
    const prev = this.wheelSwipe;
    const sincePrev = now - prev.at;

    // 静置太久 → 换了手势，累积、速度、结算标记全部作废。
    // 顺序要紧：必须在**重新取** this.wheelSwipe 之前重置，否则 s 会指向刚被
    // 丢掉的那个对象 —— 每个事件都从 0 开始累加，位移永远攒不够。
    if (sincePrev > WHEEL_GESTURE_GAP_MS) this.resetWheelSwipe();
    const s = this.wheelSwipe;
    s.at = now;

    // 静默超过「流结束」的刻度（65ms）—— 与结算用的是同一个刻度，所以这一刻
    // 上一段手势必然已经结算过（补完一张或回弹）。位移、速度、接管偏移都要
    // 作废：`base` 残留会让下一段不再接管新动画、跟手错开一屏；`peakV` 残留
    // 会让慢慢拖被上一段的峰值判成「甩」。
    // 轴向与视口宽特意留着：手还是同一类滑动，没必要再攒 10px 判一次轴。
    // 65~600ms 正是「抬手之后马上又滑」的常态，漏掉就是「第二下不跟手」。
    // 静默够久 = 新的一次滑动：`clearWheelProgress()` 只清累计（结算时也要用），
    // 结算闸门必须在这里单独复位，否则抬手再滑会被上一段的尾巴挡住。
    if (sincePrev >= WHEEL_GESTURE_END_MS) {
      this.clearWheelProgress();
      s.settled = false;
      s.dir = 0;
      s.phaseEnded = false;
    }

    // 触控板捏合 / 旋转是 ctrl+wheel，与横滑互斥：改间距和横移是同一次
    // 物理手势的两种解读，一次只认一种
    if (event.ctrlKey) {
      this.resetWheelSwipe();
      return false;
    }
    // 右边缘属于 macOS 通知中心，那里的横向滑动两头都会响应 —— 让给系统
    if (window.innerWidth - event.clientX <= EDGE_DEADZONE_PX) {
      this.resetWheelSwipe();
      return false;
    }

    // 轴向归属：看**累积**，不看单帧（见 WHEEL_AXIS_LOCK_PX）。
    // 判不出来之前两个方向都不认，也不消费默认行为 —— 装死的这一两帧比
    // 「误判成纵向、整段横滑被吃掉」便宜得多。
    if (s.axis === null) {
      s.ax += dx;
      s.ay += dy;
      if (Math.max(Math.abs(s.ax), Math.abs(s.ay)) < WHEEL_AXIS_LOCK_PX) return true;
      s.axis = Math.abs(s.ax) > WHEEL_AXIS_RATIO * Math.abs(s.ay) ? 'x' : 'y';
      if (s.axis === 'x') {
        // 判定之前那几帧的位移要补进来（减掉当前这一帧，下面统一再加），
        // 否则跟手会从 10px 处才开始，起手就慢半拍
        s.x = s.ax - dx;
        s.viewW = this.o.view().w;
      }
    }
    if (s.axis !== 'x') return false;

    // 这一段已经结算完，后面还在 65ms 内到达的事件是同一次手势的惯性尾巴：
    // 认领但不记账、不写轨道、不重排结算。否则尾巴会再推一次画面（停在半张图
    // 上），或等定时器到点又触发一次 `onWheelSwipe`（一次手势翻两张）。
    if (s.settled) {
      event.preventDefault();
      return true;
    }

    const t = this.wheelSwipe;
    t.x += dx;
    // 速度与单指同一套平滑（px/ms）。dt 直接取事件间隔，夹在 8~64ms：8ms 是
    // 120Hz 触控板的最短帧距，夹住它能滤掉「同一毫秒里挤进来的两个事件」算出
    // 的虚高速度（那会让慢拖在某一帧突然被判成甩）；上限 64ms 则防止跨了一段
    // 静默的两个事件算出虚低的低速。
    const dt = clamp(sincePrev, 8, 64);
    t.vx = t.vx * 0.6 + (dx / dt) * 0.4;
    t.peakV = Math.max(t.peakV, Math.abs(t.vx));

    // 已放大：横向的含义是「拖动画面」，不是翻页
    if (this.isZoomed) {
      this.cancelAnim();
      event.preventDefault();
      this.panByWheelX(dx);
      return true;
    }

    // 一张图时横向没有任何意义，连回弹都别给 —— 邻槽是空的，回弹会把黑边拉出来
    if (!this.o.canSwipe?.(1) && !this.o.canSwipe?.(-1)) return true;

    event.preventDefault();

    // 还在虚按噪点里 → 只记账，画面不动。
    // 已经接管过切换动画的除外：那时画面正停在两张图中间，每一帧都必须把
    // 位置写回去，否则会退回一整档。
    if (Math.abs(t.x) <= WHEEL_SWIPE_DEADZONE && t.base === null) {
      this.armWheelSettle();
      return true;
    }

    const viewW = s.viewW || (s.viewW = this.o.view().w);

    // 边界判定必须排在**接管之前**：`claimTrack()` 会就地取消切图动画并把轨道
    // 写回中间槽基准，那一刻恰好是「末张露出下一张边缘」的一帧；而到头这一段
    // 本来就不该动轨道，接管纯属多余。方向只看这一段真实推过去的行程（已接管
    // 时含残余基准），不读 computed —— 跟手热路径不许碰布局。
    const indicated = t.x + (t.base ?? 0);
    const edgeDir = indicated < 0 ? 1 : -1; // 手指向左 → 下一张
    const edgeCanStep =
      this.o.onWheelCanStep?.(edgeDir) ?? this.o.canSwipe?.(edgeDir) ?? true;

    if (!edgeCanStep) {
      // ---- 到首 / 末张：轨道一格都不动，越界槽一概不画 ------------------
      // 旧实现把 90px 阻尼写进轨道，并让 followWheelSeam() 给越界槽（装着当前
      // 图副本）贴边 —— 从右边缘进来的其实是同一张图，看着正是「末张进入下一
      // 张的过渡状态」。现在整段只给当前图一点弹性位移，流停下由
      // onWheelSettle → releaseWheelSeam 弹回 0。循环开关不参与：到头就是到头。
      const cap = WHEEL_OVERSCROLL_RUBBER * 2;
      if (Math.abs(indicated) > cap) {
        t.x = Math.sign(indicated) * cap - (t.base ?? 0);
      }
      // 起手方向只记一次：中途掉头要靠「反向位移重新达标」才算数
      if (!t.dir) t.dir = edgeDir;
      this.wheelEdgeFollow(t.x + (t.base ?? 0));
      return true;
    }

    // ---- 正常方向：接管 → 跟手 -----------------------------------------
    // 写样式之前必须先把「画面此刻停在哪」接过来 —— 有两类动画会盖住这一帧
    // 要写的位移，而它们的当前位置**只能从 computed 里读**（WAAPI 关键帧
    // 优先级高于内联样式，直接 cancel 会让视觉瞬间掉回内联值）：
    //   * 本实例上一次没达标的回弹（`this.anim`）：掐掉它会把那段没走完的位移
    //     整段丢掉、画面往回跳一下；
    //   * viewer 的切图收尾动画（跑在同一个 track 上，`this.anim` 够不到它）：
    //     连续切换时用户往往在上一次收尾还没播完就再次起手，那一段跟手位移会
    //     整段被关键帧吞掉。
    // 一段手势只接管一次：接管之后基准已经固化，再滑就纯粹是本段的位移。
    let carried = 0;
    if (this.anim) {
      carried = this.trackVisualOffset();
      this.cancelAnim();
    }
    if (t.base === null) {
      const claimed = this.o.claimTrack?.();
      t.base = claimed != null ? claimed : carried;
    }

    // ---- 一次滑动只切一张：流中间只跟手，绝不换页 ----------------------
    // `t.base + t.x` 保留真实行程（反过来滑时不会被「已扣掉的整屏」拖住），
    // 只有**写进轨道的位移**被压缩到不足一屏：轨道只有三个槽，超过一屏就会
    // 把再下一张（甚至黑边）拉进视口，与「最多一张」的结果自相矛盾。
    // 整段流的唯一结算点是 `settleWheelSwipe`（流停下那一刻），命中也只走
    // `onWheelSwipe → go(direction)` 一次。
    const rawShown = t.base + t.x;
    const direction = rawShown < 0 ? 1 : -1;
    // 正常路径沿用接管后的方向记起手（与改动前逐字一致）；边界路径在前面
    // 已用本段行程方向记过，这里不会覆盖它。
    if (!t.dir) t.dir = direction;
    const canStep = this.o.onWheelCanStep?.(direction) ?? this.o.canSwipe?.(direction) ?? true;
    const limit = canStep ? viewW : WHEEL_OVERSCROLL_RUBBER + 1;

    // 累计不许无限堆：惯性尾巴能把行程堆到几千 px，反向时就得先把这几千 px
    // 全抵消才换得了方向（「掉头不跟手」）。夹到两屏既留足了压缩函数渐近变化
    // 的区间（画面全程还在动），又让反向最多回退两屏就能响应。
    const travelCap = limit * 2;
    if (Math.abs(rawShown) > travelCap) {
      t.x = Math.sign(rawShown) * travelCap - t.base;
    }
    const shown = t.base + t.x;

    // 接管之后方向可能被残余基准翻到「没有图」那一侧（极少见：上一次切图
    // 收尾没播完就反向起手）。此时同样不许把越界槽拉进视口 —— 与上面的
    // 边界分支走同一条弹性路径，轨道停在基准。
    if (!canStep) {
      this.wheelEdgeFollow(shown);
      return true;
    }

    this.swipeX = this.wheelFollowOffset(shown, limit);
    // 目标图必须在「第一次写轨道 transform」之前就已经贴住对应侧边缘：起手
    // 第一帧就要看得见它跟着手指进来，而不是等跨满一屏 / 流结束 / 收尾动画。
    // 贴边量只由本帧的 swipeX 决定，与轨道位移同一帧落地、1:1 连续。
    this.o.onWheelFollow?.(this.swipeX, viewW);
    this.applyTrack();

    // 提前把「要往哪边翻」告诉上层：邻图早一点取和解码，结算那一帧就不用
    // 等解码。方向与结算用同一个 `swipeX`，不会一边预热上一张、一边切下一张。
    if (!t.intent) {
      t.intent = true;
      this.o.onSwipeIntent?.(this.swipeX < 0 ? 1 : -1);
    }

    // 结算统一留给「流停下来」那一个窗口：整段流只有这一次，提前决定结局
    // 会插进一段收尾动画、把后面还在走的惯性尾巴打断。
    this.armWheelSettle();
    return true;
  }

  /**
   * 到首 / 末张的跟手：**轨道恒停在基准**，越界槽一个像素都不进视口。
   *
   * 只把 `wheelFollowOffset()` 压到 `WHEEL_EDGE_RUBBER` 内的一点弹性量交给
   * 上层，由它写在当前槽的两张 `<img>` 上；流停下 `onWheelSettle(true)` 把
   * 这段弹性量顺着 200ms / EASE_SOFT 弹回 0，就是一次自然的边界反弹。
   *
   * `applyTrack()` 每帧写「基准 + 0」：上一轮若留下了半张图的 inline 偏移，
   * 在这里一并收干净；在跑的 WAAPI 关键帧优先级高于内联样式，写这一笔不会
   * 打断上一次回弹 / 落位动画（它们的终点本来就是基准）。
   *
   * @param {number} shown 这一段累计的真实行程（含已接管的残余基准）
   */
  wheelEdgeFollow(shown) {
    this.swipeX = 0;
    this.applyTrack();
    this.o.onWheelEdge?.(this.wheelFollowOffset(shown, WHEEL_EDGE_RUBBER + 1));
    this.armWheelSettle();
  }

  /**
   * 累计位移 → 轨道跟随量：**单调、连续、渐近到不足一屏**。
   *
   * 前 `WHEEL_FOLLOW_LINEAR_RATIO` 段 1:1 跟着手指（wheel 的 delta 本来就是
   * 内容位移量），之后用橡皮筋把超出的行程压到 `limit - 1` 以内并渐近。这样
   * 一次手势无论甩多远、惯性尾巴多长，画面都够不到「再下一张」那一格；又不像
   * 硬夹那样后半段完全不动 —— 那是「手指还在推、画面却死住」的来源。
   * `limit` 由调用方给：正常方向是视口宽；到首 / 末张时这个结果**不写轨道**，
   * 只作为当前图弹性位移的上限（`WHEEL_EDGE_RUBBER + 1`）。
   */
  wheelFollowOffset(x, limit = 0) {
    const cap = Math.max(1, (limit || this.o.view().w) - 1);
    const linear = cap * WHEEL_FOLLOW_LINEAR_RATIO;
    const distance = Math.abs(x);
    if (distance <= linear) return x;
    return Math.sign(x) * (linear + rubberband(distance - linear, cap - linear));
  }

  /**
   * 排下一次「结算」。
   *
   * 每个新事件都会重排 —— 定时器到点而没有被重置，才说明流真的停了。默认刻度
   * 是 `WHEEL_GESTURE_END_MS`（65ms），它既是结算时机也是「新的一段」的起点，
   * 两者必须一致，否则会留出一段「既没结算完、又不许重来」的窗口。
   *
   * macOS 上若收到了原生 `momentum ended`，这一段**已经由系统确认结束**，改用
   * `WHEEL_PHASE_SETTLE_MS`（24ms）短刻度：只为等最后几个 Web wheel 落地，不再
   * 白等满 65ms。短刻度只在 `phaseEnded` 置起时生效；没有原生相位事件时整条
   * 路径与改动前逐字一致，65ms 静默仍是唯一判据（兜底，不能让预览失灵）。
   */
  armWheelSettle() {
    clearTimeout(this._wheelSettle);
    const ms = this.wheelSwipe.phaseEnded
      ? WHEEL_PHASE_SETTLE_MS
      : WHEEL_GESTURE_END_MS;
    this._wheelSettle = setTimeout(() => {
      this._wheelSettle = 0;
      this.settleWheelSwipe(0);
    }, ms);
  }

  /**
   * 原生 `NSEvent.phase == began`：一段新的物理手势从这一刻开始。
   *
   * Web `WheelEvent` 没有相位字段，所以 `settled` 闸门本来只能靠「静默 ≥65ms」
   * 复位；真机实测两次连滑的间隔可以只有 50~58ms，那时第二段会被当成上一段的
   * 惯性尾巴吞掉、少切一张。原生 began 不受这个阈值限制，直接把闸门复位。
   *
   * 上一段若还没结算（原生 ended 迟到 / 兜底定时器没到点），先就地收掉，免得
   * 新手势的位移记到旧账上。这里**只动结算状态**：不写轨道、不接管动画、不改
   * 方向映射，`t.x` 仍由 Web wheel 逐帧累计。
   */
  onWheelPhaseBegin() {
    const s = this.wheelSwipe;
    if (!s.settled && (s.x !== 0 || this.swipeX !== 0)) this.settleWheelSwipe(0);
    s.settled = false;
    s.dir = 0;
    s.phaseEnded = false;
    this.clearWheelProgress();
  }

  /**
   * 原生 `momentumPhase == ended / cancelled`（无惯性的短滑为 `phase == ended`）：
   * 这一段真的结束了，改成短刻度结算。
   *
   * 一次物理手势可能有 `phase ended`（抬手）与 `momentum ended`（惯性结束）
   * 两类结束事件，上层只挑后者发一次（无惯性段才退回前者），所以这里天然只
   * 结算一次；`settled` 闸门再挡住重复回调 / 迟到的尾巴。
   */
  onWheelPhaseEnd() {
    const s = this.wheelSwipe;
    if (s.settled) return;
    s.phaseEnded = true;
    // 重排而不是立刻结算：`momentum ended` 的 ΔX=0 不产生 Web wheel，但它经
    // IPC 到达时最后一两帧可能还在路上，24ms 足够让它们计入累计再判定。
    this.armWheelSettle();
  }

  /**
   * 「流停下来」那一刻：整段流的**唯一一次**结算 —— 切相邻一张，或回弹。
   *
   * 流中间只跟手、不换页，所以这里是索引唯一可能变化的地方，`onWheelSwipe`
   * 最多被调用一次，命中也只走 `go(direction)` 一张。判据**沿用单指松手的那一套**
   * （位移 ≥ 视口宽 `SWIPE_DISTANCE_RATIO`，或峰值速度 ≥ `SWIPE_VELOCITY` 且
   * 位移 ≥ `SWIPE_MIN_PX`）—— 慢拖一张、轻甩一张的手感一点没变：
   *   * 命中 → 补完到相邻那张，从当前跟手位置接着播（`fromSwipe`），与单指 /
   *     键盘 / 按钮同一条收尾；
   *   * 否则（含首张 / 末张继续往外滑）→ 回弹到当前张，索引不动。
   *
   * 速度取本段**峰值**而不是末值：末尾那几个惯性事件的样本太微弱，拿末值会
   * 几乎永远不达标。结算完把 `settled` 置起，同段剩下的惯性尾巴不会再进来；
   * 下一段由 `handleWheelHorizontal` 的静默判据复位。
   *
   * 结算还把「这一段的跟手速度」交给上层：落位动画拿它当**起点速度**，才能
   * 从手势末尾接着把最后一段距离播完，而不是从静止重新起一段固定时长的缓动
   * （那会在接近居中处先硬停一下、再用近零速度慢慢爬完最后几 px）。
   * 取末尾平滑速度与峰值的一部分里较大的那个 —— 惯性尾巴末尾的样本太弱，
   * 光看它会把落位拖回「缓慢居中」；上层还会再夹一次，异常大单帧也不至于
   * 把落位压成一瞬。`clearWheelProgress()` 会把 `vx` / `peakV` 清零，所以必须
   * 在清之前算好。
   *
   * @param {number} waited 已经因为「动画还在跑」重试了多久（ms）
   */
  settleWheelSwipe(waited = 0) {
    clearTimeout(this._wheelSettle);
    this._wheelSettle = 0;

    const s = this.wheelSwipe;
    // 交给 viewer 的落位初速（px/ms，非负）。两个回调拿同一份，轨道 WAAPI 与
    // 槽内贴边量的 CSS transition 才会算出完全相同的时长 / 缓动、同一帧起跑。
    const velocity = Math.max(Math.abs(s.vx), s.peakV * 0.4);
    // 一段手势只结算一次：定时器被重排 / 上层重复回调 / 惯性尾巴都不许再翻。
    // retry（动画还没跑完）尚未结算，不能在这里被自己挡住，所以闸门只在下面
    // 两个**真正落地**的分支里置起。
    if (s.settled) return;

    const dx = this.swipeX;
    const direction = dx < 0 ? 1 : -1; // 手指向左 → 下一张
    // 宽度优先用这一段缓存的那一份：这里通常在定时器回调里，若不是同一段手势
    // （已 reset）才需要重新量一次
    const width = s.viewW || this.o.view().w;
    const far = Math.abs(dx) > width * SWIPE_DISTANCE_RATIO;
    const fast = Math.abs(dx) > SWIPE_MIN_PX && s.peakV > SWIPE_VELOCITY;
    // 同一段里掉过头：惯性尾巴里几个反向增量常会留下一点净位移（含累计夹取的
    // 舍入），此时不能靠峰值速度就按那个方向补一张 —— 用户明明把画面拉回来
    // 了却翻了页。反向要成立必须靠**位移重新达标**，速度不算数。
    const reversed = s.dir !== 0 && direction !== s.dir;
    const hit = reversed ? far : far || fast;
    // 边界判定走 wheel 专用通道：即使开了循环，横滑到头也只回弹，不绕回另一头。
    const canStep = this.o.onWheelCanStep?.(direction) ?? this.o.canSwipe?.(direction) ?? true;

    if (hit && canStep) {
      // 切换 / 展开动画还没跑完：等它一下，别把这一次吸附白白丢掉
      if (!this.enabled && waited < WHEEL_SETTLE_MAX_MS) {
        this._wheelSettle = setTimeout(
          () => {
            this._wheelSettle = 0;
            this.settleWheelSwipe(waited + WHEEL_SETTLE_RETRY_MS);
          },
          WHEEL_SETTLE_RETRY_MS
        );
        return;
      }
      if (this.enabled) {
        s.settled = true;
        // 贴边偏移与补完动画同步归零：两者拿同一份落位时长 / 缓动、同一时刻
        // 起跑，收尾结束时目标图正好回到居中的静止形态，末尾不会跳一下。
        this.o.onWheelSettle?.(false, velocity);
        this.clearWheelProgress();
        this.o.onWheelSwipe?.(direction, { fromSwipe: true, velocity });
        this.o.onWheelRest?.();
        return;
      }
    }
    // 未达标、或首张 / 末张继续往外滑：只让当前图弹回去，索引与槽位内容不动。
    s.settled = true;
    const timing = this.o.onWheelSettle?.(true, velocity);
    this.reboundWheelSwipe(timing);
    this.o.onWheelRest?.();
  }

  /** 没达标的这一段：轨道带着当前跟手位置回弹到 0 */
  reboundWheelSwipe(timing) {
    this.clearWheelProgress();
    // 边界这一段 `swipeX` 恒为 0、轨道全程没动过：绝不能走 animateTrackTo(0)，
    // 它开头那句 cancelAnim() 会把上一段还在播的回弹就地掐掉、把视觉硬拉回
    // 基准 —— 正是「回弹过程中再滑会抖一下」的来源。当前图的弹性位移由
    // onWheelSettle → releaseWheelSeam 收回，轨道已由 wheelEdgeFollow 归位。
    if (this.swipeX === 0) return;
    // 回弹曲线由上层 `wheelReboundTiming()` 从这一段交接过来的跟手速度算好，
    // 经 onWheelSettle 的返回值带回来；贴边量的 CSS transition 用的是同一个
    // timing 对象，轨道 WAAPI 与槽内变换因此逐字同源。没有上层计时信息时
    // （纯逻辑替身 / 非 viewer 调用）退回原来的 200ms / EASE_SOFT。
    const duration = Number.isFinite(timing?.duration) ? timing.duration : 200;
    const easing = typeof timing?.easing === 'string' ? timing.easing : EASE_SOFT;
    // 200ms：回弹的距离通常只有几十 px，原来那 280ms 会显得「松手之后还黏着」
    this.animateTrackTo(0, duration, easing);
  }

  /**
   * 轨道当前的**视觉**横移（相对 `trackBase`）。
   *
   * 正在跑的动画是 WAAPI 关键帧，优先级高于内联样式 —— 只有 computed 值才是
   * 用户真正看到的位置。掐掉动画之前必须先把它读出来，否则视觉会掉回内联值。
   * 一段手势最多读一次，代价可以接受。
   */
  trackVisualOffset() {
    const track = this.o.track;
    if (!track || typeof getComputedStyle !== 'function') return this.swipeX;
    try {
      const m41 = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      return m41 - (this.o.trackBase?.() ?? 0);
    } catch {
      return this.swipeX;
    }
  }

  /**
   * 清掉「这一段流」的累计与接管偏移，**但保留轴向与视口宽**。
   *
   * 新的一段（静默 ≥ `WHEEL_GESTURE_END_MS`）和结算完成时都走这里。轴向留着
   * 是因为手还是同一类滑动，没必要再攒 10px 判一次轴；`base` 必须交回 null：
   * 回弹 / 收尾动画的**终点**才是 0，被打断时画面并不在 0，写死成 0 会让下
   * 一段跟手把没走完的那截位移整段丢掉、画面往回跳。
   *
   * 这里**不碰 `settled`**：结算完成时也走这个函数，闸门要一直留到
   * `handleWheelHorizontal` 判定「新的一段」（静默 ≥65ms）或原生 `phase began`
   * 到达才复位。否则同一次手势的惯性尾巴又能结算第二次 —— 正是「一次滑动翻
   * 两张」的来源。
   */
  clearWheelProgress() {
    const s = this.wheelSwipe;
    s.x = 0;
    s.base = null;
    s.vx = 0;
    s.peakV = 0;
    s.intent = false;
  }

  /**
   * 横向 wheel 平移（仅放大态）：内容跟着手势走。
   *
   * 传入的 dx 已经是屏幕坐标系下的手势位移，内容跟手 ⟹ 直接加到 rawX 上。
   */
  panByWheelX(dx) {
    const view = this.o.view();
    const base = this.o.base();
    this.rawX += dx;
    const st = settle(view, base, this.scale, this.rawX, this.rawY, RUBBER);
    this.tx = st.x;
    this.ty = st.y;
    this.apply();
    this.emit();
  }

  /**
   * 清空一段横向 wheel 的累积，并撤掉还没到点的结算。
   *
   * `axis` 也要一起清：它是「这一串已经认了横向」的凭据，留着会让下一次
   * 纯纵向的滚轮也被判进横向分支，表现为「滚轮突然不缩放了」。
   */
  resetWheelSwipe() {
    clearTimeout(this._wheelSettle);
    this._wheelSettle = 0;
    this.wheelSwipe = freshWheelSwipe();
  }

  onDoubleClick(event) {
    if (!this.enabled) return;
    event.preventDefault();
    this.o.onUserActivity?.();
    this.o.onDoubleTap(event.clientX, event.clientY);
  }

  /* ---------------- 惯性 ---------------- */

  fling() {
    const view = this.o.view();
    const base = this.o.base();
    const friction = FLING_FRICTION;
    let vx = this.vel.x * 16;
    let vy = this.vel.y * 16;

    const step = () => {
      vx *= friction;
      vy *= friction;
      if (Math.hypot(vx, vy) < 0.15) {
        this.raf = 0;
        this.springBack();
        return;
      }
      this.rawX += vx;
      this.rawY += vy;
      const st = settle(view, base, this.scale, this.rawX, this.rawY, RUBBER);
      this.tx = st.x;
      this.ty = st.y;
      this.apply();
      this.emit();
      this.raf = requestAnimationFrame(step);
    };

    this.cancelAnim();
    this.raf = requestAnimationFrame(step);
  }
}

function panBoundsOf(view, base, scale) {
  return {
    maxX: Math.max(0, (base.w * scale - view.w) / 2),
    maxY: Math.max(0, (base.h * scale - view.h) / 2)
  };
}

/**
 * 一次横向滑动的初始状态。
 *
 * `x` 是**整段的真实行程**，流中间不结清、不扣屏；写进轨道的位移由
 * `wheelFollowOffset()` 压缩到不足一屏，所以画面最多只朝相邻那张移动。
 * 到首 / 末张时轨道全程不动，只有当前图有一点弹性偏移（`wheelEdgeFollow`）。
 * 生命的终点是这一串 wheel 真的停下来（静默 `WHEEL_GESTURE_END_MS`）：
 * `settleWheelSwipe` 在那一刻结算唯一的一张，`settled` 随后挡住同段尾巴。
 */
function freshWheelSwipe() {
  return {
    axis: null,
    /** 判定轴向之前的两轴**累积**和（见 WHEEL_AXIS_LOCK_PX） */
    ax: 0,
    ay: 0,
    /** 这一段里累计的手势位移（px，向左为负；全程保留真实行程，不扣屏） */
    x: 0,
    /**
     * 这一段是否已经结算过（切一张或回弹，二选一，只发生一次）。
     *
     * 结算之后仍在 65ms 内到达的 wheel 事件属于同一次手势的惯性尾巴：既不
     * 能再触发一次切换，也不能再写跟手位移（否则会把正在播的收尾动画拖偏，
     * 甚至让轨道停在半张图上）。静默达到 `WHEEL_GESTURE_END_MS` 才开新的一段，
     * 这里随之复位 —— 这是「一次滑动最多一次切换」的显式闸门。
     */
    settled: false,
    /**
     * 这一段**起手**时的翻页方向（+1 下一张 / -1 上一张，0 = 还没定）。
     *
     * 只用于「同一段流里中途掉头」：惯性尾巴里几个反向增量会留下一点净位移，
     * 若单靠峰值速度就按那个方向补一张，用户明明把画面拉回来了却翻了页。
     * 反向要真的成立，必须靠**位移**重新达标（`far`），速度不算数。
     */
    dir: 0,
    /**
     * 接管切换动画时「画面已经停在哪儿」的偏移（px，相对中间槽基准）。
     *
     * `null` = 还没接管过，第一次跟手时向调用方要（见 `claimTrack`）。
     * 它不参与翻页判定（那是 `x` 的事），只参与**显示**：跟手写进轨道的量
     * 始终是 `base + x`，这样接管那一刻视觉不会跳，接管之后的位移才是
     * 用户自己推出来的。
     */
    base: null,
    /**
     * 这一段开始时的轨道宽度（= 视口宽）。
     *
     * 一段手势只量一次：`view()` 要读 `clientWidth`，而每个事件前脚刚写过
     * transform，读布局会强制同步重排 —— 120Hz 的触控板流上按事件读，就是
     * 「画面跟不上手」的直接来源。
     */
    viewW: 0,
    /** 这一段是否已经通知过「要往哪边翻」，用于提前解码邻图 */
    intent: false,
    /** 上一个事件的时间戳：既用于判「换了手势」，也用于算速度 */
    at: 0,
    /** 平滑后的速度（px/ms）与这一段里的峰值速度（流结束吸附用） */
    vx: 0,
    peakV: 0,
    /**
     * 原生相位是否已确认这一段结束。只用来把结算刻度从 65ms 换成 24ms；
     * 由 `onWheelPhaseEnd()` 置起，`onWheelPhaseBegin()` 与新段复位时清掉。
     */
    phaseEnded: false
  };
}

/**
 * 统一不同浏览器 / 设备的 wheel 增量量纲。
 * `deltaMode` 同时作用于两个轴，换算时得跟着轴走。
 */
function normalizeWheel(event, axis = 'y') {
  const raw = axis === 'x' ? event.deltaX : event.deltaY;
  if (event.deltaMode === 1) return raw * 16; // DOM_DELTA_LINE
  if (event.deltaMode === 2) {
    // DOM_DELTA_PAGE：翻页单位换算到「一屏」
    return raw * (axis === 'x' ? window.innerWidth : window.innerHeight);
  }
  return raw;
}

/**
 * 把 wheel 的 delta 换算成**屏幕坐标系下的手势方向**（向右为正、向下为正），
 * 纵横两轴共用这一个系数。
 *
 * DOM 的约定是固定的：`deltaX > 0` = 向右滚动 = 内容向左；`deltaY > 0` =
 * 向下滚动 = 内容向上。也就是说 DOM 的 delta 描述的是**内容的移动**，而不是
 * 手指的移动；两者只有在 macOS 的「滚动方向：自然」开启时才同向。
 *
 *   * 自然滚动**开启**（出厂默认）：内容跟手 —— 内容向左 ⟹ 手指向左，
 *     所以要取相反数才是手势方向；
 *   * 自然滚动**关闭**：内容反向移动 —— 内容向左 ⟹ 手指向右，此时 DOM delta
 *     在数值上恰好与手势方向一致。
 *
 * `webkitDirectionInvertedFromDevice === true` 表示的正是前一种情况：AppKit
 * 已按用户偏好把 delta 反转过一次（本机就把这个开关关掉：
 * `com.apple.swipescrolldirection = 1`）。该属性非标准（Chromium 恒为 false
 * 是已知缺陷），所以只按值判断、不做 feature-detect，拿不到就按后一种处理。
 *
 * @returns {1 | -1}
 */
function wheelSign(event) {
  return event.webkitDirectionInvertedFromDevice === true ? -1 : 1;
}
