/**
 * 图片墙入口。
 *
 * 这个模块跑在 `main` 窗口上，只负责浏览器界面（网格 / 顶栏 / 空状态）。
 * **预览不在这里** —— 那是 `viewer` 窗口与 `ui/js/viewer-main.js` 的事。
 *
 * # 为什么要分家
 *
 * 以前预览与图片墙共用一个窗口，进预览 = 切这个窗口的形态（进全屏 / 摘掉
 * 标题栏 / 摆尺寸），退出 = 切回来。而**任何**一次对几何或样式的写入都会被
 * 窗口层记成「退出全屏时照着还原」的目标：
 *
 *   * 运行时摘过装饰 → tao 把无边框那份 styleMask 存进 `saved_style`，退出时
 *     无条件写回，我们补回标题栏那一笔必然被覆盖；
 *   * 进全屏前把窗口摆到整块屏 → macOS 当场判定它 `zoomed`，从此把「最大化」
 *     当成全屏前的样子，退出时一丝不差地还原到最大化。
 *
 * 分家之后这条窗口**一次全屏都没进过、一次几何都没被写过**。它既不需要
 * 「还原」，也没有任何代码能把它写脏 —— 它就待在用户最后摆放的位置上。
 *
 * 代价是图片集合与来源几何要在两个 webview 之间过一趟后端：这里是**发起**
 * 的那一侧（{@link openPreview}），预览那边是**接收**的一侧。
 */

import * as api from './api.js';
import { Grid } from './grid.js';
import { initTheme, mountThemeToggles } from './theme.js';
import { launchOriginScreenRect } from './launch.js';

const el = (id) => document.getElementById(id);

// 让样式表知道自己在哪个平台上 —— macOS 的交通灯画在窗口左上角，页面顶部靠左
// 的内容得给它让出位置。见 `app.css` 里的 `--traffic-light-inset`。
if (api.platform) {
  document.documentElement.dataset.platform = api.platform;
}

const dom = {
  grid: el('grid'),
  spacer: el('grid-spacer'),
  empty: el('empty'),
  status: el('status-text'),
  cache: el('cache-text'),
  toast: el('toast')
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
  onActivate: (index, cell) => openPreview(index, cell)
});

/* ------------------------------------------------------------------ *
 * 打开预览
 * ------------------------------------------------------------------ */

/**
 * 把某一格缩略图的位置折成**物理像素、屏幕坐标系**里的矩形。
 *
 * 这一步是跨窗口传几何的关键。DOM 给的 `getBoundingClientRect()` 是**本窗口
 * 视口坐标**，预览窗口读不懂 —— 它全屏落在哪块屏取决于我们这条窗口在哪块
 * 屏，视口原点未必是 (0,0)。折到共同的桌面坐标系里，那边减掉自己的原点就
 * 拿得到正确起点（见 `launch.js` 的 `viewportRectFrom`）。
 *
 * 用物理像素是为了绕开 `scale_factor`：那个查询是「发消息给事件循环 → 阻塞
 * 等回执」的 getter，在命令里问它会自锁。两端都用物理像素，加减自然抵消。
 *
 * @param {?Element} cell 那一格（拿不到时返回 null，预览退化为中心放大）
 */
async function originRectOf(cell) {
  const rect = cell?.getBoundingClientRect?.();
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;

  const origin = await api.windowOrigin();
  if (!origin) return null;

  const dpr = window.devicePixelRatio || 1;
  return {
    x: origin.x + rect.left * dpr,
    y: origin.y + rect.top * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr
  };
}

/**
 * 图片墙 → 预览。
 *
 * 与「打开方式」共用后端同一个入口（`open_viewer`），所以开场几何、透明度
 * 渐变、时长缓动，以及之后缩放 / 拖拽 / 左右切换 / 点击空白或 Esc 关闭 /
 * 键盘快捷键，在代码上都是同一份实现 —— 它们不是「各自差不多」，而是同一个
 * 目标窗口的两次唤起。
 *
 * 注意这里**不切窗口形态**：主窗口不进全屏、不摆尺寸、不摘装饰。退出预览
 * 后它回到原样，靠的不是「还原得准」，而是**从来没被改过**。
 *
 * @param {number} index
 * @param {?Element} cell 来源那一格
 */
async function openPreview(index, cell = null) {
  const origin = await originRectOf(cell).catch(() => null);
  const ok = await api.openViewer(index, origin, false);
  if (!ok) toast('打开预览失败');
}

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
  refreshCacheStats();
}

api.onItems(load).catch((error) => toast(String(error)));

