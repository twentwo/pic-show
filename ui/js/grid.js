/**
 * 虚拟化「等高行」缩略图网格（Google Photos / Picasa 那种 justified 布局）。
 *
 * 为什么不用简单的方形九宫格：
 *   方形格子要用 `object-fit: cover` 裁掉图片，于是缩略图里显示的是
 *   「原图被裁掉的一部分」。从缩略图展开到全屏时，两端形状对不上，
 *   FLIP 转场就会出现跳变。等高行布局让每张缩略图完整呈现原图比例，
 *   展开动画才能做到像素级连续。
 *
 * 虚拟化三件事：
 *   1. 布局阶段一次性算出所有行的 y/h 及行内每张图的 x/w（O(n)，两万张也很快）；
 *   2. 滚动时用二分定位可见行区间，只挂载 ±2 行；
 *   3. 移出可视区的节点进池复用，避免频繁创建/销毁导致 GC 抖动；
 *      缩略图延迟 60ms 才真正请求，快速滚动时大量请求在发出前就被取消。
 */

import { placeholderUrl, thumbUrl, THUMB_SIZE, GRID_ROW_H } from './api.js';

const GAP = 4;
const PAD = 10;
const TARGET_ROW_H = GRID_ROW_H;
const MIN_ROW_H = 90;
const MAX_ROW_H = 340;
const MAX_PER_ROW = 10;
const OVERSCAN_ROWS = 2;
const THUMB_DELAY_MS = 60;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function aspect(item) {
  if (!item?.width || !item?.height) return 1.5;
  return clamp(item.width / item.height, 0.2, 5);
}

export class Grid {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root   滚动容器
   * @param {HTMLElement} opts.spacer 撑开滚动高度的占位层
   * @param {(index:number, el:HTMLElement)=>void} opts.onActivate
   */
  constructor({ root, spacer, onActivate }) {
    this.root = root;
    this.spacer = spacer;
    this.onActivate = onActivate;

    this.items = [];
    this.rows = [];
    this.rowOf = new Int32Array(0);
    this.mounted = new Map();
    this.pool = [];
    this.totalHeight = 0;
    this._raf = 0;
    this._idleTimer = 0;

    this.root.addEventListener('scroll', () => this.schedule(), {
      passive: true
    });

    this._ro = new ResizeObserver(() => this.relayout());
    this._ro.observe(this.root);

    this.root.addEventListener('click', (event) => {
      const cell = event.target?.closest?.('.cell');
      if (cell) this.onActivate?.(Number(cell.dataset.index), cell);
    });
  }

  get count() {
    return this.items.length;
  }

  setItems(items) {
    this.unmountAll();
    this.items = Array.isArray(items) ? items : [];
    this.relayout();
  }

  relayout() {
    this.computeRows();
    this.spacer.style.height = `${this.totalHeight}px`;
    this.update();
  }

