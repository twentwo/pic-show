/**
 * 预览窗口的入口。
 *
 * 这个模块跑在**独立的 `viewer` 窗口**里，与图片墙（`ui/js/main.js`，跑在
 * `main` 窗口）是两个 webview，中间没有共享的 JS 上下文。所以它拿图片集合
 * 只能靠后端中转（`viewer_boot` / `picshow://viewer-goto`），也**看不到**网
 * 格里任何一个 DOM 节点 —— 关闭动画的终点因此不能再去问网格，只能用开场时
 * 记下的那一格（见 `viewer.js` 里 `originRect` 的那段注释）。
 *
 * 分家换来的是一条硬保证：图片墙那条窗口**一次全屏都没进过**。它既没有
 * 「退出预览要还原到什么」，也没有任何一行代码会去写它的几何 —— 它就待在
 * 用户最后摆放的位置上。
 */

import * as api from './api.js';
import { waitFor, withTimeout } from './async.js';
import { Viewer } from './viewer.js';
import { initTheme, mountThemeToggles } from './theme.js';
import { viewportFillsScreen, viewportMatches, viewportRectFrom } from './launch.js';
import { installWheelPhaseProbe, setWheelPhaseSink } from './wheel-phase.js';

const el = (id) => document.getElementById(id);

// 让样式表知道自己在哪个平台上 —— macOS 的交通灯画在窗口左上角，页面顶部靠左
// 的内容得给它让出位置。见 `app.css` 里的 `--traffic-light-inset`。
if (api.platform) {
  document.documentElement.dataset.platform = api.platform;
}

/* ------------------------------------------------------------------ *
 * 轻提示
 * ------------------------------------------------------------------ */

let toastTimer = 0;
let toastHideTimer = 0;

function toast(message) {
  const node = el('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  // 强制一次样式计算，保证下面的 class 切换能触发过渡
  void node.offsetWidth;
  node.classList.add('is-visible');

  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('is-visible');
    toastHideTimer = setTimeout(() => {
      node.hidden = true;
    }, 240);
  }, 2400);
}

/* ------------------------------------------------------------------ *
 * 预览
 * ------------------------------------------------------------------ */

/**
 * 开场动画的起点（**物理像素、屏幕坐标系**）。
 *
 * 跨窗口传几何只有这一种不会错的表示法：两个窗口的视口原点各不相同（预览
 * 全屏落在哪块屏取决于主窗口在哪块屏），只有都折到同一个桌面坐标系里才对得
 * 上。用物理像素是为了绕开 `scale_factor` —— 那个查询是「发消息给事件循环
 * → 阻塞等回执」的 getter，在命令里问它会自锁。
 */
let originRect = null;
/** 这次会话是不是「从文件管理器打开」来的（关闭即退出应用） */
let immersiveSession = false;

const viewer = new Viewer({
  root: el('viewer'),
  onError: (message) => toast(message),
  onClosed: () => {
    // 作废还在路上的那次打开：用户在它落地之前按了 Esc
    sessionSeq += 1;
    // 「打开方式」进来的会话：这个预览是为这一张而开的，关掉（或取消打开）
    // 就该彻底退回去。那时不能走 `close_viewer` —— 它会把主窗口叫到前台，
    // 而主窗口在这条路径上从头到尾都不该露面。
    if (immersiveSession) {
      api.exitApp().catch(() => window.close());
      return;
    }
    api.closeViewer(Math.max(0, viewer.index)).catch(() => {});
  }
});

/**
 * 后端转交过来的「用户要关掉这个窗口」。
 *
 * 用户点窗口交通灯 / 按 `Cmd+W` 时，Tauri 的默认行为是立刻把窗口销毁 —— 那样
 * 就没机会播退场动画、回填「看到第几张」、或让沉浸式会话一并退出应用。所以
 * 后端在 `CloseRequested` 那一步拦下来，转到这里走**正常关闭**那条路；收摊后
 * `close_viewer` 会在后端真正 `destroy()` 这条窗口。Esc、双击、关闭按钮、交通灯
 * 四条路径因此完全一致。
 *
 * 后端拿不到「现在看的是第几张」（那是这个 webview 里的状态），所以这件事只
 * 能由前端来做 —— 这也是为什么用 `eval` 喊一嗓子，而不是后端直接藏窗口。
 */
window.__picshowRequestClose = () => {
  if (viewer.isOpen || viewer.closing) {
    viewer.close().catch(() => {});
  } else {
    // 画面还没起来（比如刚点开就按了 Cmd+W）：没有动画可播，直接让位
    viewer.abort();
  }
};

/**
 * 开场请求的世代号。
 *
 * 从「收到会话」到「预览真正打开」中间横着切全屏与等布局两串 await。这期间
 * 用户按 Esc 是要求**取消**这次打开 —— 那时画面一格都没画，`close()` 不认得
 * 它。所以用一个世代号把「还在等的那次」作废掉，否则它会在等待结束时自作
 * 主张地打开，用户按了 Esc 却看着预览自己弹出来。
 */
let sessionSeq = 0;

/**
 * 首图预热最多等多久。
 *
 * 开场不等图片（几何来自宽高元数据，第一帧就能动），但**空框长大再突然填上**
 * 是一次实打实的跳变。预览是独立 webview，图片缓存是空的，这张图必然要现取
 * —— 好在切全屏那段平台转场刚好够把它取回来。
 *
 * 这个上限是「不能为了不闪而让用户干等」：取不到就照常开场，退化成空框长大。
 */
const FIRST_IMAGE_MS = 400;

