/**
 * 「打开方式」启动动画的起点，以及跨窗口的几何换算。
 *
 * 桌面看图器的开场讲究「从哪儿来回哪儿去」：Quick Look 从 Finder 里那一格
 * 长出来，用户就能看懂这张图是从哪来的。但**没有一个桌面平台会把「你刚点了
 * 哪一格」告诉被启动的进程** —— LaunchServices / ShellExecute / xdg-open 都
 * 不给这个信息。
 *
 * 于是取一个足够贴近的近似：
 *   1. 后端在收到文件的那一刻（光标还停在那张图上）记下光标位置；
 *   2. 这里把它换算成**屏幕坐标系**里的一个小矩形，当作那张缩略图；
 *   3. 取不到（命令行启动、拖得太久才问）→ 返回 null，由调用方退化为
 *      「屏幕中心 0.8 倍」的兜底动画。
 *
 * 之所以独立成模块：这段逻辑错了的表现是「动画起点偏出屏幕」，光看代码很难
 * 发现，独立出来才能被探针直接断言。
 */

/** 没有来源信息时，从屏幕中心以这个倍率放大（略小于 1，读得出是「长大」） */
export const CENTER_ZOOM_SCALE = 0.8;

/**
 * 后端给的光标点 → 屏幕坐标系里的矩形（**物理像素**）。
 *
 * 后端记的是物理像素（`cursor_position()` 给的就是这个单位），来源那一格的
 * 边长却是 CSS 像素（`LaunchOrigin::size` 与文件管理器里图标的常见尺寸同量
 * 级）。这里统一折算成物理像素，因为它要跟下面那个窗口原点做加减 —— 两端
 * 同单位，才能直接相减。
 *
 * @param {?{x:number, y:number, size:number}} origin
 * @param {number} dpr devicePixelRatio
 * @returns {?{x:number, y:number, width:number, height:number}}
 */
export function launchOriginScreenRect(origin, dpr = 1) {
  if (!origin) return null;

  const x = Number(origin.x);
  const y = Number(origin.y);
  const cssSize = Number(origin.size);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(cssSize) || cssSize <= 0) return null;

  const scale = dpr > 0 ? dpr : 1;
  const size = cssSize * scale;
  return { x: x - size / 2, y: y - size / 2, width: size, height: size };
}

/**
 * 屏幕坐标系里的矩形 → 本窗口视口坐标系里的矩形（**CSS 像素**）。
 *
 * 这是**跨窗口**传几何的收口：预览是独立的物理窗口，它全屏落在哪块屏取决于
 * 主窗口在哪块屏，视口原点因此未必是 (0,0)。把来源矩形折成自己的视口坐标，
 * 才拿得到正确的 FLIP 起点。
 *
 * @param {?{x:number, y:number, width:number, height:number}} rect 物理像素
 * @param {?{x:number, y:number}} point 本窗口原点（物理像素），取不到时按 (0,0)
 * @param {number} dpr 本窗口的 devicePixelRatio
 * @param {object} [env] 视口尺寸，便于探针注入假值
 * @returns {?{left:number, top:number, width:number, height:number}}
 */
export function viewportRectFrom(rect, point, dpr, env = viewportSize()) {
  if (!rect) return null;

  const scale = dpr > 0 ? dpr : 1;
  const originX = Number(point?.x);
  const originY = Number(point?.y);
  const left = (rect.x - (Number.isFinite(originX) ? originX : 0)) / scale;
  const top = (rect.y - (Number.isFinite(originY) ? originY : 0)) / scale;
  const width = rect.width / scale;
  const height = rect.height / scale;

  if (!(width > 0) || !(height > 0)) return null;

  const out = { left, top, width, height };
  return isPlausible(out, env) ? out : null;
}

/**
 * 越界判定。
 *
 * 坐标稍有偏差只会让起点偏几十像素，动画照样成立；但如果整套坐标系对不上
 * （多显示器时那张图在另一块屏上），起点会飞出屏幕，动画变成「从画外被吸
 * 回来」而不是「从那一格长出来」—— 那种时候宁可退回中心。
 * 所以阈值放得宽：只要还沾着视口的边就算可用。
 */
function isPlausible(rect, env) {
  const margin = Math.max(rect.width, rect.height);
  return (
    rect.left + rect.width > -margin &&
    rect.top + rect.height > -margin &&
    rect.left < env.viewW + margin &&
    rect.top < env.viewH + margin
  );
}

/** 真实视口尺寸快照。抽出来是为了让探针能喂假值。 */
export function viewportSize() {
  return {
    viewW: window.innerWidth || document.documentElement.clientWidth || 0,
    viewH: window.innerHeight || document.documentElement.clientHeight || 0
  };
}

/**
 * 当前可视区是不是已经铺满整块屏。
 *
 * 全屏不是同步生效的：macOS 把窗口搬进独立 Space、Windows 重新排布任务栏，
 * 都要过一两帧才反馈到 `clientWidth/Height`。按旧尺寸算 FLIP 起点，动画就会
 * 从错误的方向长出来。与其猜要等几帧，不如直接量。
 *
 * 容差按屏高的 2% 取（至少 4px）：带缩放的显示器上 `screen.height` 与
 * `clientHeight` 常常差一两个像素，苛刻的等值判定会一直不成立。
 */
export function viewportFillsScreen() {
  const screen = window.screen ?? {};
  const targetW = Number(screen.width) || 0;
  const targetH = Number(screen.height) || 0;
  if (!targetW || !targetH) return false;
  return viewportMatches(targetW, targetH, 1);
}

/**
 * 当前可视区是不是已经长到后端说的那个尺寸。
 *
 * `viewer_ready` 会把窗口内容区的**真实**尺寸（物理像素）一并回报，所以这里
 * 不必再拿 `window.screen` 去猜 —— 猜的代价是：多显示器、带缩放的屏上那两个
 * 值常常对不齐，于是判定迟迟不成立，白等好几帧。而那几帧画面还没开始长，
 * 用户看到的就是一段纯黑。
 *
 * @param {number} width 物理像素
 * @param {number} height 物理像素
 * @param {number} dpr devicePixelRatio
 * @param {object} [env] 视口尺寸，便于探针注入假值
 */
export function viewportMatches(width, height, dpr, env = viewportSize()) {
  const scale = dpr > 0 ? dpr : 1;
  const targetW = Number(width);
  const targetH = Number(height);
  if (!(targetW > 0) || !(targetH > 0)) return false;

  const cssW = targetW / scale;
  const cssH = targetH / scale;
  const tolerance = Math.max(4, cssH * 0.02);
  return (
    Math.abs(env.viewW - cssW) <= tolerance &&
    Math.abs(env.viewH - cssH) <= tolerance
  );
}
