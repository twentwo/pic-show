/**
 * 应用入口：装配网格与全屏查看器，绑定工具栏、快捷键与拖放提示。
 */

import * as api from './api.js';
import { Grid } from './grid.js';
import { Viewer } from './viewer.js';
import { initTheme, mountThemeToggles } from './theme.js';
import { launchOriginRect, launchWindowRect } from './launch.js';

const el = (id) => document.getElementById(id);

const dom = {
  grid: el('grid'),
  spacer: el('grid-spacer'),
  empty: el('empty'),
  status: el('status-text'),
  cache: el('cache-text'),
  toast: el('toast'),
  viewer: el('viewer')
};

/* ------------------------------------------------------------------ *
 * 轻提示
 * ------------------------------------------------------------------ */

let toastTimer = 0;
let toastHideTimer = 0;

function toast(message) {
  const node = dom.toast;
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
 * 组件
 * ------------------------------------------------------------------ */

const grid = new Grid({
  root: dom.grid,
  spacer: dom.spacer,
  onActivate: (index, cell) => viewer.open(index, cell)
});

const viewer = new Viewer({
  root: dom.viewer,
  grid,
  onError: (message) => toast(message),
  // 沉浸式预览（从文件管理器唤起）关闭后直接退出，回到文件管理器
  onExit: () => {
    api.exitApp().catch(() => window.close());
  }
});

/* ------------------------------------------------------------------ *
 * 数据装载
 * ------------------------------------------------------------------ */

/** 显示后端缓存占用；失败了就静默，不打扰看片 */
async function refreshCacheStats({ delay = 900 } = {}) {
  if (!api.isTauri || !dom.cache) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
  try {
    const stats = await api.cacheStats();
    const mb = (stats?.bytes ?? 0) / (1024 * 1024);
    dom.cache.textContent = `缓存 ${stats?.entries ?? 0} 项 / ${mb.toFixed(1)} MB`;
  } catch {
    dom.cache.textContent = '';
  }
}

function load(payload) {
  const items = payload?.items ?? [];
  grid.setItems(items);
  viewer.setItems(items);
  refreshCacheStats();

  const source = payload?.source ?? '';
  dom.empty.classList.toggle('is-visible', items.length === 0);
  dom.grid.style.visibility = items.length ? 'visible' : 'hidden';

  if (items.length) {
    dom.status.textContent = `${items.length} 张图片 · ${source}`;
    document.title = `${source} — PicShow`;
  } else {
    dom.status.textContent = '没有找到支持的图片';
    document.title = 'PicShow';
  }
}

api.onItems(load).catch((error) => toast(String(error)));

/* ------------------------------------------------------------------ *
 * 从文件管理器打开（右键 → 打开方式 → PicShow）
 *
 * 这条路径的语义与「先开 PicShow 再选图」完全不同：
 *   * 不显示浏览器界面（顶栏 / 网格 / 空状态全部让位），直接进全屏预览；
 *   * 关闭即退出应用 —— 这个窗口本来就是为看这一张而存在的；
 *   * 画廊集合是目标图片**所在目录**里的全部图片，按文件名排序。
 * ------------------------------------------------------------------ */

/** 这次启动的打开请求是否已经被某条通道接管（两条通道只认领一次） */
let launchHandled = false;
/** 窗口是否已经被点亮 —— 冷启动的预览分支要靠它决定走哪条路 */
let windowShown = false;

/**
 * 认领一次「系统要求打开图片」的请求。
 *
 * 同一个请求会走**两条**通道同时到达前端：事件（应用已在跑时立刻生效）与
 * 待取件（冷启动时事件早于监听注册，只能主动取）。两条都到的时候必须只处理
 * 一次 —— 否则就是「打开 → 关掉 → 再打开」的一次实打实的闪烁。
 */
function claimLaunch(payload) {
  if (launchHandled) return null;
  if (!payload?.items?.length) return null;
  launchHandled = true;
  return payload;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 取一次「待取件」；取不到就照后端给的预算再等一小会儿。
 *
 * 为什么要等：Windows 的关联打开、Linux 的 `%F` 把路径直接放进 argv，进程
 * 第一行就能判定这次是预览启动；macOS 不行 —— LaunchServices 不把文件放进
 * argv，而是等事件循环转起来之后用 Apple Event 送来，而那可能比首屏还慢
 * 半拍。这时候要是直接点亮主界面，用户看到的就是「主界面一闪而过，然后才
 * 变成全屏预览」。
 *
 * 预算是**从进程启动时刻**起算的绝对值，不是「从现在起再等 N 毫秒」：首屏
 * 加载慢的机器来问时预算早已经耗尽，常规启动一点都不会被拖慢。
 */
async function takeLaunchOrWait() {
  const taken = claimLaunch(await api.takeLaunchTarget().catch(() => null));
  if (taken) return taken;

  let left = await api.launchDecisionBudget().catch(() => 0);
  while (left > 0 && !launchHandled) {
    await sleep(Math.min(left, 20));
    const again = claimLaunch(await api.takeLaunchTarget().catch(() => null));
    if (again) return again;
    if (launchHandled) break;
    left = await api.launchDecisionBudget().catch(() => 0);
  }
  return null;
}

/**
 * 焦点交接：首图落地 → DOM 焦点交给预览 → 再向后端要一次窗口焦点。
 *
 * 三个条件缺一不可（理由见后端 `focus_window` 的注释）：窗口还没点亮时要
 * 焦点会被平台直接忽略、maximize 会把刚抢到的焦点让出去、图片没到时按下去
 * 的方向键落在空画面上。所以只能排在这儿 —— 窗口已显示、动画已开始、
 * 首图正在落地。
 */
async function handOverFocus() {
  await viewer.focusWhenReady().catch(() => {});
  await api.focusWindow().catch(() => {});
  // 「焦点到底落没落上」是典型的静默故障：界面上看不出焦点在哪儿。问一次并
  // 打到终端（logError 只在 PICSHOW_DEBUG=1 时输出），以后排这一类问题不用
  // 再靠猜。
  api.logError(
    `[focus] hasFocus=${document.hasFocus()} ` +
      `active=${document.activeElement?.id || document.activeElement?.tagName}`
  );
}

/**
 * 播放「从那一格长出来」的开场动画。
 *
 * 来源矩形来自后端记录的启动瞬间光标位置；拿不到就退化为屏幕中心 0.8 倍。
 * 两个入口共用（冷启动的 boot、应用已在跑时的 Opened 事件），避免两处走着
 * 走着又不一样。
 */
async function openLaunchView(payload) {
  const origin = await api.launchOrigin().catch(() => null);
  viewer.openLaunch(payload.index ?? 0, launchOriginRect(origin));
  await handOverFocus();
}

async function enterImmersive(payload) {
  const items = payload?.items ?? [];
  if (!items.length) return;

  document.body.classList.add('is-immersive');

  // 冷启动时窗口**还藏着**：必须走启动分支（它会趁窗口藏着把形态与尺寸定好
  // 再点亮）。直接在这儿开预览，动画就播给一个隐身窗口看了。
  if (!windowShown) {
    await bootLaunch(payload);
    return;
  }

  // 应用已经在跑、用户又从 Finder 打开了另一张：先关掉旧的再开新的。
  // 关之前必须临时摘掉「关闭即退出」，否则会在中途把应用整个退掉。
  if (viewer.isOpen) {
    viewer.setExitOnClose(false);
    await viewer.close();
  }

  // 去掉系统绘制的原生标题栏（颜色/模糊跟预览面对不上，也不受空闲计时
  // 控制）。页面里那条 viewer-bar 接管标题栏的角色：背景同源、显隐同步。
  await api.setImmersiveChrome(true).catch(() => {});
  // 等窗口形态变化后的尺寸落定，别按旧尺寸适配完又弹一下
  await nextFrames(2);

  grid.setItems(items);
  viewer.setItems(items);
  // 关闭 = 退出，回到文件管理器
  viewer.setExitOnClose(true);
  await openLaunchView(payload);

  // 窗口标题由后端在装载时同步（set_title 走插件权限，前端调用容易静默失败）
  refreshCacheStats({ delay: 300 });
}

api.onLaunch((payload) => {
  const taken = claimLaunch(payload);
  if (taken) enterImmersive(taken);
}).catch((error) => toast(String(error)));

/* ------------------------------------------------------------------ *
 * 工具栏 / 快捷键
 * ------------------------------------------------------------------ */

function pick(kind) {
  api.pickImages(kind).catch((error) => toast(String(error)));
}

el('btn-open-files').addEventListener('click', () => pick('files'));
el('btn-open-folder').addEventListener('click', () => pick('folder'));
el('btn-empty-files').addEventListener('click', () => pick('files'));
el('btn-empty-folder').addEventListener('click', () => pick('folder'));

// 主题开关要挂两处：顶栏（浏览界面）与预览标题栏（沉浸式下只有后者够得着）
mountThemeToggles([el('btn-theme'), el('btn-theme-viewer')]);

window.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) return;
  const key = event.key.toLowerCase();
  if (key === 'o') {
    event.preventDefault();
    pick(event.shiftKey ? 'folder' : 'files');
  }
});

