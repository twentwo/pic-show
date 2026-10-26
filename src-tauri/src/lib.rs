//! PicShow —— 用 Tauri 2 复刻早期 Google Picasso 的看图体验。
//!
//! 模块职责：
//!   * `scanner`  —— 把文件/文件夹展开成有序图片路径；
//!   * `imaging`  —— 解码 / 缩放 / 编码；
//!   * `state`    —— 图片注册表与两级缓存；
//!   * `protocol` —— `img://` 协议，图片的统一出口；
//!   * `commands` —— 前端可调的命令。

mod commands;
mod error;
mod imaging;
mod model;
mod protocol;
mod scanner;
mod state;

use tauri::{Listener, Manager};
use state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        // 异步协议：解码在独立线程里完成，绝不占用 UI 线程。
        .register_asynchronous_uri_scheme_protocol("img", protocol::img_protocol)
        .invoke_handler(tauri::generate_handler![
            commands::pick_images,
            commands::open_folder,
            commands::open_paths,
            commands::reveal_image,
            commands::cache_stats,
            commands::window_ready,
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("picshow"));
            let _ = std::fs::create_dir_all(&data_dir);
            app.state::<AppState>().set_cache_dir(data_dir);

            // 窗口是隐藏启动的，等前端首屏装配完再点亮（见 commands::window_ready）。
            // 这里再补一道兜底：万一前端因脚本报错没能上报就绪，宁可闪一下
            // 也不能让用户对着一个隐身的窗口发呆。
            let fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(3000));
                if let Some(window) = fallback.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(false) {
                        commands::reveal_main_window(&fallback);
                    }
                }
            });

            // 支持把文件/文件夹直接拖到窗口里打开。
            let handle = app.handle().clone();
            app.listen("tauri://drag-drop", move |event| {
                let payload = event.payload();
                let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
                    return;
                };
                let Some(paths) = value.get("paths").and_then(|p| p.as_array()) else {
                    return;
                };
                let inputs: Vec<std::path::PathBuf> = paths
                    .iter()
                    .filter_map(|p| p.as_str())
                    .map(std::path::PathBuf::from)
                    .collect();
                if !inputs.is_empty() {
                    let _ = commands::open_paths(handle.clone(), inputs
                        .into_iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect());
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 PicShow 失败");
}
