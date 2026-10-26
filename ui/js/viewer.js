/**
 * 全屏查看器。
 *
 * 三件核心事：
 *   1. **连续性转场（FLIP）** —— 打开时先把大图摆到缩略图的矩形上，再动画回
 *      适配位置；关闭时反向。因为两端宽高比一致，缩放是等比的，视觉上就是
 *      「缩略图自己长大了」，而不是两张图交叉淡入淡出。
 *   2. **缩放 / 平移** —— 全部交给 Gestures，这里只负责把变化同步到 UI
 *      （缩放百分比、背景透明度、光标样式）。
 *   3. **渐进加载** —— 先用网格里已经缓存的缩略图当底图，原图到位后淡入。
 */

import {
  fullUrl,
  thumbUrl,
  maxEdgeFor,
  preload,
  revealImage
} from './api.js';
import { fitBox, clamp, mapBoxToRect } from './geometry.js';
import { Gestures } from './gestures.js';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** 静止多久后自动隐藏控件 */
const IDLE_MS = 2200;
/** 双击放大的目标倍率（相对适配尺寸） */
const DOUBLE_TAP_SCALE = 2.6;
/** 转场时长 */
const OPEN_MS = 340;
const CLOSE_MS = 300;

export class Viewer {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root #viewer
   * @param {import('./grid.js').Grid} opts.grid
   * @param {(message:string)=>void} opts.onError
   */
  constructor({ root, grid, onError = () => {} }) {
    this.root = root;
    this.grid = grid;
    this.onError = onError;

    this.items = [];
    this.index = -1;
    this.isOpen = false;
    this.closing = false;
    this.switching = false;

    this.slide = null;
    this.full = null;
    this.box = { w: 0, h: 0 };
    this.backdropOpacity = 0;
    this._idle = 0;

    this.backdrop = root.querySelector('.viewer-backdrop');
    this.stage = root.querySelector('.viewer-stage');
    this.titleEl = root.querySelector('.viewer-title');
    this.counterEl = root.querySelector('.viewer-counter');
    this.zoomEl = root.querySelector('.viewer-zoom');

    root
      .querySelector('.viewer-close')
      .addEventListener('click', () => this.close());
    root
      .querySelector('.nav-btn.prev')
      .addEventListener('click', () => this.go(-1));
    root
      .querySelector('.nav-btn.next')
      .addEventListener('click', () => this.go(1));
    root
      .querySelector('.zoom-in')
      .addEventListener('click', () => this.zoomBy(1.35));
    root
      .querySelector('.zoom-out')
      .addEventListener('click', () => this.zoomBy(1 / 1.35));
    root.querySelector('.viewer-zoom').addEventListener('click', () => this.fit());
    root.querySelector('.reveal').addEventListener('click', () => {
      const item = this.currentItem;
      if (item) {
        revealImage(item.id).catch((error) => this.onError(String(error)));
      }
    });

    this.backdrop.addEventListener('click', () => this.close());

    this._onKey = (event) => this.onKeyDown(event);
    this._onResize = () => this.onResize();
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('resize', this._onResize);
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
  }

  get currentItem() {
    return this.items[this.index] ?? null;
  }

  view() {
    return { left: 0, top: 0, w: window.innerWidth, h: window.innerHeight };
  }

  /* ------------------------------------------------------------------ *
   * 打开 / 关闭
   * ------------------------------------------------------------------ */