// 网格获得焦点时回车 → 打开第一张
dom.grid.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && grid.count > 0) {
    event.preventDefault();
    const cell = grid.cellFor(0);
    viewer.open(0, cell);
  }
});

/* ------------------------------------------------------------------ *
 * 拖放提示
 *
 * 真正的「拿到路径并打开」在 Rust 侧完成（监听 `tauri://drag-drop`），
 * 这里只负责把浏览器默认的「直接打开文件」行为拦掉，并给出视觉反馈。
 * ------------------------------------------------------------------ */

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  document.body.classList.add('is-dragging');
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
});

window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('is-dragging');
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/**
 * 区分两种宿主：
 *   * Tauri webview —— 正常模式；
 *   * 普通浏览器打开 localhost:1420 —— 那是 Tauri **内部**加载前端用的地址，
 *     没有 `window.__TAURI_INTERNALS__` 注入，命令全部不可用。
 * 后者直接禁用入口并说明原因，避免用户点到一条语义不明的 IPC 报错。
 */
function applyHostMode() {
  if (!api.isTauri) {
    for (const id of [
      'btn-open-files',
      'btn-open-folder',
      'btn-empty-files',
      'btn-empty-folder'
    ]) {
      const btn = el(id);
      if (btn) btn.disabled = true;
    }
    const warning = el('host-warning');
    if (warning) warning.hidden = false;
    dom.status.textContent = '未在 Tauri 中运行 —— 请用 npm run dev 打开桌面窗口';
    console.warn(
      '[PicShow] 未检测到 Tauri 注入。localhost:1420 仅供 Tauri 内部加载前端，' +
        '请勿在浏览器中直接访问。'
    );
    return;
  }
  dom.grid.style.visibility = 'hidden';
}

