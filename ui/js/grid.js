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
    /** 上次布局用的容器尺寸；用来判断这次变化是否真的需要重排 */
    this._w = 0;
    this._h = 0;
    /** 重排也走 rAF：连续拖窗口时一帧只算一次 */
    this._layoutRaf = 0;

    this.root.addEventListener('scroll', () => this.schedule(), {
      passive: true
    });

    this._ro = new ResizeObserver(() => this.onResize());
    this._ro.observe(this.root);
    // ResizeObserver 在个别 webview 上「最小化再还原」时不回调，用 window 事件兜底
    this._onWinResize = () => this.onResize();
    window.addEventListener('resize', this._onWinResize);

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

  /**
   * 容器尺寸变化。
   *
   * 必须区分「宽度变」和「只是高度变」：
   *   * 宽度变 —— 每行张数、行高全变了，要重排（O(n)）；
   *   * 只高度变 —— 布局不变，只是可见行数变了，重新挂载即可。
   *
   * 尺寸为 0（窗口最小化、元素隐藏）一律跳过：那时算出来的是垃圾布局
   * （每行一张、行高被拉满），用它去污染界面毫无意义；尺寸恢复时自然会
   * 再回调一次，那时再算。
   */
  onResize() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w <= 0 || h <= 0) return;

    if (w === this._w) {
      if (h === this._h) return;
      this._h = h;
      this.schedule();
      return;
    }

    // 首次布局（_w 还是 0）不需要锚定，之后每次宽度变化都要锚定
    const anchor = this._w > 0 && this.rows.length > 0;
    this._w = w;
    this._h = h;

    // 先取消上一帧排的活再重排：
    // 一是连续拖动时「最后一次尺寸」生效；
    // 二是万一那次 rAF 被丢掉（页面隐藏 / 元素被移走），句柄会一直挂着，
    //    若只用「有句柄就 return」的写法，之后的 resize 就再也不响应了。
    if (this._layoutRaf) cancelAnimationFrame(this._layoutRaf);
    this._layoutRaf = requestAnimationFrame(() => {
      this._layoutRaf = 0;
      this.relayout({ anchor });
    });
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.anchor] 重排后保持「视口顶部那一项」的视觉位置。
   *   窗口尺寸一变，行高就变，若不锚定，用户正看着的那排会被推到别处。
   */
  relayout({ anchor = false } = {}) {
    const prevTop = this.root.scrollTop;
    const anchorIndex = anchor ? this.topIndex(prevTop) : -1;
    const anchorRow = anchorIndex >= 0 ? this.rows[this.rowOf[anchorIndex]] : null;
    // 该项距视口顶部的距离，重排后要原样保持
    const anchorShift = anchorRow ? prevTop - anchorRow.y : 0;

    this._w = this.root.clientWidth || this._w;
    this._h = this.root.clientHeight || this._h;
    this.computeRows();
    this.spacer.style.height = `${this.totalHeight}px`;

    if (anchorIndex >= 0) {
      const row = this.rows[this.rowOf[anchorIndex]];
      if (row) this.root.scrollTop = Math.max(0, row.y + anchorShift);
    }

    this.update();
  }

  /** 贪心分行的 justified 布局。 */
  computeRows() {
    const contentW = Math.max(80, (this.root.clientWidth || this._w) - PAD * 2);
    // 目标行高跟着容器走：宽屏保持 210 的观感，窄屏自动降下来，
    // 于是手机上每行 2~3 张、桌面上 6~8 张，不用写两套布局。
    const targetH = clamp(contentW / 4, MIN_ROW_H, TARGET_ROW_H);
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
        if (count > 0 && projected < targetH) break;
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
    const first = this.rowIndexAt(top);

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
      const existing = this.mounted.get(index);
      // 关键：重排之后**已挂载**的格子也必须重新写一遍几何。
      // 只给新挂载的写几何的话，视口里那一屏会一直留着旧宽度/旧位置的
      // inline style（只有滚出去再滚回来、经池子复用才会更新），
      // 表现就是改完窗口大小后缩略图重叠、留白、溢出容器。
      if (existing) this.refresh(index, existing);
      else this.mount(index);
    }
  }

  /** 二分：第一个「底边仍在 y 下方」的行 */
  rowIndexAt(y) {
    const rows = this.rows;
    let lo = 0;
    let hi = rows.length - 1;
    let ans = Math.max(0, rows.length - 1);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].y + rows[mid].h >= y) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  /** 视口顶部那一项，用作重排锚点 */
  topIndex(scrollTop = this.root.scrollTop) {
    if (!this.rows.length) return -1;
    const row = this.rows[this.rowIndexAt(scrollTop)];
    return row?.cells[0]?.index ?? -1;
  }

  cellOf(index) {
    const rowIndex = this.rowOf[index];
    if (rowIndex == null || rowIndex < 0) return null;
    const row = this.rows[rowIndex];
    if (!row) return null;
    return { row, cell: row.cells.find((c) => c.index === index) ?? null };
  }

  /** 只重新写几何，不动缩略图请求 —— 重排时不能让已加载的图片闪一下 */
  refresh(index, el) {
    const found = this.cellOf(index);
    if (!found?.cell) return;
    this.place(el, found.cell, found.row);
  }

  place(el, cell, row) {
    el.style.width = `${cell.w}px`;
    el.style.height = `${cell.h}px`;
    el.style.transform = `translate3d(${cell.x}px, ${row.y}px, 0)`;
  }

  mount(index) {
    const found = this.cellOf(index);
    if (!found?.cell) return;
    const { row, cell } = found;

    const el = this.pool.pop() ?? this.createCell();
    el.dataset.index = String(index);
    this.place(el, cell, row);
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

    const found = this.cellOf(index);
    if (!found?.cell) return null;
    const { row, cell } = found;

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
    const found = this.cellOf(index);
    if (!found) return;
    const row = found.row;

    const top = this.root.scrollTop;
    const vh = this.root.clientHeight;
    let next = top;

    if (row.y < top) next = Math.max(0, row.y - PAD);
    else if (row.y + row.h > top + vh) next = row.y + row.h - vh + PAD;

    if (next !== top) this.root.scrollTop = next;
    this.update();
  }
}
