/**
 * 应用入口：装配网格与全屏查看器，绑定工具栏、快捷键与拖放提示。
 */

import * as api from './api.js';
import { Grid } from './grid.js';
import { Viewer } from './viewer.js';

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
  onError: (message) => toast(message)
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
 * 工具栏 / 快捷键
 * ------------------------------------------------------------------ */

function pick(kind) {
  api.pickImages(kind).catch((error) => toast(String(error)));
}

el('btn-open-files').addEventListener('click', () => pick('files'));
el('btn-open-folder').addEventListener('click', () => pick('folder'));
el('btn-empty-files').addEventListener('click', () => pick('files'));
el('btn-empty-folder').addEventListener('click', () => pick('folder'));

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
dom.grid.focus();

// 首屏已就绪 —— 让后端把窗口显示出来（隐藏启动，见 tauri.conf.json）。
api.showWindow();