  open(index, originEl = null) {
    if (this.isOpen || this.closing || !this.items.length) return;

    this.index = clamp(index, 0, this.items.length - 1);
    this.originEl = originEl;

    const item = this.items[this.index];
    const built = this.buildSlide(item);

    this.slide = built.slide;
    this.full = built.full;
    this.box = built.box;
    this.stage.replaceChildren(built.slide);

    this.root.hidden = false;
    this.root.classList.remove('is-idle');
    this.setBackdrop(0);

    this.attachGestures();
    this.updateInfo();

    const from = originEl?.getBoundingClientRect?.() ?? null;

    if (from && from.width > 0 && from.height > 0) {
      // FLIP：起点 = 缩略图矩形，终点 = 适配矩形
      const { scale, tx, ty } = mapBoxToRect(this.box, from, this.view());
      const anim = built.slide.animate(
        {
          transform: [
            `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`,
            'translate3d(0px, 0px, 0) scale(1)'
          ]
        },
        { duration: OPEN_MS, easing: EASE, fill: 'none' }
      );
      this.fadeBackdrop(1, 280);
      // 转场跑完再拉原图，避免大图解码抢走转场的帧
      anim.finished
        .then(() => {
          this.startFullLoad();
          this.preloadNeighbors();
        })
        .catch(() => {});
    } else {
      built.slide.animate({ opacity: [0, 1] }, { duration: 200, easing: 'ease-out', fill: 'none' });
      this.fadeBackdrop(1, 200);
      this.startFullLoad();
      this.preloadNeighbors();
    }

    if (this.originEl) this.originEl.classList.add('is-origin-hidden');
    this.isOpen = true;
    this.bumpControls();
  }

  async close({ fromDismiss = false } = {}) {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    // 关闭动画期间冻结手势，否则中途再拖一下会打断 FLIP
    if (this.g) this.g.enabled = false;

    const slide = this.slide;
    if (!slide) {
      this.finishClose();
      return;
    }

    // 放大状态下先收回适配尺寸，这样 FLIP 的起点矩形才是确定的
    if (!fromDismiss && this.g?.isZoomed) {
      await this.g.reset(true);
    }

    // 此刻背景仍不透明，网格的滚动不会被看见
    this.grid.ensureVisible(this.index);
    const target = this.grid.getRect(this.index);

    const start = slide.style.transform || 'translate3d(0px, 0px, 0) scale(1)';
    const startOpacity = this.backdropOpacity;

    let end = 'translate3d(0px, 0px, 0) scale(0.94)';
    if (target && target.width > 0) {
      const { scale, tx, ty } = mapBoxToRect(this.box, target, this.view());
      end = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    }

    slide.animate({ transform: [start, end] }, { duration: CLOSE_MS, easing: EASE, fill: 'none' });
    // 收尾淡出：掩盖「全屏原图 → 网格缩略图」的分辨率落差
    slide.animate({ opacity: [1, 1, 0] }, { duration: CLOSE_MS, easing: 'linear', fill: 'none' });

    const fade = this.backdrop.animate(
      { opacity: [startOpacity, 0] },
      { duration: CLOSE_MS, easing: 'ease-out', fill: 'none' }
    );
    this.backdropOpacity = 0;

    this.root.classList.remove('is-idle');
    if (this.originEl) this.originEl.classList.remove('is-origin-hidden');

    await fade.finished.catch(() => {});
    this.finishClose();
  }

  finishClose() {
    this.g?.detach();
    this.g = null;
    this.slide = null;
    this.full = null;
    this.stage.replaceChildren();
    this.root.hidden = true;
    this.isOpen = false;
    this.closing = false;
    clearTimeout(this._idle);
  }

  /* ------------------------------------------------------------------ *
   * 切换
   * ------------------------------------------------------------------ */

