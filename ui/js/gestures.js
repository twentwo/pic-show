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
 * 跟手推出去超过轨道宽度的这个比例，**当场结算**，不再等这一段的流停下来。
 * 已经拖过半张图，意图不可能有别的解释；再让用户等 60ms 才动，就是「迟钝」。
 */
const WHEEL_COMMIT_RATIO = 0.5;
/**
 * 「甩」的即时结算门槛：位移到这么多 **且** 当前速度仍在阈值之上，立刻结算。
 *
 * 用**当前**速度而不是峰值 —— 峰值一出现就永远为真，会让「慢慢拖出去再停住」
 * 也按甩处理；当前速度则如实反映「手还在快速划」。
 *
 * 48px 是「跟手」与「立刻响应」的分界：慢拖要一路跟到半张图（`WHEEL_COMMIT_RATIO`）
 * 或松手才结算，而真正的甩在这个距离上已经足够表达意图，再跟下去只是浪费延迟。
 */
const WHEEL_FAST_COMMIT_PX = 48;
/**
 * 判「甩」的速度门槛（px/ms）。
 *
 * 比单指松手那个 `SWIPE_VELOCITY = 0.45` 高一倍多：触控板一条斜线划下来，
 * 中速滑动的瞬时速度就有 0.4~0.8，拿 0.45 当门槛会让**大部分**正常滑动都在
 * 48px 处就被判成甩 —— 画面只跟了 3% 就飞走，观感反而更不跟手。取 1.1
 * （≈ 每 16ms 走 18px）才是「明显是在甩」。
 */
const WHEEL_FLICK_VELOCITY = 1.1;
/**
 * 跟手推出去超过一屏之后，多出来的行程衰减到这么多为止。
 * 轨道只有「上一张 / 当前 / 下一张」三个槽，再拖也没有第四个槽可显示 ——
 * 不做限制会把黑边拉进来。
 */
const WHEEL_OVERSCROLL_RUBBER = 90;
/**
 * 结算时若碰上切换动画还在跑（`enabled === false`），隔这么久再试一次，
 * 而不是直接这一次手势丢掉。
 */
const WHEEL_SETTLE_RETRY_MS = 60;
/** 上面那个重试的总预算：超过就直接回弹，不能把轨道停在半张图上 */
const WHEEL_SETTLE_MAX_MS = 600;
/**
 * 反向再出发所需的**累积行程**（不是单次增量）。
 * 同一次惯性流不会自己掉头，掉头且攒够一段行程就是用户换了方向重推。
 */
const WHEEL_REVERSE_TRAVEL = 60;
/**
 * 一段流里已经翻过一张之后的硬上限。兜底用：万一某个设备/驱动的尾巴异常长，
 * 也不能把用户永久锁死 —— 超过这个时长就按新手势处理。
 */
