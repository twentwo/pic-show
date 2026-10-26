/**
 * 「打开方式」启动动画的起点。
 *
 * 桌面看图器的开场讲究「从哪儿来回哪儿去」：Quick Look 从 Finder 里那一格
 * 长出来，用户就能看懂这张图是从哪来的。但**没有一个桌面平台会把「你刚点了
 * 哪一格」告诉被启动的进程** —— LaunchServices / ShellExecute / xdg-open 都
 * 不给这个信息。
 *
 * 于是取一个足够贴近的近似：
 *   1. 后端在收到文件的那一刻（光标还停在那张图上）记下光标位置；
 *   2. 这里把它换算成 webview 坐标系里的一个小矩形，当作那张缩略图；
 *   3. 取不到（命令行启动、拖得太久才问、多屏幕时那张图在另一块屏上）→
 *      返回 null，由调用方退化为「屏幕中心 0.8 倍」的兜底动画。
 *
 * 之所以独立成模块：换算涉及 devicePixelRatio、窗口原点、越界判定三个维度，
 * 单独放才能被探针直接断言 —— 这段逻辑错了的表现是「动画起点偏出屏幕」，
 * 光看代码很难发现。
 */

/** 没有来源信息时，从屏幕中心以这个倍率放大（略小于 1，读得出是「长大」） */
export const CENTER_ZOOM_SCALE = 0.8;

/**
 * 把后端给的来源点换算成**视口坐标系**里的矩形。
 *
 * @param {?{x:number, y:number, size:number}} origin 物理像素、桌面坐标系
 * @param {object} env 宿主环境，便于探针注入假值（默认 `environment()`）
 * @returns {?{left:number, top:number, width:number, height:number}}
 */
export function launchOriginRect(origin, env = environment()) {
  if (!origin) return null;

  const size = Number(origin.size);
  const x = Number(origin.x);
  const y = Number(origin.y);
  if (!Number.isFinite(size) || size <= 0) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  // 后端给的是物理像素；DOM 矩形的单位是 CSS 像素。换算放在前端，
  // 因为只有它知道 devicePixelRatio —— 后端那个 scale_factor 查询是**阻塞
  // 等回执**的 getter，为这一除法去冒自锁的风险不值得。
  const dpr = env.dpr > 0 ? env.dpr : 1;
  const left = x / dpr - env.offsetX - size / 2;
  const top = y / dpr - env.offsetY - size / 2;

  const rect = { left, top, width: size, height: size };
  return isPlausible(rect, env) ? rect : null;
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

/**
 * 真实宿主环境快照。抽出来是为了让探针能喂假值。
 *
 * `offsetX/offsetY` 是**窗口可视区左上角在桌面坐标系里的位置**。取自
 * `screen.availLeft/availTop` 而不是 `window.screenX/screenY`：后者在无边框
 * 最大化窗口上给的是离谱的过期值（实测 1080 —— 整整一块屏的高度），而启动
 * 路径一定会把窗口最大化到可视区，于是「可视区左上角」就是窗口左上角，两者
 * 之间不存在偏差。
 */
export function environment() {
  const screen = window.screen ?? {};
  return {
    dpr: window.devicePixelRatio || 1,
    offsetX: Number(screen.availLeft) || 0,
    offsetY: Number(screen.availTop) || 0,
    viewW: window.innerWidth || document.documentElement.clientWidth || 0,
    viewH: window.innerHeight || document.documentElement.clientHeight || 0
  };
}

/**
 * 窗口要占的目标矩形（CSS 像素、桌面坐标系），交给后端在显示**之前**摆好。
 *
 * 用 `screen.availLeft/availTop` 而不是 0：多显示器时主屏不一定是左上角，
 * 而沉浸式预览应当在 webview 自己所在的那一屏铺开。
 */
export function launchWindowRect() {
  const screen = window.screen ?? {};
  return {
    x: Number(screen.availLeft) || 0,
    y: Number(screen.availTop) || 0,
    width: Number(screen.availWidth) || window.innerWidth,
    height: Number(screen.availHeight) || window.innerHeight
  };
}
