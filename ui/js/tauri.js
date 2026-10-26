/**
 * 极简 Tauri v2 IPC 封装（零依赖，不引入 @tauri-apps/api）。
 *
 * Tauri 2 会在 webview 里注入 `window.__TAURI_INTERNALS__`，官方的
 * `@tauri-apps/api` 本质上也只是对它的薄封装。这里只用到 `invoke` 和
 * `listen` 两个能力，手写几行就能省掉整个 node_modules 和打包步骤。
 */

const internals =
  typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;

export const isTauri = Boolean(
  internals && typeof internals.invoke === 'function'
);

/**
 * 调用后端命令，返回 Promise。
 *
 * 非 Tauri 环境下（比如有人直接在浏览器里打开了开发服务器地址）拒绝并给出
 * 可执行的补救办法，而不是抛一条只有 IPC 内部人才看得懂的错误。
 */
export function invoke(cmd, args = {}) {
  if (!isTauri) {
    return Promise.reject(
      new Error(
        `无法调用命令 "${cmd}"：当前不在 Tauri 窗口中运行。` +
          'localhost:1420 是 Tauri 内部加载前端用的开发服务器地址，' +
          '在普通浏览器里没有后端注入。请运行 npm run dev，' +
          '并在弹出的桌面窗口中使用 PicShow。'
      )
    );
  }
  return internals.invoke(cmd, args);
}

/**
 * 监听后端事件，返回 `unlisten` 函数。
 *
 * 走的是 Tauri 内置的 event 插件：`plugin:event|listen` 接受一个由
 * `transformCallback` 生成的回调句柄，后端直接回调该句柄推送数据。
 *
 * 回调参数形状：Tauri 内部生成的桥接脚本是
 * `fn({event: '<名字>', payload: <负载>}, ids)`，且在调用前补上 `id`。
 * 也就是说 handler 收到的是**完整的事件对象** `{ event, payload, id }`，
 * 再包一层会导致调用方取到 `{event,payload,id}.payload` 之外的结构——
 * 即「事件到了、数据却永远是空」这类静默故障。这里原样透传。
 */
export async function listen(event, handler) {
  if (!isTauri) return () => {};

  let eventId = 0;
  const callbackId = internals.transformCallback((eventData) => {
    handler({ event, payload: eventData?.payload, id: eventId });
  });

  eventId = await invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' }, // EventTarget::Any
    handler: callbackId
  });

  return () => {
    // `#[tauri::command]` 默认把参数名转成 camelCase，
    // 所以 Rust 侧的 `event_id` 在这里写作 `eventId`。
    invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
    if (typeof internals.unregisterCallback === 'function') {
      internals.unregisterCallback(callbackId);
    }
  };
}

/**
 * 通知后端显示主窗口。
 *
 * 窗口在 `tauri.conf.json` 里是隐藏启动的，由前端在首屏就绪后点亮，
 * 这样用户不会看到 webview 加载初期的白底闪烁。浏览器环境下静默跳过
 * ——那里的可见性本来就由浏览器自己管。
 */
export async function showWindow() {
  if (!isTauri) return;
  await invoke('window_ready').catch(() => {});
}

/** 同步窗口标题（可选能力，权限未开启时静默跳过）。 */
export async function setWindowTitle(title) {
  try {
    await invoke('plugin:window|set_title', { label: 'main', title });
  } catch {
    /* ignore */
  }
}
