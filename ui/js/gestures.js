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

import { clamp, settle, zoomAround, isMostlyVertical } from './geometry.js';

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_SOFT = 'cubic-bezier(0.33, 1, 0.68, 1)';

/** 橡皮筋允许的最大额外位移（px） */
const RUBBER = 140;
/** 松手后判定为「关闭」的位移阈值（视口高度的比例） */
const DISMISS_DISTANCE_RATIO = 0.2;
/** 松手后判定为「关闭」的速度阈值（px/ms） */
const DISMISS_VELOCITY = 0.55;
/** 松手后判定为「切换」的位移阈值（视口宽度的比例） */
const SWIPE_DISTANCE_RATIO = 0.22;
/** 松手后判定为「切换」的速度阈值（px/ms） */
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
 * 这一段没有 wheel 事件就认为上一次手势结束了。
 * 触控板「甩」一下会产出几十个事件（含惯性尾段），间隔通常 < 100ms；
 * 而人换一次手势至少要抬手再落下，远超这个量级。
 */
const WHEEL_GESTURE_GAP_MS = 600;
/**
 * 累积位移的前这段距离直接不计：双指虚按在触控板上会持续产出 1~2px 的噪点，
 * 跨过死区之后才开始判断要不要翻页。
 */
const WHEEL_SWIPE_DEADZONE = 8;
/** 越过死区之后，再凑够这么多才算「确实在横滑」 */
const WHEEL_SWIPE_TRAVEL = 12;
/**
 * 翻完一张之后，至少锁这么久。
 *
 * 两个下限叠出来的：一是 `viewer.js` 的切换动画 `SWITCH_MS = 300`（动画没走完
 * 就再翻一张会看到画面突跳），二是触控板抬手后最初那几帧的增量还很大 ——
 * 这段时间里哪怕是再大的增量也一律当作惯性残留。
 */
const WHEEL_SWITCH_LOCK_MS = 380;
/**
 * 这一段没有 wheel 事件，就认为「惯性尾巴已经结束」。
 * 触控板甩一下的尾巴事件间隔通常 < 100ms，人重新推一次则至少几百毫秒。
 */
const WHEEL_TAIL_GAP_MS = 180;
/**
 * 解锁的第二条出口：单次增量回到本次手势峰值的这个比例，说明用户**又推了一把**
 * 而不是惯性还在衰减。鼠标滚轮靠这条做到「一格一张」。
 */
