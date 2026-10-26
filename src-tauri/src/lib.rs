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

use std::path::PathBuf;

use tauri::{Listener, Manager};
use state::AppState;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        // 异步协议：解码在独立线程里完成，绝不占用 UI 线程。
        .register_asynchronous_uri_scheme_protocol("img", protocol::img_protocol)
        .invoke_handler(tauri::generate_handler![
            commands::pick_images,
            commands::open_folder,
            commands::open_paths,
            commands::open_file_context,
            commands::take_launch_target,
            commands::launch_origin,
            commands::prepare_launch_window,
            commands::reveal_image,
            commands::cache_stats,
            commands::log_error,
            commands::window_ready,
            commands::exit_app,
            commands::set_immersive_chrome,
            commands::set_window_theme,
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
        .build(tauri::generate_context!())
        .expect("构建 PicShow 失败");

    // 「从文件管理器打开」的第一条通道：进程参数。
    // Windows 关联打开、Linux .desktop 的 %F、以及命令行自测都走这里；
    // macOS 不走（LaunchServices 不把文件放进 argv），由下面的 Opened 事件接管。
    let argv = commands::argv_targets();
    if !argv.is_empty() {
        commands::deliver_launch(app.handle(), argv);
    }

    // 第二条通道：运行期事件。Finder 的「打开方式」在应用**已经运行**时
    // 走的正是这条路（冷启动那次也走，只是那时还没有前端在听，靠 pending 补）。
    app.run(|handle, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<PathBuf> = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect();
            if !paths.is_empty() {
                commands::deliver_launch(handle, paths);
            }
        }
    });
}