  async go(delta) {
    if (!this.isOpen || this.switching || this.closing) return;

    const target = this.index + delta;
    if (target < 0 || target >= this.items.length) {
      // 到头了，给一个轻微的横向回弹，比无反应友好
      this.g?.nudge(delta);
      return;
    }

    this.switching = true;

    // 先把目标缩略图滚进视口，关闭动画才有落点
    this.grid.ensureVisible(target);

    const previous = this.slide;
    const built = this.buildSlide(this.items[target]);

    this.slide = built.slide;
    this.full = built.full;
    this.box = built.box;
    this.index = target;
    this.stage.appendChild(built.slide);

    const shift = Math.min(180, window.innerWidth * 0.14);
    const options = { duration: 280, easing: EASE, fill: 'none' };

    // 旧图保持原图可见，避免淡出瞬间退回低分辨率底图
    previous.classList.add('is-static');
    previous.animate(
      {
        transform: [
          previous.style.transform || 'translate3d(0px, 0px, 0) scale(1)',
          `translate3d(${-delta * shift}px, 0, 0) scale(0.97)`
        ],
        opacity: [1, 0]
      },
      options
    );

    const incoming = built.slide.animate(
      {
        transform: [
          `translate3d(${delta * shift}px, 0, 0) scale(0.97)`,
          'translate3d(0px, 0px, 0) scale(1)'
        ],
        opacity: [0, 1]
      },
      options
    );

    this.updateInfo();
    this.attachGestures();
    this.syncOrigin(target);
    this.bumpControls();

    await incoming.finished.catch(() => {});
    previous.remove();
    this.startFullLoad();
    this.preloadNeighbors();
    this.switching = false;
  }

  /* ------------------------------------------------------------------ *
   * 缩放
   * ------------------------------------------------------------------ */

  /** 相对「原始像素」的最大倍率：最多放到原图 1.5 倍，且不小于 4 倍适配尺寸 */
  maxScale() {
    const item = this.currentItem;
    if (!item?.width || !this.box?.w) return 8;
    const native = item.width / this.box.w;
    return clamp(Math.max(4, native * 1.5), 4, 32);
  }

  zoomBy(factor) {
    const g = this.g;
    if (!g) return;
    g.zoomTo(g.scale * factor, { x: 0, y: 0 }, true);
  }

  fit() {
    this.g?.reset(true);
  }

