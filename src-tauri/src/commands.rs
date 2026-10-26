//! 对前端暴露的 Tauri 命令。
//!
//! 设计约定：**打开资源是异步的**。`pick_images` 只是弹窗，
//! 真正的结果通过 `picshow://items` 事件推给前端——因为系统文件对话框
//! 的回调是 `FnOnce`，没法直接变成命令的返回值，硬要把异步转成同步
//! 只会阻塞 UI 线程。

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::{
    model::{ImageItem, ItemsPayload, LaunchOrigin, LaunchPayload, LaunchWindowRect},
    scanner,
    state::{looks_like_image, AppState},
};

/// 图片集合更新事件名。
pub const ITEMS_EVENT: &str = "picshow://items";
/// 「系统要求打开某张图」事件名（Finder 打开方式 / 资源管理器 / 命令行）。
pub const LAUNCH_EVENT: &str = "picshow://open-file";

/// 弹出系统文件/文件夹选择框，结果通过 `ITEMS_EVENT` 事件推送。
///
/// `kind`: `"folder"` 选择文件夹，其它值均视为多选文件。
#[tauri::command]
pub fn pick_images(app: AppHandle, kind: String) {
    let dialog = app.dialog().file();
    let handle = app.clone();

    if kind == "folder" {
        dialog
            .set_title("选择图片文件夹")
            .pick_folder(move |picked| {
                let paths = picked
                    .and_then(to_path)
                    .map(|p| vec![p])
                    .unwrap_or_default();
                publish(handle, paths);
            });
    } else {
        dialog
            .set_title("选择图片")
            .add_filter("图片", scanner::IMAGE_EXTS)
            .pick_files(move |picked| {
                let paths = picked
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(to_path)
                    .collect();
                publish(handle, paths);
            });
    }
}

/// 直接打开一个文件夹（供「最近打开」、拖放、命令行参数使用）。
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<Vec<ImageItem>, String> {
    let paths = vec![PathBuf::from(path)];
    let expanded = scanner::expand(&paths, true);
    if expanded.is_empty() {
        return Err("该文件夹中没有找到支持的图片".into());
    }
    let source = scanner::source_name(&paths);
    let items = app.state::<AppState>().replace(expanded);
    emit(&app, items.clone(), source);
    Ok(items)
}

/// 直接打开一组文件路径。
#[tauri::command]
pub fn open_paths(app: AppHandle, paths: Vec<String>) -> Result<Vec<ImageItem>, String> {
    let inputs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let expanded = scanner::expand(&inputs, true);
    if expanded.is_empty() {
        return Err("没有找到支持的图片".into());
    }
    let source = scanner::source_name(&inputs);
    let items = app.state::<AppState>().replace(expanded);
    emit(&app, items.clone(), source);
    Ok(items)
}

/* ------------------------------------------------------------------ *
 * 从文件管理器打开
 * ------------------------------------------------------------------ */

/**
 * 以「沉浸式预览」打开一张图：装载它所在目录的全部图片，并停在它自己那一张。
 *
 * 三种入口共用这一条路径：
 *   * macOS Finder 右键 → 打开方式 → PicShow（`RunEvent::Opened`）；
 *   * Windows 资源管理器 / Linux 文件管理器的关联打开（进程参数）；
 *   * 命令行 `picshow <文件>`（开发期自测就靠它）。
 */
#[tauri::command]
pub fn open_file_context(app: AppHandle, path: String) -> Result<LaunchPayload, String> {
    build_launch(&app, vec![PathBuf::from(path)])
}

/**
 * 取走「系统要求打开」的请求，取完即清空。
 *
 * 为什么不能只靠事件：应用被 Finder 唤起时，后端在 webview 执行第一行 JS
 * **之前**就把事件发出去了，那时没有任何监听者 —— 事件直接丢进黑洞。
 * 所以事件与这份「待取件」同时保留：已运行的应用走事件（立刻响应），
 * 冷启动的应用走这里（首屏就绪后主动取）。
 */
