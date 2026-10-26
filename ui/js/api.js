/**
 * 后端 API 门面：命令调用 + 图片地址构造 + 前端解码缓存。
 */

import { invoke, listen, isTauri, showWindow, setWindowTitle } from './tauri.js';

export { isTauri, showWindow, setWindowTitle };

/* ------------------------------------------------------------------ *
 * 图片地址（由 src-tauri/src/protocol.rs 提供）
 * ------------------------------------------------------------------ */

/** 网格目标行高（px） */
export const GRID_ROW_H = 210;

/**
 * 缩略图请求尺寸。
 *
 * 关键点：网格和全屏查看器必须用**同一个**尺寸，这样从网格点开大图时
 * 低分辨率底图能直接命中 webview 缓存，做到「秒开」而不是重新解码。
 */
export const THUMB_SIZE = (() => {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(1024, Math.round(GRID_ROW_H * 2 * dpr));
})();

/** 缩略图：最长边 = size 像素 */
export const thumbUrl = (id, size = THUMB_SIZE) =>
    `img://localhost/thumb/${id}?s=${size}`;

/** 模糊占位图：~24px，几百字节 */
export const placeholderUrl = (id) => `img://localhost/placeholder/${id}`;

/** 原图；传 max 则超过时等比缩小后重编码 */
export const fullUrl = (id, max = 0) =>
    `img://localhost/full/${id}${max ? `?max=${max}` : ''}`;

/** 超过这个像素量就改用降采样原图，避免 webview 解码爆内存 */
const HUGE_PIXELS = 40_000_000;
const HUGE_EDGE = 4096;

export function maxEdgeFor(item) {
    return item?.width && item?.height && item.width * item.height > HUGE_PIXELS
        ? HUGE_EDGE
        : 0;
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

/** 弹出系统选择框；结果通过 onItems 事件异步返回 */
export const pickImages = (kind = 'files') => invoke('pick_images', { kind });

export const openFolder = (path) => invoke('open_folder', { path });

export const openPaths = (paths) => invoke('open_paths', { paths });

export const revealImage = (id) => invoke('reveal_image', { id });

export const cacheStats = () => invoke('cache_stats');

/** 监听图片集合更新（弹窗选择 / 拖放都会触发） */
export const onItems = (handler) =>
    listen('picshow://items', (event) => handler(event.payload));

/**
 * 「从文件管理器打开」的两种通道，缺一不可：
 *   * `onLaunch`  —— 应用已运行时，系统再传来文件（事件立刻到达）；
 *   * `takeLaunchTarget` —— 冷启动时事件早于前端注册被发出，只能主动取。
 */
export const onLaunch = (handler) =>
    listen('picshow://open-file', (event) => handler(event.payload));

export const takeLaunchTarget = () => invoke('take_launch_target');

/**
 * 「打开方式」启动时那张缩略图的近似位置（`null` 表示拿不到）。
 *
 * 单独一条命令而不是塞进上面那个返回值：那份数据在后台线程里补写，
 * 首次 `take_launch_target` 时大概率还没到。取不到就走屏幕中心兜底动画。
 */
export const launchOrigin = () => invoke('launch_origin').catch(() => null);

/**
 * 「打开方式」专用：一步到位把窗口变成沉浸式全屏并点亮。
 *
 * 常规入口是「先显示主界面 → 前端再决定要不要进预览」，中间那几帧用户看得见。
 * 这条路径在窗口还藏着的时候就把形态与尺寸定好，亮起来已经是全屏。
 */
export const prepareLaunchWindow = (rect) =>
    invoke('prepare_launch_window', { rect });

/** 退出应用：沉浸式预览关闭后应当彻底退出，回到文件管理器 */
export const exitApp = () => invoke('exit_app');

/* ------------------------------------------------------------------ *
 * 窗口形态与主题
 * ------------------------------------------------------------------ */

/**
 * 沉浸式窗口形态：关掉系统绘制的原生标题栏。
 *
 * 原生标题栏的颜色 / 毛玻璃由系统画，跟预览背景永远对不齐，也不受前端
 * 空闲计时的控制（没法跟着按钮和胶片条一起隐藏）。关掉它之后，页面里
 * 那条 `.viewer-bar` 就是唯一标题栏 —— 背景同源、显隐同步。
 */
export const setImmersiveChrome = (enabled) =>
    invoke('set_immersive_chrome', { enabled });

/**
 * 把用户选的主题同步给原生窗口（文件对话框这类系统UI不听 CSS 的话）。
 *
 * 单向：只是**通知**后端，后端不会反过来决定前端用什么主题 —— 默认深色
 * 与用户的持久化选择都在前端落地。
 */
export const setWindowTheme = (theme) =>
    invoke('set_window_theme', { theme }).catch(() => {});

/**
 * 把异常送到后端 stderr（仅 `PICSHOW_DEBUG=1` 时会打印）。
 *
 * webview 里的异常全是「静默」的：界面只是没反应，看不出哪一行炸了。
 * 这里统一兜住 `error` 与 `unhandledrejection`，别再靠猜。
 */
export const logError = (message) =>
    invoke('log_error', { message: String(message) }).catch(() => {});

/* ------------------------------------------------------------------ *
 * 前端解码缓存
 *
 * 后端已有「内存 LRU + 磁盘」两级缓存，这里再补一层：只要把 Image 对象
 * 持有住不放，浏览器就不会回收它的解码结果，于是回看上一张/下一张是零延迟。
 * 容量用简单的 FIFO 控制。
 * ------------------------------------------------------------------ */

const MAX_KEPT = 12;
const kept = [];

/**
 * 预加载一张图片（不阻塞、不抛错）。
 * @param {string} src
 * @param {'high'|'low'|'auto'} priority
 * @returns {Promise<HTMLImageElement|null>}
 */
export function preload(src, priority = 'low') {
    if (!src) return Promise.resolve(null);

    const img = new Image();
    img.decoding = 'async';
    try {
        img.fetchPriority = priority;
    } catch {
        /* 老版本 webview 忽略 */
    }

    const promise = new Promise((resolve) => {
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
    });

    img.src = src;

    kept.push(img);
    while (kept.length > MAX_KEPT) kept.shift();

    return promise;
}
