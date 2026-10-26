/**
 * 缩放 / 平移的纯数学工具。
 *
 * 坐标系约定：所有平移量以「视口中心」为原点，配合 CSS
 * `transform-origin: center`，锚点缩放的计算才不会出错。
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * iOS 风格橡皮筋阻尼：越拖越难拖，位移渐近于 limit。
 *   f(x) = limit * (1 - 1 / (x / limit + 1))
 */
export function rubberband(over, limit) {
  if (limit <= 0 || over === 0) return 0;
  const sign = Math.sign(over);
  const x = Math.abs(over);
  return sign * limit * (1 - 1 / (x / limit + 1));
}

/** contain 适配：把 w×h 等比装进 maxW×maxH */
export function fitBox(w, h, maxW, maxH) {
  if (!w || !h) return { w: maxW, h: maxH };
  const s = Math.min(maxW / w, maxH / h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/**
 * 当前缩放下，内容中心允许的平移范围。
 * 内容比视口小时返回 0（居中，不产生平移）。
 */
export function panBounds(view, base, scale) {
  return {
    maxX: Math.max(0, (base.w * scale - view.w) / 2),
    maxY: Math.max(0, (base.h * scale - view.h) / 2)
  };
}

/** 把「理想」平移收敛到边界内，超出部分走橡皮筋。 */
export function settle(view, base, scale, rawX, rawY, limit) {
  const b = panBounds(view, base, scale);
  const cx = clamp(rawX, -b.maxX, b.maxX);
  const cy = clamp(rawY, -b.maxY, b.maxY);
  return {
    x: cx + rubberband(rawX - cx, limit),
    y: cy + rubberband(rawY - cy, limit)
  };
}

/**
 * 锚点缩放：p 为「以视口中心为原点」的坐标，缩放后 p 点保持不动。
 *   p = t + q·s  →  q = (p - t) / s
 *   t' = p - q·s' = p - (p - t)·(s'/s)
 */
export function zoomAround(t, p, ratio) {
  return {
    x: p.x - (p.x - t.x) * ratio,
    y: p.y - (p.y - t.y) * ratio
  };
}

/**
 * 求「把居中于视口的内容框 base」映射到页面矩形 rect 的变换。
 * 由于 base 与 rect 宽高比一致，缩放是等比的，视觉上完全连续。
 */
export function mapBoxToRect(base, rect, view) {
  const scale = base.w > 0 ? rect.width / base.w : 1;
  const tx = rect.left + rect.width / 2 - (view.left + view.w / 2);
  const ty = rect.top + rect.height / 2 - (view.top + view.h / 2);
  return { scale, tx, ty };
}

export function isMostlyVertical(dx, dy) {
  return Math.abs(dy) >= Math.abs(dx);
}