/// 来源缩略图的近似边长（CSS 像素）。
///
/// 文件管理器里的图标通常在 64–128px 之间；放大动画只需要「起点够小、
/// 看上去是从那一格长出来的」，不必追求精确。
const LAUNCH_ORIGIN_SIZE: f64 = 96.0;

/**
 * 后台线程里问一次光标位置，结果写进 `AppState::launch_origin`。
 *
 * **绝不能在主线程上直接问**：这条路 (`RuntimeHandle::cursor_position`)
 * 是「发一条消息给事件循环 → 阻塞等回执」，而处理那条消息的人正是主线程
 * 自己。命令恰好可能跑在主线程上，那样就是一个教科书级的自锁。
 * 丢进独立线程就没这个问题：请求排队、循环处理、回执唤醒的那条线程在等。
 *
 * 冷启动时这条线程甚至可能比事件循环更早动身 —— 也没关系，消息排在
 * 队列里，循环一转起来就会回复它。
 */
fn capture_launch_origin(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let origin = read_cursor_origin(&handle);
        if std::env::var("PICSHOW_DEBUG").is_ok() {
            match &origin {
                Some(o) => eprintln!(
                    "[picshow] 启动来源坐标：{}, {}（{}px）",
                    o.x.round(),
                    o.y.round(),
                    o.size
                ),
                None => eprintln!("[picshow] 启动来源坐标：取不到，退回屏幕中心"),
            }
        }
        handle.state::<AppState>().set_launch_origin(origin);
    });
}

/// 读光标当前位置。`size` 是 CSS 像素常量，坐标保持物理像素。
fn read_cursor_origin(app: &AppHandle) -> Option<LaunchOrigin> {
    let pos = app.cursor_position().ok()?;
    if !pos.x.is_finite() || !pos.y.is_finite() {
        return None;
    }
    Some(LaunchOrigin {
        x: pos.x,
        y: pos.y,
        size: LAUNCH_ORIGIN_SIZE,
    })
}

/// 前端在播放放大动画之前问一次来源矩形。
///
/// 为什么单独一条命令而不是塞进 `take_launch_target` 的返回值：那条 IP C
/// 发生得太早，来源坐标是后台线程补写的，那时大概率还没到。分开问就没竞态，
/// 取不到也只是退回屏幕中心的兜底动画。
#[tauri::command]
pub fn launch_origin(app: AppHandle) -> Option<LaunchOrigin> {
    app.state::<AppState>().launch_origin()
}

/**
 * 「打开方式」专用的一步到位入口：把窗口调成沉浸式形态 → 按屏幕尺寸摆好
 * → 点亮 → 最大化 → 改标题。
 *
 * 与常规入口的区别：常规入口是「先 `window_ready` 显示主界面，前端再决定
 * 要不要进预览」，中间那几帧用户是看得见的（先一个小窗口，再 maximize）。
 * 这条路径在窗口**还藏着**的时候就把尺寸定好，亮起来就已经是全屏，
 * 不存在「主界面一闪而过」。
 */
#[tauri::command]
pub fn prepare_launch_window(app: AppHandle, rect: LaunchWindowRect) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // 1. 形态：先把原生标题栏摘掉（亮起来之后改，会看见它「出现又消失」）
    drop_native_chrome(&window);
    app.state::<AppState>().set_immersive(true);

    // 2. 尺寸：直接铺到目标矩形，避免「小窗口 → 最大化」那一下位移
    if rect.width > 1.0 && rect.height > 1.0 {
        let size = tauri::LogicalSize::new(rect.width, rect.height);
        let pos = tauri::LogicalPosition::new(rect.x, rect.y);
        if let Err(e) = window.set_size(size) {
            eprintln!("[picshow] 设置沉浸式窗口尺寸失败: {e}");
        }
        if let Err(e) = window.set_position(pos) {
            eprintln!("[picshow] 设置沉浸式窗口位置失败: {e}");
        }
    }

    // 3. 点亮。顺序不能颠倒：对**隐藏**的窗口 maximize 不可靠（macOS 会在
    //    真正显示时把尺寸改回去），所以 maximize 必须排在 show 之后。
    reveal_main_window(&app);

    let _ = window.maximize();
    if let Some(name) = app.state::<AppState>().launch_title() {
        let _ = window.set_title(&format!("{name} — PicShow"));
    }
    // 后续再有文件管理器送来的请求，走「应用已在运行」的分支
    app.state::<AppState>().set_ready();
}

