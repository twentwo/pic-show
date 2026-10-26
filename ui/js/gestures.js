/**
 * 手势控制器：滚轮 / 双击 / 双指捏合 / 拖拽平移 / 下拉关闭。
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
/** 双击识别窗口 */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 26;
/** 超过这个距离才算拖拽，否则视为点击 */
const TAP_SLOP = 4;
/** 惯性衰减系数（每帧） */
const FLING_FRICTION = 0.93;

export class Gestures {
  constructor(el, opts) {
    this.el = el;
    this.o = {
      base: () => ({ w: 0, h: 0 }),
      view: () => ({ left: 0, top: 0, w: 0, h: 0 }),
      maxScale: 8,
      onChange: () => {},
      onDismissProgress: () => {},
      onDismissRelease: () => {},
      onTap: () => {},
      onDoubleTap: () => {},
      onUserActivity: () => {},
      ...opts
    };

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.rawX = 0;
    this.rawY = 0;
    this.dismissProgress = 0;

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
    this.enabled = true;

    this._onDown = (event) => this.onPointerDown(event);
    this._onMove = (event) => this.onPointerMove(event);
    this._onUp = (event) => this.onPointerUp(event);
    this._onCancel = (event) => this.onPointerCancel(event);
    this._onWheel = (event) => this.onWheel(event);
    this._onDbl = (event) => this.onDoubleClick(event);

    this.attach();
  }

  attach() {
    this.el.addEventListener('pointerdown', this._onDown);
    this.el.addEventListener('wheel', this._onWheel, { passive: false });
    this.el.addEventListener('dblclick', this._onDbl);
    // move / up 挂在 window 上：指针移出元素也不会丢失事件
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onCancel);
  }

  detach() {
    this.el.removeEventListener('pointerdown', this._onDown);
    this.el.removeEventListener('wheel', this._onWheel);
    this.el.removeEventListener('dblclick', this._onDbl);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onCancel);
    this.cancelAnim();
  }

  /* ---------------- 状态 ---------------- */

  get isZoomed() {
    return this.scale > 1.02;
  }

  transformString() {
    return `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
  }

  apply() {
    this.el.style.transform = this.transformString();
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

  /** 回到适配尺寸 */
  reset(animate = true) {
    this.rawX = 0;
    this.rawY = 0;
    this.dismissProgress = 0;
    return this.animateTo(
      { scale: 1, tx: 0, ty: 0 },
      animate ? 280 : 0,
      EASE_OUT
    );
  }

  /** 到首尾时的轻微横向回弹提示 */
  nudge(direction) {
    const view = this.o.view();
    const base = this.o.base();
    const from = this.transformString();

    this.rawX = -direction * 26;
    const st = settle(view, base, this.scale, this.rawX, this.rawY, RUBBER);
    const to = `translate3d(${st.x}px, ${st.y}px, 0) scale(${this.scale})`;

    this.cancelAnim();
    const anim = this.el.animate(
      { transform: [from, to] },
      { duration: 130, easing: EASE_OUT, fill: 'none' }
    );
    this.anim = anim;
    this.tx = st.x;
    this.ty = st.y;
    this.apply();

    return anim.finished
      .then(() => {
        this.anim = null;
        return this.springBack();
      })
      .catch(() => {});
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
        this.el.setPointerCapture(event.pointerId);
      } catch {
        /* 某些浏览器对鼠标事件不支持捕获 */
      }
    } else if (this.pointers.size === 2) {
      this.moved = true; // 已进入多指，后续不再判定为点击
      this.beginPinch();
    }

    this.emit();
  }

  onPointerMove(event) {
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
      this.mode = this.isZoomed || !isMostlyVertical(dx, dy) ? 'pan' : 'dismiss';
    }
    if (!this.moved) return;

    event.preventDefault();

    // 速度平滑（px/ms）
    const now = performance.now();
    const prev = this.last ?? { x: start.x, y: start.y, t: now - 16 };
    const dt = Math.max(1, now - prev.t);
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

    // 双指松开一根：以剩下那根重建基准，避免画面跳一下
    if (this.pointers.size === 1) {
      this.beginPinch();
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

  /* ---------------- 捏合（由 `updateTwoFinger` 分发） ---------------- */

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

  onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    this.o.onUserActivity?.();
    this.cancelAnim();

    const view = this.o.view();
    // 触控板捏合在浏览器里表现为 ctrlKey=true 的 wheel 事件
    const intensity = event.ctrlKey ? 0.012 : 0.0022;
    const delta = normalizeWheel(event);
    const ratio = Math.exp(-delta * intensity);
    const p = {
      x: event.clientX - (view.left + view.w / 2),
      y: event.clientY - (view.top + view.h / 2)
    };
    this.zoomBy(ratio, p);
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

/** 统一不同浏览器 / 设备的 wheel 增量量纲 */
function normalizeWheel(event) {
  if (event.deltaMode === 1) return event.deltaY * 16; // DOM_DELTA_LINE
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight; // DOM_DELTA_PAGE
  return event.deltaY;
}