const WHEEL_LOCK_MAX_MS = 1200;
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
      /** 上一次实例的 `wheelSwipe`：一次触控板手势跨越多次图片切换，见构造末尾 */
      wheelState: null,
      canSwipe: () => false,
      onChange: () => {},
      onDismissProgress: () => {},
      onDismissRelease: () => {},
      onSwipeRelease: () => {},
      onWheelSwipe: () => {},
      /** 横滑方向一确定就通知（用来提前取/解码邻图），参数同 onWheelSwipe */
      onSwipeIntent: () => {},
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
   * 轨道回弹 / 归位。与 `animateTo` 同样的技巧：先把终值写进 inline style，
   * 动画 `fill:'none'`，结束瞬间样式天然接续，不会闪回起点。
   */
  animateTrackTo(swipeX, duration = 260, easing = EASE_OUT) {
    if (!this.o.track) return Promise.resolve();
    this.cancelAnim();

    const base = this.o.trackBase?.() ?? 0;
    const from = `translate3d(${base + this.swipeX}px, 0, 0)`;
    const to = `translate3d(${base + swipeX}px, 0, 0)`;

    this.swipeX = swipeX;
    if (duration <= 0 || from === to) {
      this.applyTrack();
      return Promise.resolve();
    }

    const anim = this.o.track.animate(
      { transform: [from, to] },
      { duration, easing, fill: 'none' }
    );
    this.anim = anim;
    this.applyTrack();

    return anim.finished
      .then(() => {
        this.anim = null;
      })
      .catch(() => {});
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
   * 动画到目标变换。
   * 技巧：动画一开始就先把终值写进 inline style；动画 fill:'none'，
   * 结束后样式自然接续，不会出现「闪回起点」的那一帧。
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
   * 触控板双指横向滑动 → 上一张 / 下一张（未放大）/ 横向平移（已放大）。
   *
   * 为什么在这里而不是 pinch 分支里：Mac 的多指手势到 DOM 之前就被系统翻译
   * 成了 wheel / ctrl+wheel / click，`pointers.size >= 2` 那条 pinch 分支在
   * 触控板上永远进不去 —— 想在 Mac 上接住双指横滑，只有 wheel 这一个入口。
   *
   * 方向约定与其他入口一致：内容跟着手指走。deltaX > 0 表示内容向左移动
   * （等同于手指向左划）→ 下一张。
   *
   * 横向这条路与单指拖拽共用同一套结算判据（见 `settleWheelSwipe`）：画面先跟着
   * 手指走，等这一段的 wheel 流停下来（相当于抬手）再决定要不要翻页。多指手势
   * 同样是这条入口 —— 它在到达 DOM 之前就被系统翻译成了 wheel，`pointers` 里
   * 永远凑不出第二根手指。
   *
   * @returns {boolean} true = 这次输入已被横向路径认领，调用方不要再当纵向处理。
   *   注意「认领」不等于「消费」：还在虚按噪点里时不调用 preventDefault，
   *   没有被这一条用掉的方向依旧还给浏览器。
   */
  handleWheelHorizontal(event, dx, dy) {
    const now = performance.now();
    const prev = this.wheelSwipe;
    const sincePrev = now - prev.at;

    // 静置太久 → 换了手势，累积、速度、反向行程、结算标记全部作废。
    // 顺序要紧：必须在**重新取** this.wheelSwipe 之前重置，否则 s 会指向刚被
    // 丢掉的那个对象 —— 每个事件都从 0 开始累加，位移永远攒不够。
    if (sincePrev > WHEEL_GESTURE_GAP_MS) this.resetWheelSwipe();
    const s = this.wheelSwipe;
    s.at = now;

    // 静默超过「流结束」的刻度（65ms）—— 与结算用的是同一个刻度，所以这一刻
    // 上一段手势必然已经结算过（翻页或回弹）。位移、速度、接管偏移都要作废：
    //   - `base` 残留 → 下一段不再去接管新动画，跟手整整错开一屏；
    //   - `peakV` 残留 → 慢慢拖也会被上一段的峰值判成「甩」，一碰就翻。
    // 轴向与视口宽特意留着：手还是同一类滑动，没必要再攒 10px 判一次轴。
    // 65~600ms 这段窗口正是「抬手之后马上又滑」的常态，漏掉就是「第二下不跟手」。
    if (sincePrev >= WHEEL_GESTURE_END_MS) {
      s.x = 0;
      s.base = null;
      s.vx = 0;
      s.peakV = 0;
      s.intent = false;
      s.rev = 0;
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

    // 这一段流已经翻过一张了：剩下的（惯性尾巴、用户的余推）只记账、
    // 不跟随、不结算，直到这一段真的结束（看 wheelGestureRestarted）。
    if (s.locked) {
      this.trackWheelReverse(s, dx);
      if (!this.wheelGestureRestarted(s, sincePrev, now)) {
        event.preventDefault();
        return true;
      }
      // 上一段结束、这是新的一段 → 从头开始累计。
      // 轴向与视口宽照抄上一段：手没抬起来，必然还是同一类滑动，让它再从 0
      // 攒 10px 判一次轴，只会让掉头之后的第一两帧不跟手。
      const keepW = s.viewW;
      this.resetWheelSwipe();
      const fresh = this.wheelSwipe;
      fresh.at = now;
      fresh.axis = 'x';
      fresh.viewW = keepW;
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
    // 已经接管过切换动画的除外：那时画面正停在两张图中间（基准已经被改成
    // 「当前停的位置」），每一帧都必须把位置写回去，否则会退回一整档。
    if (Math.abs(t.x) <= WHEEL_SWIPE_DEADZONE && t.base === null) {
      this.armWheelSettle();
      return true;
    }

    // 跟手。写样式之前必须先把「画面此刻停在哪」接过来 —— 有两类动画会盖住
    // 这一帧要写的位移，而它们的当前位置**只能从 computed 里读**（WAAPI 关键帧
    // 优先级高于内联样式，直接 cancel 会让视觉瞬间掉回内联值）：
    //   * 本实例上一次没达标的回弹（`this.anim`）：掐掉它会把那段没走完的位移
    //     整段丢掉、画面往回跳一下，就是「前一段位移像丢了一样」；
    //   * viewer 的切图收尾动画（跑在同一个 track 上，`this.anim` 够不到它）：
    //     连续切换时用户往往在上一次收尾还没播完就再次起手，那一段跟手位移会
    //     整段被关键帧吞掉，要等动画结束才突然生效 —— 「连切几张之后就不跟手、
    //     有延迟」的来源。
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
    const viewW = s.viewW || (s.viewW = this.o.view().w);
    this.swipeX = this.wheelFollowOffset(t.base + t.x, viewW);
    this.applyTrack();

    // 提前把「要往哪边翻」告诉上层：邻图的原图早一点开始取和解码，
    // 结算时那一帧就不用等着解码 —— 第一帧的卡顿多半出在这里
    if (!t.intent) {
      t.intent = true;
      this.o.onSwipeIntent?.(t.x < 0 ? 1 : -1);
    }

    // 到点立刻结算，不陪惯性尾巴耗时间。两种「意图已经明确」的情形：
    //   1. 已经拖过半张图 —— 不可能是误触；
    //   2. 还是快速划动（当前速度）且行程够了 —— 一次「甩」。
    // 剩下的（慢慢拖出去一小段就停住）才交给 armWheelSettle 等流结束再判。
    const far = Math.abs(t.x) >= viewW * WHEEL_COMMIT_RATIO;
    const fast =
      Math.abs(t.x) >= WHEEL_FAST_COMMIT_PX && Math.abs(t.vx) > WHEEL_FLICK_VELOCITY;
    if (far || fast || Math.abs(t.x) >= viewW) {
      this.settleWheelSwipe();
      return true;
    }

    this.armWheelSettle();
    return true;
  }

  /**
   * 累计位移 → 轨道跟随量。
   * 一屏之内 1:1 跟着手指（wheel 的 delta 本来就是内容的位移量）；超出的部分
   * 走橡皮筋 —— 轨道只有三个槽，再多会把黑边拖进画面。
   */
  wheelFollowOffset(x, viewW = 0) {
    const limit = viewW || this.o.view().w;
    const over = Math.abs(x) - limit;
    if (over <= 0) return x;
    return Math.sign(x) * (limit + rubberband(over, WHEEL_OVERSCROLL_RUBBER));
  }

  /**
   * 排下一次「结算」：`WHEEL_GESTURE_END_MS` 没有新事件就认为这一段结束了。
   * 每个新事件都会重排 —— 定时器到点而没有被重置，才说明流真的停了。
   */
  armWheelSettle() {
    clearTimeout(this._wheelSettle);
    this._wheelSettle = setTimeout(() => {
      this._wheelSettle = 0;
      this.settleWheelSwipe(0);
    }, WHEEL_GESTURE_END_MS);
  }

  /**
   * 「松手」那一刻：用与单指**完全相同**的判据决定要不要翻页。
   *
   *   位移 ≥ 视口宽 `SWIPE_DISTANCE_RATIO`，**或** 速度 ≥ `SWIPE_VELOCITY`
   *   且累计 ≥ `SWIPE_MIN_PX`。
   *
   * 速度取这一段里的**峰值**而不是末值：这一串末尾的事件是惯性尾巴最后几帧
   * 的微弱样本（单指那边则是手指离屏前真实的那一帧），拿末值会几乎永远不达标。
   *
   * 与其它入口一样从当前跟手位置接着播（`fromSwipe`），所以不存在「先跳回去
   * 再滑出来」的那一帧。判定不通过则回弹归位。
   *
   * @param {number} waited 已经因为「动画还在跑」重试了多久（ms）
   */
  settleWheelSwipe(waited = 0) {
    clearTimeout(this._wheelSettle);
    this._wheelSettle = 0;

    const s = this.wheelSwipe;
    if (s.locked) return;

    const dx = s.x;
    const direction = dx < 0 ? 1 : -1; // 手指向左 → 下一张
    // 宽度优先用这一段缓存的那一份：这里通常在定时器回调里，若不是同一段手势
    // （已 reset）才需要重新量一次
    const width = s.viewW || this.o.view().w;
    const far = Math.abs(dx) > width * SWIPE_DISTANCE_RATIO;
    const fast = Math.abs(dx) > SWIPE_MIN_PX && s.peakV > SWIPE_VELOCITY;

    if ((far || fast) && this.o.canSwipe?.(direction)) {
      // 切换 / 展开动画还没跑完：等它一下，别把这一次手势白白丢掉
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
        this.lockWheelSwipe(performance.now(), direction);
        this.o.onWheelSwipe?.(direction, { fromSwipe: true });
        return;
      }
    }
    this.reboundWheelSwipe();
  }

  /** 没达标的这一段：轨道带着当前跟手位置回弹到 0 */
  reboundWheelSwipe() {
    this.wheelSwipe.locked = false;
    this.wheelSwipe.x = 0;
    // 回弹的**终点**才是 0；回弹被打断时画面并不在 0。把 base 交回 null，
    // 下一段跟手就会去读实际的视觉位置接着走 —— 写死成 0 的话，用户回弹还没
    // 播完就再滑一次，那一段没走完的位移会被整段丢掉、画面往回跳。
    this.wheelSwipe.base = null;
    // 200ms：回弹的距离通常只有几十 px，原来那 280ms 会显得「松手之后还黏着」
    this.animateTrackTo(0, 200, EASE_SOFT);
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
   * 进入「这一串已经翻过一张」的状态：后续增量只记账、不再触发。
   *
   * 累积位移也要一起清零，否则下一次解锁时残留的旧位移会被算进新手势 ——
   * 「触发后没重置基准、累积量越过阈值又翻一张」就是这么来的。
   */
  lockWheelSwipe(now, direction) {
    const s = this.wheelSwipe;
    s.x = 0;
    s.rev = 0;
    // 基准也一起作废：这一格翻完之后轨道会重新落位，下一段手势要重新接管
    // （否则接管的偏移会被当成新一段的位移，一松手就多翻一张）
    s.base = null;
    s.locked = true;
    s.lockedAt = now;
    s.dir = direction;
  }

  /**
   * 锁定期间累积「反向重推」的行程。
   *
   * 符号约定容易看错：`s.dir` 记的是「翻到了哪一边」（+1 = 下一张），而 `dx`
   * 是屏幕坐标系下的位移（向左为负），触发那一刻满足 `dir = -sign(dx)`。
   * 所以「和用户刚才那一推反着来」 ⇔ `sign(dx) === sign(s.dir)`。
   * 同手推的事件会把累积清零 —— 抖动因此攒不出阈值，而「没抬手直接往回滑」
   * 攒得出来，那是一次货真价实的新滑动。
   */
  trackWheelReverse(s, dx) {
    const reverse =
      s.dir !== 0 && dx !== 0 && Math.sign(dx) === Math.sign(s.dir);
    if (!reverse) {
      s.rev = 0;
      return;
    }
    s.rev += Math.abs(dx);
  }

  /**
   * 这一段 wheel 流是否已经结束 —— 也就是「可以再翻一张了吗」。
   *
   * 结算与解锁用的是**同一个刻度** `WHEEL_GESTURE_END_MS`：正因为流停了这么久
   * 才判定翻页（定时器到点），所以下一次事件间隔超过它就必然是新手势。刻度分开
   * 会留出一段「既没结算完、又不许重来」的窗口，表现就是「怎么滑都不动」。
   *
   * 三条出口，前一条不成立才看下一条：
   *   1. 反向行程攒够 `WHEEL_REVERSE_TRAVEL` —— 惯性流不会自己掉头，掉头且攒够
   *      一段行程说明用户压根没抬手只是换了方向，那是一次新的滑动；
   *   2. 静默 ≥ `WHEEL_GESTURE_END_MS` —— 上一段确实停了，这是新的一推；
   *   3. 硬上限 `WHEEL_LOCK_MAX_MS`：兜底，异常长的尾巴不能把用户永久锁住。
   *
   * 这里**没有**任何「单次增量达到峰值某个比例」之类的判据：一次持续推力里每帧
   * 增量本来就在峰值附近，那种判据会在手指还按着的时候就把锁解掉；同时也**不设**
   * 「必须锁满切换动画时长」这条硬下限 —— 那是上一版为了挡连翻加的，代价是把
   * 抬手之后再滑的第二段也一起吞了；现在动画还没跑完的情况交给
   * `settleWheelSwipe` 的重试去等，不需要提前猜时间。
   */
  wheelGestureRestarted(s, sincePrev, now) {
    if (s.rev >= WHEEL_REVERSE_TRAVEL) return true;
    if (sincePrev >= WHEEL_GESTURE_END_MS) return true;
    return now - s.lockedAt > WHEEL_LOCK_MAX_MS;
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
 * 一次横向 wheel 手势的初始状态。
 *
 * `locked` 是「已经翻过一张」的意思 —— 它和时间无关，生命的终点是**这一串
 * wheel 真的结束了**，而不是一个固定倒计时：触控板抬手后的惯性尾巴能持续
 * 一秒以上，靠倒计时挡不住，必须在尾巴停息后才解锁。
 */
function freshWheelSwipe() {
  return {
    axis: null,
    /** 判定轴向之前的两轴**累积**和（见 WHEEL_AXIS_LOCK_PX） */
    ax: 0,
    ay: 0,
    /** 这一段里累积的手势位移（px，向左为负） */
    x: 0,
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
    /** 平滑后的速度（px/ms）与这一段里的峰值速度 */
    vx: 0,
    peakV: 0,
    /**
     * 锁定之后累积的**反向行程**。
     * 只有攒够 `WHEEL_REVERSE_TRAVEL` 才说明用户真的换了个方向重推，
     * 单帧的反向抖动会被后面同向的事件清零，不算数。
     */
    rev: 0,
    locked: false,
    lockedAt: 0,
    /** 触发时的方向，用于识别反向重推 */
    dir: 0
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