/**
 * 播一次「从那一格长出来」的开场。
 *
 * 顺序是钉死的，四步缺一不可：
 *   1. 先告诉后端切全屏 —— 拿到回执时窗口已经是整屏，那一刻才谈得上量布局；
 *      （同时**并行**预热首图，把那段躲不掉的转场时间用掉）
 *   2. 等**量到**视口真的长到终态再算几何（全屏的结果比 IPC 回执晚一到两帧）；
 *   3. 把来源矩形从屏幕坐标折成自己视口里的坐标；
 *   4. 最后才播动画。
 */
async function openSession(session) {
  const seq = ++sessionSeq;
  immersiveSession = Boolean(session.immersive);
  originRect = session.origin ?? null;
  viewer.setItems(session.items ?? []);

  // 切全屏是一段躲不掉的平台转场（macOS 上最明显），其间窗口可能已经亮了
  // 却还什么都没有。先挂上幕布，那几帧就是一块实心背景而不是一片空白；
  // 等下 `open()` 会从这层幕布**接着**淡入，不会先把背景归零再淡一次。
  viewer.prime();

  // 后一步返回的窗口原点与上一步的量测必须在**切全屏之后**：全屏窗口落在哪
  // 块屏，此刻才确定。
  const framePromise = api.viewerReady().catch(() => null);
  // 与切全屏并行：转场那几百毫秒本来就是要等掉的，拿它把首图取回来最划算
  const imagePromise = viewer.preload(session.index ?? 0);
  const frame = await framePromise;
  // 等待期间用户按了 Esc：这次打开已经作废，幕布也得收掉
  if (seq !== sessionSeq) {
    viewer.cancelPrime();
    return;
  }

  // 后端给了窗口内容区的真实尺寸就用它判定 —— 比拿 `window.screen` 去猜准，
  // 于是通常一两帧就成立，不会白等出一段纯黑。
  const dpr = window.devicePixelRatio || 1;
  const settled = frame
    ? () =>
        viewportFillsScreen() ||
        viewportMatches(frame.width, frame.height, dpr)
    : viewportFillsScreen;
  await waitFor(settled, 8);
  if (seq !== sessionSeq) {
    viewer.cancelPrime();
    return;
  }
  // 幕布还盖着，这段等待用户看不见；等的是「画面别以空框起步」
  await withTimeout(imagePromise, FIRST_IMAGE_MS).catch(() => {});
  if (seq !== sessionSeq) {
    viewer.cancelPrime();
    return;
  }

  // 折成自己的视口坐标。拿不到来源就用「屏幕中心 0.8 倍」的兜底 —— 依旧是
  // 一次放大，只是少了「从哪儿来」的信息。
  const rect = originRect ? viewportRectFrom(originRect, frame, dpr) : null;

  viewer.openLaunch(session.index ?? 0, rect);

  // 焦点排在首图落地之后：早一步会被全屏切换那几帧冲掉，用户按下的第一个
  // 方向键落在「还没画出来的画面」上。
  await viewer.focusWhenReady().catch(() => {});
  await api.focusViewer().catch(() => {});
  api.logError(
    `[focus][预览] hasFocus=${document.hasFocus()} ` +
      `active=${document.activeElement?.id || document.activeElement?.tagName}`
  );
}

/** 预览自己的首屏就绪：先喊一声，再取会话。 */
async function boot() {
  initTheme();
  mountThemeToggles([el('btn-theme-viewer')]);

  if (!api.isTauri) {
    const warning = el('host-warning');
    if (warning) warning.hidden = false;
    return;
  }

  // 原生 wheel 相位：后端在 macOS 上默认安装本地监视器，一次手势只发
  // begin / end 两类语义（`PICSHOW_WHEEL_PHASE=0` 可关，用于 65ms 兜底 A/B）。
  // 先把接收端接到 viewer（真正结算仍在 gestures 那条唯一路径上），再挂监听，
  // 最后才报 listening —— 与 viewer-goto 同一个顺序约束。没有原生事件时
  // 65ms 静默兜底原样运行，预览不会因此失灵。
  setWheelPhaseSink((kind) => viewer.handleWheelPhase(kind));
  await installWheelPhaseProbe().catch(() => {});

  // 顺序要紧：先挂上监听，再告诉后端「我能收了」。反过来会在两条路之间开一
  // 个缝 —— 后端正好在中间发来的那次请求掉进黑洞（与 `take_launch_target`
  // 那条「事件 + 待取件并存」是同一个路子，这里由 `viewer_listening` 兜住）。
  await api.onViewerGoto((session) => {
    if (viewer.isOpen) {
      // 已经在看片了（用户又从 Finder 打开了另一张）：换内容，不重播开场
      viewer.setItems(session.items ?? []);
      viewer.jumpTo(session.index ?? 0);
    } else {
      openSession(session).catch((error) => api.logError(error?.stack || String(error)));
    }
  });

  await api.viewerListening().catch(() => {});

  const session = await api.viewerBoot().catch(() => null);
  if (session) {
    await openSession(session);
  }
  // 取不到就进入待命：这次是常规启动，等主窗口那边点图 / 从 Finder 打开时
  // 用 `picshow://viewer-goto` 唤醒。
}

// 兜住所有没被局部捕获的异常：webview 的 console 不进终端，
// 没有这里就只剩「界面没反应」这类无从下手的报告。
window.addEventListener('error', (event) => {
  api.logError(event.error?.stack || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  api.logError(event.reason?.stack || String(event.reason));
});

boot().catch((error) => api.logError(error?.stack || String(error)));
