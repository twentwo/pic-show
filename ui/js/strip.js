/**
 * 全屏查看器底部的「胶片条」（filmstrip）：缩略图列表 + 按图跳转。
 *
 * 三个约束决定了这里的写法：
 *   1. **不能渲染全部。** 一个文件夹几千张图，节点数必须恒定 —— 所以只渲染
 *      当前项 ±`WINDOW_RADIUS` 的窗口，靠绝对定位 + 撑开的容器宽度伪造出
 *      完整的滚动条。窗口随当前项滑动而增量增删，不是整体重建，避免闪烁。
 *   2. **缩略图 URL 必须与网格一致**（`THUMB_SIZE`），这样从胶片条跳到某张图时
 *      低分辨率底图直接命中 webview 缓存，展开动画不会先白一下。
 *   3. **延迟请求**：窗口刚滑进来就发请求，快速拖动时会浪费大量解码；
 *      与网格一样延迟一拍，期间节点可能被复用/回收，请求自然作废。
 */

import { thumbUrl, placeholderUrl, THUMB_SIZE } from './api.js';

/** 桌面 / 窄屏两套尺寸（与 CSS 变量保持一致） */
const ITEM_W = 78;
const ITEM_GAP = 6;
const ITEM_W_COMPACT = 54;
const ITEM_GAP_COMPACT = 4;
const COMPACT_MAX_WIDTH = 720;

/** 窗口半径：DOM 节点数恒定为 2R+1 */
const WINDOW_RADIUS = 40;
/** 缩略图延迟请求时间 */
const THUMB_DELAY_MS = 40;

export class Strip {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root   滚动容器 `.viewer-strip`
   * @param {HTMLElement} opts.inner  绝对定位子项的定位层
   * @param {(index:number)=>void} opts.onJump
   */
  constructor({ root, inner, onJump }) {
    this.root = root;
    this.inner = inner;
    this.onJump = onJump;

    this.items = [];
    this.index = -1;
    this.mounted = new Map();
    this.metrics = measure();

    this.root.addEventListener('click', (event) => {
      const node = event.target?.closest?.('.strip-item');
      if (node) this.onJump?.(Number(node.dataset.index));
    });

    this._resizeRaf = 0;
    this._ro = new ResizeObserver(() => this.scheduleResize());
    this._ro.observe(this.root);
  }

  get count() {
    return this.items.length;
  }

  setItems(items) {
    this.unmountAll();
    this.items = Array.isArray(items) ? items : [];
    this.applyMetrics();
  }

  /**
   * 高亮并居中某一项。
   * @param {number} index
   * @param {boolean} immediate 首次进入时用瞬时定位，避免平滑滚动的「飞过去」
   */
  focus(index, { immediate = false } = {}) {
    this.index = index;
    this.renderWindow();
    this.markCurrent();
    this.scrollToCurrent(immediate);
  }

  /** 连续拖窗口时 RO 每帧回调，合并到一帧里算一次 */
  scheduleResize() {
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = 0;
      this.onResize();
    });
  }

  onResize() {
    // 隐藏 / 最小化时宽度为 0，此时的「居中位置」没有意义，算出来还会
    // 把当前项推出视口；等尺寸恢复后再算。
    if (this.root.clientWidth <= 0) return;

    const next = measure();
    if (next.itemW !== this.metrics.itemW || next.gap !== this.metrics.gap) {
      this.metrics = next;
      this.applyMetrics();
    }
    // 容器宽度变了就得重新居中：即使缩略图尺寸没跨断点（比如 1400 → 900），
    // 原来居中那一项也会因为可视宽度变小而跑出视口。
    if (this.index >= 0) this.scrollToCurrent(true);
  }

  applyMetrics() {
    const { itemW, gap } = this.metrics;
    this.root.style.setProperty('--strip-item-w', `${itemW}px`);
    this.root.style.setProperty('--strip-gap', `${gap}px`);
    this.inner.style.width = `${this.items.length * (itemW + gap)}px`;
    for (const [index, el] of this.mounted) this.place(el, index);
  }

  place(el, index) {
    const { itemW, gap } = this.metrics;
    el.style.left = `${index * (itemW + gap)}px`;
  }

  /* ------------------------------------------------------------------ *
   * 窗口渲染
   * ------------------------------------------------------------------ */

  renderWindow() {
    if (!this.items.length) return;

    const lo = Math.max(0, this.index - WINDOW_RADIUS);
    const hi = Math.min(this.items.length - 1, this.index + WINDOW_RADIUS);

    for (const [index, el] of this.mounted) {
      if (index < lo || index > hi) {
        this.recycle(el);
        this.mounted.delete(index);
      }
    }
    for (let i = lo; i <= hi; i += 1) {
      if (!this.mounted.has(i)) this.mount(i);
    }
  }

  mount(index) {
    const item = this.items[index];
    if (!item) return;

    const el = document.createElement('div');
    el.className = 'strip-item is-pending';
    el.dataset.index = String(index);
    el.title = item.name ?? '';
    this.place(el, index);
    el.style.backgroundImage = `url("${placeholderUrl(item.id)}")`;

    const img = document.createElement('img');
    img.className = 'strip-img';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    img.addEventListener('load', () => {
      el.classList.add('is-loaded');
      el.classList.remove('is-pending');
    });
    img.addEventListener('error', () => {
      // 主动清空 src 也会触发 error，只有真的带 src 才算失败
      if (img.getAttribute('src')) el.classList.add('is-failed');
    });

    el.appendChild(img);
    el.__img = img;

    el.__timer = setTimeout(() => {
      if (el.dataset.index !== String(index)) return;
      img.src = thumbUrl(item.id, THUMB_SIZE);
    }, THUMB_DELAY_MS);

    this.mounted.set(index, el);
    this.inner.appendChild(el);
  }

  recycle(el) {
    clearTimeout(el.__timer);
    el.__img?.removeAttribute('src');
    el.remove();
  }

  unmountAll() {
    for (const [, el] of this.mounted) this.recycle(el);
    this.mounted.clear();
  }

  markCurrent() {
    for (const [index, el] of this.mounted) {
      el.classList.toggle('is-current', index === this.index);
    }
  }

  scrollToCurrent(immediate = false) {
    const { itemW, gap } = this.metrics;
    const center = this.index * (itemW + gap) + itemW / 2;
    const target = Math.max(0, center - this.root.clientWidth / 2);

    if (immediate || !this.root.isConnected) {
      this.root.scrollLeft = target;
      return;
    }
    // 用原生平滑滚动：比手搓动画省事，且能响应中途打断
    try {
      this.root.scrollTo({ left: target, behavior: 'smooth' });
    } catch {
      this.root.scrollLeft = target;
    }
  }
}

function measure() {
  const compact = window.innerWidth <= COMPACT_MAX_WIDTH;
  return compact
    ? { itemW: ITEM_W_COMPACT, gap: ITEM_GAP_COMPACT }
    : { itemW: ITEM_W, gap: ITEM_GAP };
}
