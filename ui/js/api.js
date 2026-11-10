/**
 * 后端 API 门面：命令调用 + 图片地址构造 + 前端解码缓存。
 */

import {
  invoke,
  listen,
  isTauri,
  platform,
  showWindow,
  setWindowTitle
} from './tauri.js';

export { isTauri, platform, showWindow, setWindowTitle };

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
 * 「这次是不是被系统要求打开某张图」还剩多少毫秒可以等。
 *
 * 首屏就绪时若还拿不到打开请求，就照这个预算再等一小会儿 —— 窗口反正还
 * 藏着，等的代价是零。返回 0 就该立刻按常规启动点亮主界面。
 */
export const launchDecisionBudget = () =>
    invoke('launch_decision_budget').catch(() => 0);

/**
 * 把键盘焦点交给主窗口。
 *
 * 必须在「窗口已显示」之后调用：窗口是隐藏启动的，隐藏窗口上要焦点会被平台
 * 直接忽略。预览窗口也有自己那份（{@link focusViewer}）—— 两条窗口各自的焦点
 * 归各自的命令管，名字分开才不会指错人。
 */
export const focusWindow = () => invoke('focus_window').catch(() => {});

/**
 * 「打开方式」启动时那张缩略图的近似位置（`null` 表示拿不到）。
 *
 * 单独一条命令而不是塞进上面那个返回值：那份数据在后台线程里补写，
 * 首次 `take_launch_target` 时大概率还没到。取不到就走屏幕中心兜底动画。
 */
export const launchOrigin = () => invoke('launch_origin').catch(() => null);

/* ------------------------------------------------------------------ *
 * 预览窗口
 *
 * 预览是**独立的物理窗口**，与主窗口之间隔着两个 webview —— 没有共享的 JS
 * 上下文，图片集合与来源几何只能经后端中转。
 * ------------------------------------------------------------------ */

/**
 * 打开预览：把会话交给后端，由预览窗口自己全屏亮起来。
 *
 * 这里是**唯一**的入口：图片墙点击、图片墙回车、「打开方式」三条路都从这儿
 * 过，所以「这几个入口的预览是否一致」在代码上没有第二种答案。
 *
 * 主窗口因此一次都不用切全屏 —— 那才是「退出预览后回到原尺寸」的根本：
 * 不是「还原得准」，而是**从来没被改过**。
 *
 * @param {number} index 停在第几张
 * @param {?{x:number,y:number,width:number,height:number}} origin 开场动画起点
 *   （物理像素、屏幕坐标系）；拿不到传 null，预览会退化为屏幕中心放大
 * @param {boolean} immersive 「打开方式」来的会话（关闭即退出应用）
 * @returns {Promise<boolean>} 预览有没有被发起。
 */
export const openViewer = (index, origin, immersive) =>
  invoke('open_viewer', { index, origin, immersive }).catch(() => false);

/** 预览取走自己的会话；取不到说明这次还没人开预览，进入待命。 */
export const viewerBoot = () => invoke('viewer_boot').catch(() => null);

/** 预告「我可以收事件了」，让后端把装配那几帧里攒下的请求补送过来。 */
export const viewerListening = () =>
  invoke('viewer_listening').catch(() => null);

/**
 * 切进全屏并回报窗口原点（物理像素、屏幕坐标系）。
 *
 * 原点用来把来源矩形折成预览自己的视口坐标：全屏窗口落在哪块屏取决于主窗口
 * 在哪块屏，视口原点因此未必是 (0,0)。
 */
export const viewerReady = () => invoke('viewer_ready').catch(() => null);

/** 关闭预览：预览窗口被真正销毁，并把「用户在看第几张」送回主窗口。 */
export const closeViewer = (index) =>
  invoke('close_viewer', { index }).catch(() => null);

/** 把键盘焦点交给预览窗口（首图落地之后才有用）。 */
export const focusViewer = () => invoke('focus_viewer').catch(() => null);

/**
 * 主窗口左上角在屏幕坐标系里的位置（物理像素）。
 *
 * 主窗口要把「第 N 格缩略图」的位置交给预览当动画起点，而
 * `getBoundingClientRect()` 给的是视口坐标 —— 加上自己的原点才是两个窗口都
 * 读得懂的屏幕坐标。
 */
export const windowOrigin = () => invoke('window_origin').catch(() => null);

/** 已经开着的预览要换到另一张（用户在预览开着时又从 Finder 打开了一张）。 */
export const onViewerGoto = (handler) =>
  listen('picshow://viewer-goto', (event) => handler(event.payload));

/** 预览关掉了，主窗口据此把网格滚到用户最后看的那一张。 */
export const onViewerClosed = (handler) =>
  listen('picshow://viewer-closed', (event) => handler(event.payload));

/** 退出应用：沉浸式预览关闭后应当彻底退出，回到文件管理器 */
export const exitApp = () => invoke('exit_app');

/* ------------------------------------------------------------------ *
 * 主题
 * ------------------------------------------------------------------ */

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
 * 同 URL 的预取只做一次。
 *
 * 连续横滑沿方向预热多张时，相邻几次推进的预热窗口是**重叠**的（推到第 n 张时，
 * 第 n-1、n-2 张也在窗口里）。若每次都新建 Image 再 decode，同一张 4K 原图会在
 * 一段流里被解码十几遍，而且这些解码恰好落在跟手阶段 —— 预热自己反倒成了卡顿源。
 * 复用同一份已解码结果即可；容量同样用 FIFO 控制，失败时允许下次重试。
 */