  /** 贪心分行的 justified 布局。 */
  computeRows() {
    const contentW = Math.max(80, this.root.clientWidth - PAD * 2);
    const total = this.items.length;

    this.rows = [];
    this.rowOf = new Int32Array(total).fill(-1);

    let y = PAD;
    let i = 0;

    while (i < total) {
      let sum = 0;
      let count = 0;

      while (i < total && count < MAX_PER_ROW) {
        const nextSum = sum + aspect(this.items[i]);
        const nextCount = count + 1;
        const projected = (contentW - GAP * (nextCount - 1)) / nextSum;
        // 再加一张就会让行高低于目标 —— 收手，让这一行保持「够高」
        if (count > 0 && projected < TARGET_ROW_H) break;
        sum = nextSum;
        count = nextCount;
        i += 1;
      }

      const rowH = clamp(
        (contentW - GAP * (count - 1)) / sum,
        MIN_ROW_H,
        MAX_ROW_H
      );

      const cells = [];
      let cursor = PAD;
      for (let k = i - count; k < i; k += 1) {
        const x = cursor;
        // 累加后再取整，保证右边缘对齐、不留累积误差
        cursor += rowH * aspect(this.items[k]) + GAP;
        cells.push({
          index: k,
          x,
          w: Math.round(cursor - GAP) - x,
          h: Math.round(rowH)
        });
      }

      const rowIndex = this.rows.length;
      this.rows.push({ y, h: Math.round(rowH), cells });
      for (const cell of cells) this.rowOf[cell.index] = rowIndex;

      y += Math.round(rowH) + GAP;
    }

    this.totalHeight = y - GAP + PAD;
  }

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => this.update());
  }

  update() {
    this._raf = 0;
    const { rows } = this;

    if (!rows.length) {
      this.unmountAll();
      return;
    }

    const top = this.root.scrollTop;
    const bottom = top + this.root.clientHeight;

    // 二分：第一个「底边仍在视口下方」的行
    let lo = 0;
    let hi = rows.length - 1;
    let first = rows.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].y + rows[mid].h >= top) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    let last = first;
    while (last + 1 < rows.length && rows[last + 1].y <= bottom) last += 1;

    const from = Math.max(0, first - OVERSCAN_ROWS);
    const to = Math.min(rows.length - 1, last + OVERSCAN_ROWS);

    const needed = new Set();
    for (let r = from; r <= to; r += 1) {
      for (const cell of rows[r].cells) needed.add(cell.index);
    }

    for (const [index, el] of this.mounted) {
      if (!needed.has(index)) {
        this.recycle(el);
        this.mounted.delete(index);
      }
    }
    for (const index of needed) {
      if (!this.mounted.has(index)) this.mount(index);
    }
  }

  mount(index) {
    const rowIndex = this.rowOf[index];
    if (rowIndex == null || rowIndex < 0) return;
    const row = this.rows[rowIndex];
    const cell = row.cells.find((c) => c.index === index);
    if (!cell) return;

    const el = this.pool.pop() ?? this.createCell();
    el.dataset.index = String(index);
    el.style.width = `${cell.w}px`;
    el.style.height = `${cell.h}px`;
    el.style.transform = `translate3d(${cell.x}px, ${row.y}px, 0)`;
    el.classList.add('is-pending');
    el.classList.remove('is-loaded', 'is-failed');

    const item = this.items[index];
    el.firstElementChild.style.backgroundImage = `url("${placeholderUrl(item.id)}")`;

    const img = el.lastElementChild;
    img.removeAttribute('src');

    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => {
      // 延迟期间节点可能已被复用到别的图片上，那就别再发请求了
      if (el.dataset.index !== String(index)) return;
      img.src = thumbUrl(item.id, THUMB_SIZE);
    }, THUMB_DELAY_MS);

    this.mounted.set(index, el);
    this.spacer.appendChild(el);
  }

  recycle(el) {
    clearTimeout(el.__timer);
    el.lastElementChild.removeAttribute('src');
    el.classList.remove('is-pending', 'is-loaded', 'is-failed');
    el.remove();
    if (this.pool.length < 240) this.pool.push(el);
  }

  createCell() {
    const el = document.createElement('div');
    el.className = 'cell';

    const ph = document.createElement('div');
    ph.className = 'cell-ph';

    const img = document.createElement('img');
    img.className = 'cell-thumb';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    img.addEventListener('load', () => {
      el.classList.add('is-loaded');
      el.classList.remove('is-pending');
    });
    img.addEventListener('error', () => {
      // 主动清空 src 也会触发 error，这里只标记真正的失败
      if (img.getAttribute('src')) el.classList.add('is-failed');
    });

    el.append(ph, img);
    return el;
  }

  unmountAll() {
    for (const [, el] of this.mounted) this.recycle(el);
    this.mounted.clear();
  }

  cellFor(index) {
    return this.mounted.get(index) ?? null;
  }

  /** 目标格子的页面坐标矩形（未挂载时按布局推算）。 */
  getRect(index) {
    const el = this.mounted.get(index);
    if (el) return el.getBoundingClientRect();

    const rowIndex = this.rowOf[index];
    if (rowIndex == null || rowIndex < 0) return null;
    const row = this.rows[rowIndex];
    const cell = row.cells.find((c) => c.index === index);
    if (!cell) return null;

    const host = this.root.getBoundingClientRect();
    const left = host.left + cell.x;
    const top = host.top + row.y - this.root.scrollTop;
    return {
      x: left,
      y: top,
      left,
      top,
      width: cell.w,
      height: cell.h,
      right: left + cell.w,
      bottom: top + cell.h
    };
  }

  /** 滚动到指定图片并同步完成挂载，供关闭动画取落点矩形。 */
  ensureVisible(index) {
    const rowIndex = this.rowOf[index];
    if (rowIndex == null || rowIndex < 0) return;

    const row = this.rows[rowIndex];
    const top = this.root.scrollTop;
    const vh = this.root.clientHeight;
    let next = top;

    if (row.y < top) next = Math.max(0, row.y - PAD);
    else if (row.y + row.h > top + vh) next = row.y + row.h - vh + PAD;

    if (next !== top) this.root.scrollTop = next;
    this.update();
  }
}