#[tauri::command]
pub fn take_launch_target(app: AppHandle) -> Option<LaunchPayload> {
    let taken = app.state::<AppState>().take_launch();
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        match &taken {
            Some(p) => eprintln!(
                "[picshow] 前端取走打开请求：{} 张，第 {} 张",
                p.items.len(),
                p.index + 1
            ),
            None => eprintln!("[picshow] 前端取走打开请求：无"),
        }
    }
    taken
}

/// 把系统传来的路径变成一次装载：既发事件，也存一份待取。
///
/// 只发事件会在冷启动时丢失，只存待取会让「已经开着的应用」毫无反应。
pub fn deliver_launch(app: &AppHandle, inputs: Vec<PathBuf>) {
    match build_launch(app, inputs) {
        Ok(payload) => {
            // 先把上次的记录作废，再重新问 —— 保证传给前端的一定是**这一次**
            // 的来源。后台线程补写需要几毫秒，前端是在播动画前才来取的。
            app.state::<AppState>().set_launch_origin(None);
            // 来源坐标必须**现在**就去问：此刻光标还停在那张图上，等前端
            // 装配完再问，用户大概率早就把鼠标挪走了。
            capture_launch_origin(app);
            if let Err(e) = app.emit(LAUNCH_EVENT, payload.clone()) {
                eprintln!("[picshow] 推送打开请求失败: {e}");
            }
            if std::env::var("PICSHOW_DEBUG").is_ok() {
                eprintln!(
                    "[picshow] 打开外部文件：{} 张，停在第 {} 张（{}）",
                    payload.items.len(),
                    payload.index + 1,
                    payload.name
                );
            }
            let state = app.state::<AppState>();
            state.set_launch(Some(payload.clone()));
            state.mark_launched(payload.name.clone());
            // 应用已经在跑（用户又从 Finder 打开了一张）→ 立刻把窗口叫到前台。
            // 冷启动则**不能**在这里 show：窗口是隐藏启动的（避免白底闪一帧），
            // 只能等前端装配完自己上报 window_ready。
            if app.state::<AppState>().is_ready() {
                // 已经跑起来了：把窗口叫到前台，并恢复沉浸式窗口形态
                reveal_main_window(app);
                apply_immersive_window(app);
            }
        }
        Err(e) => eprintln!("[picshow] 打开外部文件失败: {e}"),
    }
}

/// 进程参数里挑出像「文件路径」的那些。
///
/// macOS 走的是 Apple Event（参数里没有文件），但 Windows 关联打开、
/// Linux `.desktop` 的 `%F`、以及命令行自测都会落在 argv 上。
pub fn argv_targets() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| !p.to_string_lossy().starts_with('-'))
        .filter(|p| p.exists())
        .collect()
}