applyHostMode();

/**
 * 启动收尾。两条互不相干的路：
 *
 *   * 从文件管理器打开 —— 走 `bootLaunch()`：不建立主界面，窗口直接以沉浸式
 *     全屏亮起并播放放大动画；
 *   * 常规启动 —— 点亮主界面（网格 / 空状态），等用户的下一步操作。
 *
 * 只在**该走的那一分支**上显示窗口，是「一闪而过」的唯一解药：主界面一旦
 * 被画出来，再隐藏就成了肉眼可见的闪。后端的 `window_ready` 里还有一道
 * 闸门（被要求打开图片且请求尚未被取走时拒绝点亮），两边一起才堵得住
 * macOS 那种「事件比首屏慢半拍」的竞态。
 */
async function boot() {
  // 真正的首帧主题是 index.html 头部那段同步脚本落的（比 CSS 还早，所以不会
  // 闪）；这里补齐后半段：同步原生窗口、摘掉临时行内底色、刷新按钮文案。
  initTheme();

  let pending = null;
  if (api.isTauri && !launchHandled) {
    pending = await takeLaunchOrWait().catch(() => null);
  }

  // 顺序要紧：先认自己手里这一份，再看事件通道有没有抢先。
  // 反过来写会永远走进「已被接管」—— `claimLaunch()` 认领成功后就会把
  // `launchHandled` 置上，于是「自己取到的那份」也被当成别人处理过的了。
  if (pending?.items?.length) {
    await bootLaunch(pending).catch((error) =>
      api.logError(error?.stack || String(error))
    );
    return;
  }
  // 事件通道已经在跑了（enterImmersive 自己会点亮窗口），这里再插手就重复了
  if (launchHandled) return;

  await api.showWindow();
  windowShown = true;
  // 焦点给网格，回车就能打开第一张。沉浸式那条分支里网格是 display:none，
  // 抢这一步只会把焦点从预览视图上挪走。
  if (!document.body.classList.contains('is-immersive')) dom.grid.focus();
}

