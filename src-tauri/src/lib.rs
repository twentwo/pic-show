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

// macOS 的无边框窗口缺原生全屏能力，得写一小段 AppKit 才补得回来。
// 其它平台不需要这一段，`cargo check` 也不会去看它。
#[cfg(target_os = "macos")]
mod macos;

use std::path::PathBuf;

use tauri::{Listener, Manager};
use state::AppState;

pub fn run() {
    // 「打开方式」的桌面恢复从这里开始：记下**此刻**的前台应用（那就是触发
    // 打开操作的访达）。必须早于 `build()` —— 那时 `NSApplication` 还没初始
    // 化、应用还没被激活，读到的才不是自己。`tools/appkit_space_restore.swift`
    // 把这条时序测成了事实；晚一步再捕获就只能记到 PicShow 自己。
    //
    // 这里只是「记录」，不改变任何窗口行为；真正的交还只发生在沉浸式会话
    // 退出时（见 `commands::hand_back_launch_source`）。
    #[cfg(target_os = "macos")]
    crate::macos::capture_launch_source();

    // 启动意图在**第一行**就判定：命令行里带了图片路径，这次就是「被系统要求
    // 看图」，主界面从头到尾都不该出现。
    //
    // 必须在 `build()`（它会创建窗口并让 webview 开始加载）之前做完：晚一步，
    // 「主界面到底露不露面」就变成一个由前端加载速度决定的竞态了。
    let cli_targets = commands::argv_targets();

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
            commands::launch_decision_budget,
            commands::open_viewer,
            commands::viewer_listening,
            commands::viewer_boot,
            commands::viewer_ready,
            commands::close_viewer,
            commands::focus_viewer,
            commands::window_origin,
            commands::focus_window,
            commands::reveal_image,
            commands::cache_stats,
            commands::log_error,
            commands::window_ready,
            commands::exit_app,
            commands::set_window_theme,
        ])
        // 窗口事件：预览窗口的原生关闭请求要转成**前端那条正常关闭路径**。
        //
        // 用户点红色交通灯 / 按 `Cmd+W` 时默认行为是直接销毁窗口，那样就没机会
        // 播退场动画、把「看到第几张」送回图片墙、或让沉浸式会话一并退出应用。
        // 所以在这里拦下来交给前端；前端收摊后调 `close_viewer`，后端再
        // `destroy()` 真正销毁。Esc、双击、关闭按钮、交通灯四条路径因此完全
        // 一致。
        //
        // `destroy()` 不触发 `CloseRequested`（强制关闭、不发事件），不会绕圈。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != commands::VIEWER_LABEL {
                    return;
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    let viewer = app.get_webview_window(commands::VIEWER_LABEL);
                    // eval 失败（webview 已经不在了）就自己在后端销毁窗口，不能
                    // 让一条既关不掉又占着全屏的窗口留在层级里。
                    let handed = viewer
                        .as_ref()
                        .map(|w| w.eval("window.__picshowRequestClose?.()"))
                        .unwrap_or(Ok(()));
                    if handed.is_err() {
                        commands::release_viewer(&app);
                    }
                });
            }
        })
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("picshow"));
            let _ = std::fs::create_dir_all(&data_dir);
            app.state::<AppState>().set_cache_dir(data_dir);

            // 窗口样式在**启动阶段**跑一次：那时图片墙与首条预览窗口都在
            // （两条都在 `tauri.conf.json` 里声明），一次遍历全部设好。
            //
            // 预览窗口退出即销毁，重建时 `ensure_viewer_window` 会再跑一次；函数
            // 会跳过已经设过的窗口，所以**每条窗口一生仍只被设定一次**，绝不在
            // 运行时改动已存在窗口的样式 —— 这是「退出预览后窗口停在最大化、
            // 标题栏回不来」那类故障的根治办法：只要在运行时切换过「有没有标题
            // 栏」，窗口层就会记下一份「退出全屏时照着恢复」的样式，并在每次退出
            // 时无条件写回它。不动它，就没有这条覆盖链。
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                if let Err(e) =
                    handle.run_on_main_thread(crate::macos::apply_immersive_frame)
                {
                    eprintln!("[picshow] 投递窗口样式设定失败: {e}");
                }
            }

            // 窗口是隐藏启动的，等前端首屏装配完再点亮（见 commands::window_ready）。
            // 这里再补一道兜底：万一前端因脚本报错没能上报就绪，宁可闪一下
            // 也不能让用户对着一个隐身的窗口发呆。
            //
            // 但**预览已经接管时绝不能插手**：那是「打开方式」的冷启动路径，
            // 主界面从头到尾都不该露面。少了这道判断，用户会在看第三张图的
            // 时候被一张图片墙盖住屏幕。
            let fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(3000));
                let viewer_up = fallback
                    .get_webview_window(commands::VIEWER_LABEL)
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if viewer_up {
                    return;
                }
                if let Some(window) = fallback.get_webview_window(commands::MAIN_LABEL) {
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
    //
    // 注意这里**只是登记**，不点亮窗口：窗口是隐藏启动的，点亮由
    // `prepare_launch_window` 独家负责，主界面因此一次都不会露面。
    if !cli_targets.is_empty() {
        commands::deliver_launch(app.handle(), cli_targets);
    }

    // 第二条通道：运行期事件。Finder 的「打开方式」在应用**已经运行**时
    // 走的正是这条路（冷启动那次也走，只是那时还没有前端在听，靠 pending 补）。
    app.run(|handle, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            // 应用**已经在运行**时又被「打开方式」唤起：这是新的一次打开，
            // 趁 LaunchServices 还没把 PicShow 彻底激活，再记一次触发者（冷
            // 启动那次走的是 `run()` 第一行）。读到自己时 `capture` 会保留
            // 旧记录，不会把来源覆盖成 PicShow。
            #[cfg(target_os = "macos")]
            {
                crate::macos::capture_launch_source();
                // 只给 Finder 的「打开方式」启用「退出时把桌面交还回去」。
                // 命令行 argv 那条通道不经过这里，退出行为原样不变。
                handle.state::<AppState>().arm_space_restore();
            }
            let paths: Vec<PathBuf> = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect();
            if !paths.is_empty() {
                commands::deliver_launch(handle, paths);
            }
            return;
        }
        // 退出路径的兜底：无论因为什么退出（主窗口关掉、Dock 菜单退出、系统
        // 关机），都先销毁预览窗口。进程一死 AppKit 也会回收那个全屏桌面，但
        // 先销毁窗口能让退出那一瞬不闪出常规尺寸的空白窗口帧。
        //
        // 沉浸式会话（打开方式）还要把桌面与焦点交还给触发打开的那个应用；
        // 常规启动 / 图片墙路径 `hand_back_launch_source` 会自己判定并直接跳过。
        if let tauri::RunEvent::ExitRequested { .. } = event {
            commands::release_viewer_now(handle);
            commands::hand_back_launch_source(handle);
        }
    });
}