fn build_launch(app: &AppHandle, inputs: Vec<PathBuf>) -> Result<LaunchPayload, String> {
    let inputs: Vec<PathBuf> = inputs.into_iter().filter(|p| p.exists()).collect();
    if inputs.is_empty() {
        return Err("没有找到可打开的文件".into());
    }

    let (files, index, source) = if inputs.len() == 1 {
        let target = &inputs[0];
        if target.is_dir() {
            // 目录（拖到 Dock 图标 / 命令行传目录）：退化为「打开文件夹」
            (scanner::scan_dir(target, true), 0, scanner::source_name(&inputs))
        } else {
            if !looks_like_image(target) {
                return Err(format!(
                    "不支持的图片格式：{}",
                    scanner_source_name(target)
                ));
            }
            let (files, at) = scanner::scan_siblings(target);
            (files, at.unwrap_or(0), dir_name(target))
        }
    } else {
        // 多选：保留文件管理器给出的顺序 —— 用户选的顺序就是他要的顺序
        let files: Vec<PathBuf> = inputs
            .iter()
            .filter(|p| looks_like_image(p))
            .cloned()
            .collect();
        let source = inputs
            .first()
            .and_then(|p| p.parent())
            .map(dir_name)
            .unwrap_or_else(|| String::from("PicShow"));
        (files, 0, source)
    };

    if files.is_empty() {
        return Err("没有找到支持的图片".into());
    }

    let items = app.state::<AppState>().replace(files);
    let index = index.min(items.len() - 1);
    let name = items.get(index).map(|i| i.name.clone()).unwrap_or_default();

    Ok(LaunchPayload { items, index, source, name })
}

fn scanner_source_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// 所在目录名（用作窗口标题里的来源提示）。
fn dir_name(path: &std::path::Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("PicShow"))
}

/// 退出应用。沉浸式预览是「为看这张图而存在」的，Esc 之后就该彻底退回去，
/// 而不是留下一个空的浏览器界面。
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/**
 * 切换沉浸式窗口形态：关掉原生标题栏 + 铺满屏幕 + 标题跟上文件名。
 *
 * 为什么要关掉原生标题栏：它是**系统**绘制的，配色与毛玻璃跟随系统外观，
 * 跟我们纯色的预览面对不上（深浅色切换时尤其明显），而且它不在前端的控件
 * 层里 —— 空闲隐藏时按钮和胶片条都消失了，那条系统标题栏还杵在那儿。
 * 关掉之后，页面里那条 `.viewer-bar` 就是唯一标题栏：背景与预览同源，
 * 显隐跟着同一套计时逻辑走。
 *
 * `maximize` 必须在窗口**已经显示**之后调用：对隐藏窗口 maximize 不可靠
 * ——macOS 会在真正显示时把尺寸再改回去（实测时有时无，最难复现的那一类）。
 * 而 `set_decorations` 反倒要在显示**之前**做完，否则会看到形态跳动。
 */
fn apply_immersive_window(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.was_launched() && !state.is_immersive() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        drop_native_chrome(&window);
        let _ = window.maximize();
        if let Some(name) = state.launch_title() {
            let _ = window.set_title(&format!("{name} — PicShow"));
        }
    }
}

/// 关掉原生标题栏。
///
/// 失败必须打出来：静默失败的表现是「系统标题栏还在，颜色跟画面对不上」，
/// 谁也不会想到是这一步没生效。
fn drop_native_chrome(window: &tauri::WebviewWindow) {
    if let Err(e) = window.set_decorations(false) {
        eprintln!("[picshow] 关闭窗口装饰失败: {e}");
        return;
    }
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!("[picshow] 沉浸式：已去掉原生标题栏");
    }
}

/// 前端在进入 / 退出沉浸式预览时调用（只管窗口装饰，不动可见性）。
#[tauri::command]
pub fn set_immersive_chrome(app: AppHandle, enabled: bool) {
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!("[picshow] 前端请求沉浸式窗口形态: {enabled}");
    }
    app.state::<AppState>().set_immersive(enabled);
    if let Some(window) = app.get_webview_window("main") {
        if enabled {
            drop_native_chrome(&window);
        } else if let Err(e) = window.set_decorations(true) {
            eprintln!("[picshow] 恢复窗口装饰失败: {e}");
        }
    }
}