/* ------------------------------------------------------------------ *
 * 预览关掉了：把网格滚到用户最后看的那一张
 *
 * 这是两个窗口之间唯一反向的状态流动。用户在预览里翻到第几张，退出后图片
 * 墙就停在第几张 —— 否则「看了二十张，退出来还在第一张」，那种割裂感非常
 * 明显。
 * ------------------------------------------------------------------ */

api
  .onViewerClosed((payload) => {
    const index = Number(payload?.index);
    if (!Number.isFinite(index) || index < 0) return;
    grid.ensureVisible(index);
    // 焦点交回网格，方向键继续在图片墙上走
    dom.grid.focus();
  })
  .catch((error) => toast(String(error)));

/* ------------------------------------------------------------------ *
 * 从文件管理器打开（右键 → 打开方式 → PicShow）
 *
 * 这条路径的语义与「先开 PicShow 再选图」完全不同：
 *   * 不显示浏览器界面 —— 直接唤起预览窗口，关闭即退出应用；
 *   * 画廊集合是目标图片**所在目录**里的全部图片，按文件名排序。
 *
 * 主窗口全程**保持隐藏**：它这次根本不该露面。后端 3 秒兜底也因此必须先问
 * 「预览起来了没有」才敢点亮（见 `lib.rs`）。
 * ------------------------------------------------------------------ */

/** 这次启动的打开请求是否已经被某条通道接管（两条通道只认领一次） */
let launchHandled = false;

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
 * 半拍。这时候要是直接点亮主界面，用户看到的就是「主界面一闪而过」。
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
 * 唤起预览窗口（「打开方式」专用）。
 *
 * 这次预览是为这一张而开的，所以 `immersive` 为真：预览那边关闭即退出应用。
 * 主窗口一个字都不碰 —— 不点亮、不摆尺寸、不进全屏。
 *
 * @param {object} payload
 */
async function bootLaunch(payload) {
  // 先把数据备好：万一预览那条路没走通，点亮主界面时也有内容可看
  load({ items: payload.items, source: payload.source });

  // 把后端那份「待取件」取走（不看结果）：一是保证同一次请求不会被两条通道
  // 各处理一遍；二是让后端知道这次启动已由预览分支接管 —— `window_ready`
  // 据此拒绝再点亮主界面。
  await api.takeLaunchTarget().catch(() => {});

  // 来源矩形来自后端记录的启动瞬间光标位置。后端给的是物理像素，这里统一折
  // 成物理像素的屏幕矩形，好让预览那边减掉自己的原点（见 `originRectOf`）。
  const point = await api.launchOrigin().catch(() => null);
  const origin = launchOriginScreenRect(point, window.devicePixelRatio || 1);

  const ok = await api.openViewer(payload.index ?? 0, origin, true);
  if (!ok) {
    // 预览没起来：留一个隐身的窗口，用户只会看到「启动了但什么都没有」。
    // 这时点亮主界面，至少还能选图。
    await api.showWindow().catch(() => {});
    dom.grid.focus();
  }
}

/**
 * 应用已运行时，用户又从 Finder 打开了另一张。
 *
 * 后端在派发这一次请求时已经直接把预览推起来了（`deliver_launch` 里
 * `is_ready()` 那一路），这里只负责让网格跟上新的图片集合 —— 用户关掉预览
 * 之后看见的应该是他刚打开的那个文件夹。
 */
function adoptLaunch(payload) {
  load({ items: payload.items, source: payload.source });
}

api
  .onLaunch((payload) => {
    const taken = claimLaunch(payload);
    if (taken) adoptLaunch(taken);
  })
  .catch((error) => toast(String(error)));

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

mountThemeToggles([el('btn-theme')]);

window.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) return;
  const key = event.key.toLowerCase();
  if (key === 'o') {
    event.preventDefault();
    pick(event.shiftKey ? 'folder' : 'files');
  }
});

// 网格获得焦点时回车 → 打开第一张（与鼠标点击同一条预览路径）
dom.grid.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && grid.count > 0) {
    event.preventDefault();
    openPreview(0, grid.cellFor(0));
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
 *   * 从文件管理器打开 —— 走 `bootLaunch()`：唤起预览窗口，主界面从头到尾
 *     都不出现（这次它就是不该露面）；
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
  // 事件通道已经在跑了（adoptLaunch 只更新数据，不点亮窗口）
  if (launchHandled) return;

  await api.showWindow();
  // 焦点给网格，回车就能打开第一张
  dom.grid.focus();
}

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