  toggleZoom(x, y) {
    const g = this.g;
    if (!g) return;
    if (g.isZoomed) {
      g.reset(true);
      return;
    }
    const view = this.view();
    g.zoomTo(Math.min(g.o.maxScale, DOUBLE_TAP_SCALE), {
      x: x - view.w / 2,
      y: y - view.h / 2
    }, true);
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  buildSlide(item) {
    const view = this.view();
    const box = fitBox(item.width, item.height, view.w, view.h);

    const slide = document.createElement('div');
    slide.className = 'slide';
    slide.style.width = `${box.w}px`;
    slide.style.height = `${box.h}px`;
    slide.style.transform = 'translate3d(0px, 0px, 0) scale(1)';

    // 底图：与网格完全相同的 URL，命中缓存即可立即显示
    const low = document.createElement('img');
    low.className = 'slide-low';
    low.decoding = 'async';
    low.draggable = false;
    low.alt = '';
    low.src = thumbUrl(item.id);

    // 原图
    const full = document.createElement('img');
    full.className = 'slide-full';
    full.decoding = 'async';
    full.draggable = false;
    full.alt = item.name;
    full.addEventListener('load', () => {
      slide.classList.add('is-full');
    });

    slide.append(low, full);
    return { slide, low, full, box };
  }

  attachGestures() {
    this.g?.detach();
    this.g = new Gestures(this.slide, {
      base: () => this.box,
      view: () => this.view(),
      maxScale: this.maxScale(),
      onChange: (g) => {
        this.slide.classList.toggle('is-zoomed', g.isZoomed);
        this.slide.classList.toggle('is-grabbing', Boolean(g.dragging) && g.mode === 'pan');
        this.updateZoomLabel();
      },
      onDismissProgress: (progress) => {
        // 下拉越远背景越透，形成「把图片摘下来」的感觉
        this.setBackdrop(1 - progress * 0.92);
      },
      onDismissRelease: (shouldClose) => {
        if (shouldClose) {
          this.close({ fromDismiss: true });
        } else {
          this.fadeBackdrop(1, 220);
          this.g?.springBack();
        }
      },
      onTap: () => this.bumpControls(),
      onDoubleTap: (x, y) => this.toggleZoom(x, y),
      onUserActivity: () => this.bumpControls()
    });
  }

  /**
   * 让「原始缩略图」跟随当前索引。切换图片后，关闭动画的落点、以及缩略图
   * 的隐藏态，都得挪到新图对应的格子上 —— 否则关回去时会落到旧图位置，
   * 而且旧缩略图会一直隐形。
   */
  syncOrigin(index) {
    if (this.originEl) {
      this.originEl.classList.remove('is-origin-hidden');
      this.originEl = null;
    }
    const cell = this.grid.cellFor?.(index) ?? null;
    if (cell) {
      cell.classList.add('is-origin-hidden');
      this.originEl = cell;
    }
  }

  startFullLoad() {
    const item = this.currentItem;
    if (!item || !this.full) return;
    const src = fullUrl(item.id, maxEdgeFor(item));
    if (this.full.getAttribute('src') !== src) {
      this.full.src = src;
    }
  }

  /** 预取前后各一张的原图，让方向键切换几乎无等待 */
  preloadNeighbors() {
    for (const offset of [1, -1]) {
      const index = this.index + offset;
      if (index >= 0 && index < this.items.length) {
        const item = this.items[index];
        preload(fullUrl(item.id, maxEdgeFor(item)));
      }
    }
  }

  updateInfo() {
    const item = this.currentItem;
    if (!item) return;
    this.titleEl.textContent = item.name;
    this.counterEl.textContent = `${this.index + 1} / ${this.items.length}`;
    this.updateZoomLabel();
  }

  updateZoomLabel() {
    const g = this.g;
    const item = this.currentItem;
    if (!g || !item) return;
    const factor = item.width && this.box?.w
      ? (this.box.w * g.scale) / item.width
      : g.scale;
    this.zoomEl.textContent = `${Math.round(factor * 100)}%`;
  }

  setBackdrop(value) {
    this.backdropOpacity = clamp(value, 0, 1);
    this.backdrop.style.opacity = String(this.backdropOpacity);
  }

  /** 背景独立做透明度过渡，便于与手势状态解耦 */
  fadeBackdrop(to, duration) {
    const from = this.backdropOpacity;
    this.backdropOpacity = clamp(to, 0, 1);
    this.backdrop.style.opacity = String(this.backdropOpacity);
    if (duration > 0 && from !== this.backdropOpacity) {
      this.backdrop.animate({ opacity: [from, this.backdropOpacity] }, {
        duration,
        easing: 'ease-out',
        fill: 'none'
      });
    }
  }

  /**
   * 有交互就重新计时，静止 `IDLE_MS` 后自动隐藏控件（含光标），
   * 让画面只剩下照片本身。
   */
  bumpControls() {
    clearTimeout(this._idle);
    this.root.classList.remove('is-idle');
    this._idle = setTimeout(() => {
      if (this.isOpen && !this.closing) this.root.classList.add('is-idle');
    }, IDLE_MS);
  }

  onResize() {
    if (!this.isOpen) return;
    const item = this.currentItem;
    if (!item) return;

    const view = this.view();
    this.box = fitBox(item.width, item.height, view.w, view.h);
    if (this.slide) {
      this.slide.style.width = `${this.box.w}px`;
      this.slide.style.height = `${this.box.h}px`;
    }
    this.g?.commit({ scale: 1, tx: 0, ty: 0 });
  }

  onKeyDown(event) {
    if (!this.isOpen) return;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.go(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.go(1);
        break;
      case '+':
      case '=':
        event.preventDefault();
        this.zoomBy(1.3);
        break;
      case '-':
      case '_':
        event.preventDefault();
        this.zoomBy(1 / 1.3);
        break;
      case '0':
        event.preventDefault();
        this.fit();
        break;
      default:
        break;
    }
  }
}