/**
 * 把用户选择的主题同步给**原生窗口**。
 *
 * 页面里的颜色全由 CSS 变量决定，但文件对话框这类系统绘制的东西不听 CSS
 * 的。用户手动选过主题之后必须把他喊过来，否则会出现「界面是浅色、弹出的
 * 文件选择器是深色」这种半深半浅。
 *
 * 注意这里是**单向**的：后端不再反过来告诉前端该用什么主题。默认深色 +
 * 用户选择持久化都落在前端（localStorage），多一条「系统说了算」的通道，
 * 用户的选择就会在某次系统外观变化后被悄悄覆盖掉。
 */
#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: String) {
    let wanted = match theme.as_str() {
        "light" => tauri::Theme::Light,
        _ => tauri::Theme::Dark,
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.set_theme(Some(wanted)) {
            eprintln!("[picshow] 同步原生窗口主题失败: {e}");
        }
    }
}

/// 在系统文件管理器中定位到某张图片。
///
/// 只接受会话内的 `id`，不把磁盘路径暴露给 webview——这样即使前端
/// 被注入恶意脚本，也无法枚举用户目录结构。
#[tauri::command]
pub fn reveal_image(app: AppHandle, id: u32) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = state.path_of(id).ok_or_else(|| "未知图片 id".to_string())?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/**
 * 把前端异常打印到终端（仅 `PICSHOW_DEBUG=1` 时输出）。
 *
 * webview 的 console 不会出现在终端里，而这类异常又全是「静默」的——
 * 界面只是「没反应」，看不出是哪一行炸了。这条命令是排查它们的唯一抓手。
 */
#[tauri::command]
pub fn log_error(message: String) {
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!("[picshow][前端] {message}");
    }
}

/// 缓存状态，用于调试面板。
#[tauri::command]
pub fn cache_stats(app: AppHandle) -> crate::model::CacheStats {
    app.state::<AppState>().stats()
}

/// 前端首屏装配完成后调用，把窗口真正显示出来。
///
/// 窗口在 `tauri.conf.json` 里配的是 `visible: false`——这是为了避免
/// webview 在 CSS 生效前先闪一帧白底。代价就是**必须**有人负责把它点亮，
/// 否则窗口会一直隐身，用户只能看到一个「启动了但什么都没有」的进程。
///
/// 用自定义命令而不是内置的 `plugin:window|show`：应用自带的命令不走
/// capabilities 权限校验，少一处配置出错的可能；顺带把焦点也一起设了。
#[tauri::command]
pub fn window_ready(app: AppHandle) {
    let state = app.state::<AppState>();
    state.set_ready();
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!("[picshow] 前端首屏就绪");
    }

    // 顺序要紧：
    //   1. 窗口还藏着的时候先定好形态（去掉原生标题栏）—— 亮起来之后再改，
    //      用户会看见标题栏「出现又消失」的跳动；
    //   2. 再 show；
    //   3. 最后 maximize —— 对**隐藏**的窗口调用 maximize 不可靠，macOS 会在
    //      真正显示时把尺寸再改回去（实测时有时无，是最难复现的那一类）。
    if state.was_launched() || state.is_immersive() {
        if let Some(window) = app.get_webview_window("main") {
            drop_native_chrome(&window);
        }
    }
    reveal_main_window(&app);
    apply_immersive_window(&app);
}

/// 显示并聚焦主窗口；窗口不存在时静默跳过。
pub(crate) fn reveal_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn to_path(fp: FilePath) -> Option<PathBuf> {
    fp.into_path().ok()
}

fn publish(app: AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let source = scanner::source_name(&paths);
    let expanded = scanner::expand(&paths, true);
    if expanded.is_empty() {
        return;
    }
    let items = app.state::<AppState>().replace(expanded);
    emit(&app, items, source);
}

fn emit<R: tauri::Runtime>(app: &AppHandle<R>, items: Vec<ImageItem>, source: String) {
    if let Err(e) = app.emit(ITEMS_EVENT, ItemsPayload { items, source }) {
        eprintln!("[picshow] 推送图片列表失败: {e}");
    }
}