/**
 * 「右键 → 打开方式」的专属启动路径。
 *
 * 要解决的正是「窗口一闪而过」：以前的顺序是 showWindow → 等两帧 → 再切到
 * 预览，中间那几帧主界面是实打实画出来的。所以这里把顺序反过来 ——
 *
 *   1. 先加 `is-immersive`（纯 CSS，不等任何 IPC）：主界面从此不可能被绘制；
 *   2. 让后端趁窗口还藏着把形态与尺寸定好，**然后才点亮**（`prepareLaunchWindow`）；
 *   3. 等布局确认已经长到目标大小 —— 这一步等的是**布局**，不是图片：几何来自
 *      items 的宽高元数据，所以第一帧就有正确的起止位置；
 *   4. 最后播放放大动画：从启动瞬间光标所在那一格（拿不到则从屏幕中心 0.8 倍）
 *      FLIP 到全屏，并叠加透明度渐变。
 */
async function bootLaunch(payload) {
  document.body.classList.add('is-immersive');

  grid.setItems(payload.items);
  viewer.setItems(payload.items);
  viewer.setExitOnClose(true);

  // 把后端那份「待取件」取走（不看结果）：一是保证同一次请求不会被两条通道
  // 各处理一遍；二是让后端知道这次启动已经由预览分支接管 —— `window_ready`
  // 据此拒绝再点亮主界面。
  await api.takeLaunchTarget().catch(() => {});

  // 来源坐标这一问放在 promises 里**并行**跑出去，别把首帧拖住
  const originPromise = api.launchOrigin();

  await api
    .prepareLaunchWindow(launchWindowRect())
    .catch(() => api.showWindow());
  windowShown = true;

  // 等窗口真的长到目标尺寸再开画：maximize 的结果常常比 IPC 回执晚一到两帧，
  // 而 FLIP 的起点是按**当前**可视区算的 —— 若按旧尺寸先算，动画就会从错误的
  // 方向长出来。
  const target = launchWindowRect();
  await waitFor(
    () =>
      Math.abs(document.documentElement.clientWidth - target.width) <= 2 &&
      Math.abs(document.documentElement.clientHeight - target.height) <= 2,
    8
  );

  const origin = await originPromise.catch(() => null);
  viewer.openLaunch(payload.index ?? 0, launchOriginRect(origin));
  refreshCacheStats({ delay: 300 });
  // 等到首图落地再交焦点：早一步会被 maximize / 布局落定那几帧冲掉
  await handOverFocus();
}

/**
 * 等条件成立，最多等 `maxFrames` 帧。
 *
 * 为什么要有帧数上限：万一某个平台到了设置好的帧数还没回调那一帧，
 * 宁可按旧尺寸先跑起来，也不能让用户盯着黑屏。
 */
const waitFor = (predicate, maxFrames = 8) =>
  new Promise((resolve) => {
    const step = (left) => {
      if (predicate() || left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(maxFrames);
  });

const nextFrames = (n) =>
  new Promise((resolve) => {
    const step = (left) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });

// 兜住所有没被局部捕获的异常：webview 的 console 不进终端，
// 没有这里就只剩「界面没反应」这类无从下手的报告。
window.addEventListener('error', (event) => {
  api.logError(event.error?.stack || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  api.logError(event.reason?.stack || String(event.reason));
});

boot().catch((error) => {
  api.logError(error?.stack || String(error));
  api.showWindow();
});