const WHEEL_RESTART_RATIO = 0.8;
/** 上面两条出口共同的最小幅度，滤掉抬手瞬间的反向抖动 */
const WHEEL_RESTART_MIN_PX = 8;
/** 反向推时的最小幅度：尾巴不会自己掉头，掉头就是用户改主意了 */
const WHEEL_REVERSE_MIN_PX = 10;
/**
 * 锁定的硬上限。兜底用：万一某个设备/驱动的手势尾巴异常长，也不能把用户
 * 永久锁死 —— 超过这个时长就放行。
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
      /** 上一次实例的 `wheelSwipe`：一次触控板手势跨越多次图片切换，见构造末尾 */
      wheelState: null,
      canSwipe: () => false,
      onChange: () => {},
      onDismissProgress: () => {},
      onDismissRelease: () => {},
      onSwipeRelease: () => {},
      onWheelSwipe: () => {},
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
    if (!this.enabled) return;
    this.o.onUserActivity?.();
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
      const dx = event.clientX - this.start.x;
      const direction = dx < 0 ? 1 : -1;
      const passed =
        Math.abs(dx) > this.o.view().w * SWIPE_DISTANCE_RATIO ||
        (Math.abs(this.vel.x) > SWIPE_VELOCITY && Math.abs(dx) > SWIPE_MIN_PX);
      if (passed && this.o.canSwipe?.(direction)) {
        // 交给调用方接着手指的当前位置播完剩下的位移
        this.o.onSwipeRelease(direction);
      } else {
        this.animateTrackTo(0, 280, EASE_SOFT);
      }
    } else {
      const speed = Math.hypot(this.vel.x, this.vel.y);
      if (speed > 0.08) this.fling();
      else this.springBack();
    }

    this.mode = null;
    this.emit();
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

    this.o.onUserActivity?.();

    // 横向判定必须排在 `enabled` 闸门**之前**。
    // 切换动画那 300ms 里 `viewer.go()` 会把 enabled 关掉，但同一串惯性尾巴
    // 并没有跟着停 —— 那段时间若完全不记账，动画一结束累积量就会被重新攒满，
    // 「一次轻甩连翻好几张」多半是这么来的。
    if (this.handleWheelHorizontal(event, dx, dy, this.enabled)) return;

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
   * @param {boolean} canFire 此刻能不能真的切图 —— 切换动画期间是 false，
   *   但那一串 wheel 依然要被「吞下去」记账（见 wheelSwipe.locked）。
   * @returns {boolean} true = 这次输入已被横向路径认领，调用方不要再当纵向处理。
   *   注意「认领」不等于「消费」：还在观察阈值时不调用 preventDefault，
   *   没有被这一条用掉的方向依旧还给浏览器。
   */
  handleWheelHorizontal(event, dx, dy, canFire) {
    const now = performance.now();
    const prev = this.wheelSwipe;
    const sincePrev = now - prev.at;

    // 静置太久 → 换了手势，累积、峰值、锁定全部作废。
    // 顺序要紧：必须在**重新取** this.wheelSwipe 之前重置，否则 s 会指向刚被
    // 丢掉的那个对象 —— 每个事件都从 0 开始累加，阈值永远攒不够。
    if (sincePrev > WHEEL_GESTURE_GAP_MS) this.resetWheelSwipe();
    const s = this.wheelSwipe;
    s.at = now;

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

    // 轴向归属：整串序列只认一次，之后竖直方向再大的增量也不再翻回去
    if (s.axis === null) {
      if (dx !== 0 && Math.abs(dx) > WHEEL_AXIS_RATIO * Math.abs(dy)) s.axis = 'x';
      else if (dy !== 0) s.axis = 'y';
    }
    if (s.axis !== 'x') return false;

    const mag = Math.abs(dx);

    // 已经翻过一张：把后面那一串惯性尾巴全吞掉，一次手势只许翻一张
    if (s.locked) {
      if (!this.wheelTailOver(s, sincePrev, dx, mag, now)) {
        event.preventDefault();
        return true;
      }
      // 尾巴结束了 → 从这里开始算新的一次手势（时间戳要留下来）
      this.resetWheelSwipe();
      this.wheelSwipe.at = now;
    }

    const t = this.wheelSwipe;
    if (!t.locked) t.peak = Math.max(t.peak, mag);
    t.x += dx;

    // 已放大：横向的含义是「拖动画面」，不是翻页
    if (this.isZoomed) {
      this.cancelAnim();
      event.preventDefault();
      this.panByWheelX(dx);
      return true;
    }

    // 一张图时横向没有任何意义，连回弹都别给 —— 邻槽是空的，回弹会把黑边拉出来
    if (!this.o.canSwipe?.(1) && !this.o.canSwipe?.(-1)) return true;

    // 还没走出抖动带 → 继续观察，不消费（也因此不阻止默认行为）
    const travel = Math.abs(t.x) - WHEEL_SWIPE_DEADZONE;
    if (travel < WHEEL_SWIPE_TRAVEL) return true;

    // 方向要和单指横滑完全一致：那里的写法是 `dx < 0 ? 1 : -1`（手指向左拖
    // → 下一张）。这里的 t.x 同样是屏幕坐标系里的手势位移（向左为负），所以
    // 必须取负号 —— 之前漏了这一个负号，触控板上的左右就整个反过来了。
    const direction = -Math.sign(t.x);
    event.preventDefault();
    // 先落锁再翻页：后面的尾巴（包括切图动画期间那一段）一律被吞，
    // 而不是等翻页回调回来再补一道保险 —— 那时尾巴已经溜过去一大截了。
    this.lockWheelSwipe(now, direction);
    if (canFire) this.o.onWheelSwipe?.(direction);
    return true;
  }

  /**
   * 进入「这一串已经翻过一张」的状态：后续增量只记账、不再触发。
   *
   * 峰值 `peak` 特意保留 —— 它是后面判断「用户是不是重新发力了」的基准，
   * 清掉会让重启判据恒真，等于锁了个寂寞。
   */
  lockWheelSwipe(now, direction) {
    const s = this.wheelSwipe;
    s.x = 0;
    s.locked = true;
    s.lockedAt = now;
    s.dir = direction;
  }

  /**
   * 锁定能不能解除 —— 也就是「上一次已经翻完，现在允许再翻一张了吗」。
   *
   * 四条出口，前一条不成立才看下一条：
   *   1. 至少要锁够覆盖切换动画的时长，这段时间里什么都不认；
   *   2. 尾巴确实停了（静默 ≥ WHEEL_TAIL_GAP_MS）之后，又来了一下有意识的推动；
   *   3. 掉头了 —— 惯性尾巴不会自己反向，反向就是用户改主意了；
   *   4. 幅度回到接近本次峰值 —— 用户又推了一把。鼠标滚轮（每格幅度恒定、
   *      没有衰减尾巴）正是靠这条做到「一格一张」。
   *
   * 另外挂了一条硬上限：锁定超过 WHEEL_LOCK_MAX_MS 无条件放行，避免某个设备的
   * 手势尾巴异常长时把用户永久锁住。
   */
  wheelTailOver(s, sincePrev, dx, mag, now) {
    if (now - s.lockedAt < WHEEL_SWITCH_LOCK_MS) return false;
    if (now - s.lockedAt > WHEEL_LOCK_MAX_MS) return true;
    if (mag < WHEEL_RESTART_MIN_PX) return false;
    if (sincePrev >= WHEEL_TAIL_GAP_MS) return true;
    if (Math.sign(dx) === -Math.sign(s.dir) && mag >= WHEEL_REVERSE_MIN_PX) return true;
    return mag >= s.peak * WHEEL_RESTART_RATIO;
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
   * 清空一次横向 wheel 手势的累积。
   *
   * `axis` 也要一起清：它是「这一串已经认了横向」的凭据，留着会让下一次
   * 纯纵向的滚轮也被判进横向分支，表现为「滚轮突然不缩放了」。
   */
  resetWheelSwipe() {
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
    /** 累积位移（手势方向） */
    x: 0,
    /** 上一个事件的时间戳：既用于判「换了手势」，也用于判「尾巴停了」 */
    at: 0,
    /** 本次手势里出现过的最大的单次增量，作为「重新发力」的比较基准 */
    peak: 0,
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