const MAX_PREFETCHED = 48;
const prefetched = new Map();

/**
 * 已解码、可以**直接挂进 DOM** 的图片，按 URL 存一份。
 *
 * 预取只让字节与位图提前到位还不够：`viewer.fill()` 给槽里的 <img> 重新设
 * src 时，浏览器仍要走一次「请求 → 解码 → 绘制」。连续横滑时刚轮转进来的
 * 槽离视口只有一两屏，这一两帧就会露成空白，看起来正是「邻图没跟着移入」。
 * 这里把已经 `decode()` 过的 <img> 元素本身留着，调用方 `takeDecoded()` 取走
 * 后直接替换进槽 —— 同一帧就有像素，没有网络、没有解码、没有空白帧。
 *
 * 取走即从缓存移除（一个 <img> 只能挂在一个地方）；容量 FIFO 控制，避免
 * 无限占内存。失败不进池，换一段流自然重试。
 */
const MAX_DECODED = 24;
const decoded = new Map();

/** 等一张新节点解码完成的最长时间；超时交回 null，调用方继续保留旧像素 */
const DECODE_WAIT_MS = 1200;

/**
 * 取走一张已解码的图片节点；没有（或已被取走）返回 null。
 * @param {string} src
 * @returns {HTMLImageElement|null}
 */
export function takeDecoded(src) {
    const img = decoded.get(src);
    if (!img || img.parentNode) return null;
    decoded.delete(src);
    const at = kept.indexOf(img);
    if (at >= 0) kept.splice(at, 1);
    return img;
}

/**
 * 给槽位换源用：拿一张**已经解码好、还没挂进 DOM** 的 <img>。
 *
 * `preload()` 是「顺手预热」，兑现时机不受调用方控制；而 `fill()` 是同步发生的，
 * 池里那一刻不一定有货 —— 尤其是**反向滑回**一张早就取过的图：那个节点已经被
 * 上一个槽取走，`prefetched` 又按 URL 缓存了 promise，不会再造一个进池。这时
 * 若退回给槽里的 <img> 直接设 src，会先把旧像素抹掉、再等一次请求和解码，
 * 跟手的第一帧就露出背景。
 *
 * 慢路径因此新建一个独立节点，等它自己 decode 完再交给调用方：挂进 DOM 之前
 * 像素就已经在位，替换是原子的，槽里一帧都不会空。URL 通常已被预热进内存
 * 缓存，这一步只是复用位图，不再来一次网络往返。失败 / 超时兑现 null，
 * 调用方保留旧像素，不换成一张空图。
 *
 * @param {string} src
 * @returns {Promise<HTMLImageElement|null>}
 */
export function decodedImage(src) {
    if (!src) return Promise.resolve(null);
    const ready = takeDecoded(src);
    if (ready) return Promise.resolve(ready);

    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return new Promise((resolve) => {
        let timer = 0;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(img.naturalWidth > 0 ? img : null);
        };
        timer = setTimeout(finish, DECODE_WAIT_MS);
        if (typeof img.decode === 'function') {
            img.decode().then(finish, finish);
        } else if (img.complete) {
            finish();
        } else {
            img.onload = finish;
            img.onerror = finish;
        }
    });
}

/**
 * 预加载一张图片（不阻塞、不抛错）。
 * @param {string} src
 * @param {'high'|'low'|'auto'} priority
 * @returns {Promise<HTMLImageElement|null>}
 */
export function preload(src, priority = 'low') {
    if (!src) return Promise.resolve(null);

    const cached = prefetched.get(src);
    if (cached) return cached;

    const img = new Image();
    img.decoding = 'async';
    try {
        img.fetchPriority = priority;
    } catch {
        /* 老版本 webview 忽略 */
    }

    const promise = new Promise((resolve) => {
        img.onload = () => {
            // 光「下载完」还不够：真正的位图解码发生在第一次绘制的那一刻，
            // 一张 4K 原图能占住主线程十几毫秒 —— 正好卡在切图动画的第一帧，
            // 看起来就是「切过去的瞬间顿一下」。这里显式 decode 一次把位图
            // 提前准备好（decode 失败不影响流程，回退到原来的懒解码即可）。
            const done = () => {
                decoded.set(src, img);
                while (decoded.size > MAX_DECODED) {
                    decoded.delete(decoded.keys().next().value);
                }
                resolve(img);
            };
            if (typeof img.decode === 'function') img.decode().then(done, done);
            else done();
        };
        img.onerror = () => {
            // 取失败别把「失败」缓存住：换一段流、路径恢复之后要能重试。
            // 只删自己那一条，别误删 FIFO 淘汰后同 URL 的新一次预取。
            if (prefetched.get(src) === promise) prefetched.delete(src);
            resolve(null);
        };
    });

    img.src = src;

    kept.push(img);
    while (kept.length > MAX_KEPT) kept.shift();

    prefetched.set(src, promise);
    while (prefetched.size > MAX_PREFETCHED) {
        prefetched.delete(prefetched.keys().next().value);
    }

    return promise;
}
