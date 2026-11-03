//! 对前端暴露的 Tauri 命令。
//!
//! 设计约定：**打开资源是异步的**。`pick_images` 只是弹窗，
//! 真正的结果通过 `picshow://items` 事件推给前端——因为系统文件对话框
//! 的回调是 `FnOnce`，没法直接变成命令的返回值，硬要把异步转成同步
//! 只会阻塞 UI 线程。

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::{
    model::{
        ImageItem, ItemsPayload, LaunchOrigin, LaunchPayload, OriginRect, ScreenPoint,
        ViewerClosed, ViewerFrame, ViewerRequest, ViewerSession,
    },
    scanner,
    state::{looks_like_image, AppState},
};

/// 图片集合更新事件名。
pub const ITEMS_EVENT: &str = "picshow://items";
/// 「系统要求打开某张图」事件名（Finder 打开方式 / 资源管理器 / 命令行）。
pub const LAUNCH_EVENT: &str = "picshow://open-file";
/**
 * 预览窗口的 label。
 *
 * 图片墙与预览是**两个物理窗口**：预览自己独占一个窗口、自己进全屏、关掉时
 * **整个销毁**（不是隐藏），下次进入再按同一份配置重建一条。图片墙那条窗口
 * 因此既没进过全屏、也没被程序写过几何 —— 它根本没有「退出预览要还原到什
 * 么」这回事。
 */
pub const VIEWER_LABEL: &str = "viewer";
/// 主窗口的 label。
pub const MAIN_LABEL: &str = "main";
/// 预览关闭事件名（主窗口据此把网格滚到用户最后看的那一张）。
pub const VIEWER_CLOSED_EVENT: &str = "picshow://viewer-closed";
/// 让已经开着的预览直接换到另一张（不再重播开场动画）。
pub const VIEWER_GOTO_EVENT: &str = "picshow://viewer-goto";

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
 * 「这次启动到底是不是被系统要求打开某张图」的判定窗口（毫秒）。
 *
 * Windows 的关联打开、Linux 的 `%F` 会把路径直接放进 argv —— 那在进程起来
 * 的第一行就能判定，一次都不用等。macOS 不行：LaunchServices 不把文件放进
 * argv，而是等事件循环转起来之后用 Apple Event 送来，那时前端首屏可能已经
 * 装配完了。
 *
 * 于是给这条慢通道留一个**从进程启动时刻起算**的绝对预算：首屏但凡比它慢
 * （真实情况几乎总是），前端来问时预算已经耗尽，常规启动一点没被拖慢；
 * 万一前端快得离谱，也只是多藏了剩下的那几十毫秒 —— 窗口本来就是藏着的。
 */
const LAUNCH_DECIDE_MS: u64 = 300;

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

/**
 * 距离「启动意图判定」截止还剩多少毫秒（0 = 立刻按常规启动走）。
 *
 * 前端首屏就绪时若还拿不到打开请求，就按这个预算再等一小会儿 —— 窗口反正
 * 还藏着，等的代价是零；预算耗尽仍无消息，就说明这次确实是常规启动。
 */
#[tauri::command]
pub fn launch_decision_budget(app: AppHandle) -> u64 {
    app.state::<AppState>().launch_decision_budget(LAUNCH_DECIDE_MS)
}

/**
 * 把键盘焦点交给主窗口。
 *
 * 必须由前端在「窗口已显示」之后调用一次：窗口是**隐藏启动**的
 * （`visible: false`，避免 webview 加载初期闪一帧白底），而隐藏窗口上调用
 * `set_focus` 会被平台直接忽略（tao 的实现里第一条判断就是 `isVisible`）。
 *
 * 以前这里还要排在 `maximize()` 之后（zoom 动画会把刚抢到的 key window 让出
 * 去）。现在主窗口既不最大化也不进全屏 —— 预览是另一个窗口 —— 那条顾虑随
 * 之消失，这个命令只剩「窗口亮了才能要焦点」这一条。
 */
#[tauri::command]
pub fn focus_window(app: AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    // 对还没点亮的窗口要焦点是没意义的，平台会直接忽略
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if let Err(e) = window.set_focus() {
        eprintln!("[picshow] 设置窗口焦点失败: {e}");
    }
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

/* ------------------------------------------------------------------ *
 * 预览窗口
 *
 * 图片墙与预览是**两个物理窗口**（`main` 与 `viewer`）：预览自己独占一个窗
 * 口、自己进操作系统级全屏、关闭时**整个销毁**，下次进入再重建。
 *
 * # 为什么必须分开
 *
 * 共用窗口时，「进入预览」只能靠切换同一个窗口的形态（进全屏 / 退出去装饰 /
 * 摆尺寸），而**任何**一次对窗口几何或样式的写入都会被窗口层记成「退出全屏
 * 时照着还原」的目标：
 *
 *   * 运行时摘过装饰 → tao 把无边框那份 styleMask 存进 `saved_style`，退出时
 *     无条件写回，我们补回标题栏那一笔必然被覆盖；
 *   * 进全屏前把窗口摆到整块屏 → macOS 当场判定它 `zoomed`，从此把「最大化」
 *     当成全屏前的样子，退出时一丝不差地还原到**最大化**。
 *
 * 这两条都排在同一个 `DispatchQueue.main` 的 FIFO 里，谁在后谁生效 —— 纯竞
 * 态，靠「等 N 毫秒再写」卡不住。
 *
 * 分成两个窗口之后，图片墙那条窗口**一次全屏都没进过、一次几何都没被写
 * 过**，于是它根本不存在「退出预览要还原到什么」这个问题：它就待在用户最后
 * 摆放的位置上。
 * ------------------------------------------------------------------ */

/**
 * 打开预览：把会话交给预览窗口，让它自己全屏亮起来。
 *
 * 刻意**不碰主窗口的几何**：不 `set_size`、不 `set_position`、不
 * `set_maximized`、不 `set_decorations`、也不 `set_fullscreen`。主窗口的几何
 * 终身只读，这是整个方案成立的前提（见本节的模块注释）。
 *
 * @param index 停在第几张
 * @param origin 开场动画起点（屏幕坐标系），拿不到时传 `null`
 * @param immersive 这次是不是「从文件管理器打开」来的（关闭即退出应用）
 */
#[tauri::command]
pub fn open_viewer(
    app: AppHandle,
    index: usize,
    origin: Option<OriginRect>,
    immersive: bool,
) -> bool {
    let state = app.state::<AppState>();
    let items = state.all_items();
    if items.is_empty() {
        return false;
    }

    // 上一次退出预览时那条窗口已经被**销毁**了。这里按需重建一条同 label、同
    // 配置的窗口 —— 不是另开一条，也不是把谁再显示出来。所以任何时刻进程里
    // 最多只有一条 viewer，不会堆积、不会泄漏（见 `ensure_viewer_window`）。
    if !ensure_viewer_window(&app) {
        return false;
    }

    let source = state.launch_title().unwrap_or_else(|| String::from("PicShow"));
    let request = ViewerRequest {
        index: index.min(items.len() - 1),
        origin,
        immersive,
        source,
        items,
    };

    // 预览那条窗口已经在跑了：推一次事件让它换内容，别再经历一遍「建窗口 →
    // 切全屏」的开场。刚重建的窗口 `viewer_listening` 是 false（见
    // `ensure_viewer_window`），这时请求会留在后端，等它装配完自己来取
    // （`viewer_listening` / `viewer_boot`）—— 事件不会掉进黑洞。
    if state.is_viewer_listening() {
        emit_goto(&app, &request);
    } else {
        state.set_viewer_request(request);
    }

    // 世代号 +1：上一次「让位」如果还在等全屏转场播完，此刻起就算过期 —— 它
    // 不该把这一次刚点亮的窗口又藏起来（见 `release_viewer`）。
    state.bump_viewer_epoch();

    // 后续再有文件管理器送来的请求，走「应用已在运行」的分支
    state.set_ready();
    true
}

/**
 * 保证预览窗口存在；没有就按 `tauri.conf.json` 里同一份配置重建一条。
 *
 * # 为什么退出时销毁、进入时重建
 *
 * 以前预览窗口是常驻的，退出只 `hide()`。那条路有两个绕不开的问题：
 *
 *   1. 原生全屏窗口独占一个桌面（Space），`hide()` 不释放它 —— Mission
 *      Control 里会留下一个空的 PicShow 桌面；
 *   2. 想让 AppKit 收掉那个桌面就得先退出全屏，而那段转场里窗口会从整屏缩
 *      回 1200×800 —— 那**一帧正是用户看到的空白窗口**；转场收尾还会把刚
 *      藏掉的窗口拉回屏幕（实测见 `tools/appkit_fullscreen_exit.swift`）。
 *
 * 直接 `destroy()` 一个还在全屏里的窗口，AppKit 会自己走完
 * `windowDidExitFullScreen:` 把桌面收掉，窗口同时从层级里移除，**中间不出现
 * 常规尺寸的空白窗口帧**（同一探针的 `--close-in-fullscreen` 模式）。窗口对象
 * 都没了，也就不存在「残留」。
 *
 * # 为什么不会重复创建 / 泄漏
 *
 * 先看 `get_webview_window(VIEWER_LABEL)`：存在就复用，一条都不新建。销毁时
 * Tauri 发 `Destroyed` 事件并把 label 从注册表移除（`manager::on_window_close`），
 * 所以下一次能安全地用同一个 label 重建。配置直接取自 `app.config().app.windows`
 * 里 label 相同的那一份 —— 与首次启动那条窗口**逐字段一致**，不必手写复制。
 *
 * `viewer_listening` 随旧窗口一起作废：新窗口的 webview 还没装配，在它上报
 * `viewer_listening()` 之前不能发事件，否则请求会掉进黑洞。
 */
fn ensure_viewer_window(app: &AppHandle) -> bool {
    if app.get_webview_window(VIEWER_LABEL).is_some() {
        return true;
    }

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label.as_str() == VIEWER_LABEL)
        .cloned()
    else {
        eprintln!("[picshow] 找不到预览窗口配置，无法重建预览窗口");
        return false;
    };

    match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(_) => {
            // 新窗口的 webview 还在加载，旧窗口那个「我能收事件了」已经过期
            app.state::<AppState>().set_viewer_listening(false);

            // 每个窗口在**诞生时**设定一次沉浸式外观。`apply_immersive_frame`
            // 会跳过已设过的窗口（主窗口在启动时设过），所以只有新窗口会被设
            // 到，且之后再也不动它 —— 不会触发 tao 的 saved_style 覆盖链。
            #[cfg(target_os = "macos")]
            {
                let _ = app.run_on_main_thread(crate::macos::apply_immersive_frame);
            }

            if std::env::var("PICSHOW_DEBUG").is_ok() {
                eprintln!("[picshow] 预览窗口已重建（上一条在退出时销毁）");
            }
            true
        }
        Err(e) => {
            eprintln!("[picshow] 重建预览窗口失败: {e}");
            false
        }
    }
}

/// 把一次预览请求以事件形式送进已经在跑的预览窗口。
fn emit_goto(app: &AppHandle, request: &ViewerRequest) {
    let session = ViewerSession {
        items: request.items.clone(),
        index: request.index,
        source: request.source.clone(),
        immersive: request.immersive,
        // 已经开着的预览不重播开场动画（那时它不在屏幕上，没有来源可言）
        origin: request.origin,
    };
    if let Err(e) = app.emit(VIEWER_GOTO_EVENT, session) {
        eprintln!("[picshow] 推送预览请求失败: {e}");
    }
}

/**
 * 预览窗口报告「我可以收事件了」。
 *
 * 这是冷启动那条必经之路的解药：两个窗口的 webview 同时开始加载，谁先跑完
 * 是不确定的。主窗口先跑完就直接发事件，而预览那边监听还没注册上 —— 事件
 * 直接掉进黑洞。所以改成让预览自己喊一声，并把「喊之前那段时间里攒下的请
 * 求」补送过去。与 `take_launch_target` 那条「事件 + 待取件并存」是同一个
 * 路子。
 */
#[tauri::command]
pub fn viewer_listening(app: AppHandle) {
    let state = app.state::<AppState>();
    state.set_viewer_listening(true);
    // 装配那几帧里有人开过预览：取出来补送，否则它会一直悬着
    if let Some(request) = state.take_viewer_request() {
        emit_goto(&app, &request);
    }
}

/**
 * 预览窗口取走自己的会话（取完即清空）。
 *
 * 两个 webview 之间没有共享的 JS 上下文，这是预览拿到「看哪些图、停在哪一
 * 张、从哪一格长出来」的唯一通道。取完即清空，免得下次预览继承了上次的陈旧
 * 入口 —— 那种表现是「点第 3 张，出来的是上一次那张」。
 *
 * 取不到返回 `null`：那时主窗口还没开预览，预览就进入待命，由
 * `picshow://viewer-goto` 事件唤醒。
 */
#[tauri::command]
pub fn viewer_boot(app: AppHandle) -> Option<ViewerSession> {
    let state = app.state::<AppState>();
    let request = state.take_viewer_request()?;
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!(
            "[picshow] 预览取走会话：{} 张，第 {} 张（immersive={}）",
            request.items.len(),
            request.index + 1,
            request.immersive
        );
    }
    Some(ViewerSession {
        items: request.items,
        index: request.index,
        source: request.source,
        immersive: request.immersive,
        origin: request.origin,
    })
}

/**
 * 预览准备好播开场动画了：切进全屏、点亮，并回报自己「在哪儿、有多大」。
 *
 * 原点用来把来源矩形从**屏幕坐标**折成预览自己的视口坐标：全屏窗口落在哪块
 * 屏取决于主窗口在哪块屏，视口原点因此未必是 (0,0)，硬当成 (0,0) 会让开场
 * 动画在多显示器上从错误的位置长出来。
 *
 * 尺寸用来让前端判断「视口真的长到终态了没有」。以前它拿 `window.screen` 去
 * 猜，而带缩放的屏上 `screen.height` 与 `clientHeight` 常常差着一两个像素，
 * 逼着人把阈值放宽、于是白等好几帧 —— 那几帧画面还没开始长，用户看到的就是
 * 一段纯黑。后端直接给准数，等一两帧就能开工。
 *
 * 刻意**没有**「全屏失败就 `maximize()`」的兜底：最大化没有撤回路径，一旦
 * 走到就把窗口永久留在放大态 —— 正是「退出预览后回不到原尺寸」的直接来源。
 * 全屏拿不到就保持窗口态，预览照样能用。
 */
#[tauri::command]
pub fn viewer_ready(app: AppHandle) -> Option<ViewerFrame> {
    let window = app.get_webview_window(VIEWER_LABEL)?;
    if let Some(name) = app.state::<AppState>().launch_title() {
        let _ = window.set_title(&format!("{name} — PicShow"));
    }
    if !window.is_fullscreen().unwrap_or(false) {
        // 不再需要「退出全屏要回到什么尺寸」的记账：关闭时整条窗口会被销毁，
        // AppKit 自己把那个全屏桌面收掉，没有一段需要等的转场。
        if std::env::var("PICSHOW_DEBUG").is_ok() {
            eprintln!("[picshow] 预览窗口：请求进入全屏");
        }
        if let Err(e) = window.set_fullscreen(true) {
            eprintln!("[picshow] 预览窗口进入全屏失败，预览保持在窗口态: {e}");
        }
    }
    let _ = window.show();
    let (x, y) = window
        .outer_position()
        .map(|p| (p.x as f64, p.y as f64))
        .unwrap_or((0.0, 0.0));
    let (width, height) = window
        .inner_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((0.0, 0.0));
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!(
            "[picshow] 预览窗口就绪：全屏={} 原点=({x}, {y}) 内容区={width}×{height}",
            window.is_fullscreen().unwrap_or(false)
        );
    }
    Some(ViewerFrame { x, y, width, height })
}

/**
 * 把键盘焦点交给预览窗口。
 *
 * 必须由预览自己在「首图已落地」之后调用一次：切全屏是一段 Space 过场动画，
 * 会把刚抢到的 key window 让出去；图片还在解码时落焦点，用户按下的第一个
 * 方向键落在的是「什么都还没画出来」的画面。
 */
#[tauri::command]
pub fn focus_viewer(app: AppHandle) {
    let Some(window) = app.get_webview_window(VIEWER_LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    // 焦点这条链上有三处会悄悄失败（窗口还没亮 / 还在 Space 过场里 / 焦点被
    // 让出去），而三处的表现都是「方向键没反应」。真机上只能靠这条日志区分。
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!(
            "[picshow] 预览窗口焦点请求：visible={visible} fullscreen={} focused={}",
            window.is_fullscreen().unwrap_or(false),
            window.is_focused().unwrap_or(false)
        );
    }
    if !visible {
        return;
    }
    if let Err(e) = window.set_focus() {
        eprintln!("[picshow] 设置预览窗口焦点失败: {e}");
    }
}

/**
 * 主窗口左上角在屏幕坐标系里的位置（物理像素）。
 *
 * 主窗口要把「第 N 格缩略图」的位置交给预览窗口当动画起点，而
 * `getBoundingClientRect()` 给的是**视口坐标** —— 加上主窗口自己的原点才是
 * 两个窗口都能读懂的屏幕坐标。
 *
 * 单位是物理像素：两端都用同一套单位，加减就抵消掉了，不必去问
 * `scale_factor`（那是个「发消息给事件循环 → 阻塞等回执」的 getter，在命令
 * 里问它会自锁）。
 */
#[tauri::command]
pub fn window_origin(app: AppHandle) -> Option<ScreenPoint> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let (x, y) = window
        .outer_position()
        .map(|p| (p.x as f64, p.y as f64))
        .unwrap_or((0.0, 0.0));
    Some(ScreenPoint { x, y })
}

/**
 * 关闭预览。
 *
 * 预览那条窗口会被**真正销毁**（`destroy()`），不是隐藏、不是清空内容、也不是
 * 只把画布摘掉。下一次进入预览由 `ensure_viewer_window` 按同一份配置重建一条。
 *
 * 为什么销毁而不是隐藏：原生全屏窗口独占一个桌面（Space）。`hide()` 既不释放
 * 那个桌面，还要先播一段「整屏缩回 1200×800」的退出转场 —— 那一帧正是用户看
 * 到的空白窗口，转场收尾还会把刚藏掉的窗口拉回屏幕。直接销毁一个仍在全屏里
 * 的窗口，AppKit 自己走完 `windowDidExitFullScreen:` 把桌面收掉，窗口同时从层
 * 级里移除，中间不出现常规尺寸的空白窗口帧（实测见
 * `tools/appkit_fullscreen_exit.swift --close-in-fullscreen`）。
 *
 * 主窗口在销毁确认后被叫到前台并接过焦点。它全程没被改过几何，所以叫回来的
 * 就是用户最后摆放的那个样子 —— 布局、滚动、选中项都在它自己那个 webview 里，
 * 从未被重建过。
 */
#[tauri::command]
pub fn close_viewer(app: AppHandle, index: usize) {
    // 把「用户最后看的是第几张」送回主窗口，图片墙据此滚到那一张 —— 这是两
    // 个窗口之间唯一反向的状态流动，走的是事件而不是共享变量（两个 webview
    // 之间没有共享内存，也没有共享的 JS 上下文）。
    //
    // 放在最前面：销毁与确认要占一小段线程，图片墙不能陪着一起等 —— 等用户
    // 真的回到那一屏时，它早该滚好了。
    if let Err(e) = app.emit(VIEWER_CLOSED_EVENT, ViewerClosed { index }) {
        eprintln!("[picshow] 推送预览关闭事件失败: {e}");
    }

    // 销毁确认要轮询一小段，不能占住命令线程
    let handle = app.clone();
    std::thread::spawn(move || release_viewer(&handle));
}

/**
 * 让预览窗口**彻底消失**：销毁它，确认从窗口层级里移除，再把主窗口叫回前台。
 *
 * # 为什么不先退出全屏
 *
 * 老做法是「退出全屏 → 等转场播完 → hide()」。转场里窗口会缩回常规尺寸，那一
 * 帧就是盖在图片墙上的空白窗口；而 `hide()` 是异步消息，转场收尾与随后
 * `activateIgnoringOtherApps:` 都可能把它重新拉回屏幕。窗口对象一直活着，就
 * 永远有「残留」的可能。
 *
 * 现在 `destroy()` 直接作用于**仍处在全屏**的窗口：AppKit 收到窗口关闭会自己
 * 收掉那个桌面，窗口从 `NSApp.windows()` 移除，全程没有常规尺寸的可见帧。窗口
 * 实例都不存在了，也就谈不上残留、空白或多余的层级。
 *
 * # 顺序
 *
 * **先**确认 Tauri 的窗口注册表里已经没有这个 label（`Destroyed` 事件处理过），
 * **再** `reveal_main_window()`。后者里的 `set_focus()` 会同步执行
 * `[NSApp activateIgnoringOtherApps:]`，把整个应用的窗口一起提到前台；预览还
 * 在层级里的话会被一起提到最上面。
 *
 * 世代号保留作防御：确认期间用户又发起了新预览，就不该把主窗口再叫回来盖住
 * 它（新预览会由 `ensure_viewer_window` 重建一条窗口）。
 */
pub(crate) fn release_viewer(app: &AppHandle) {
    let epoch = app.state::<AppState>().viewer_epoch();

    let Some(window) = app.get_webview_window(VIEWER_LABEL) else {
        // 已经没了（另一条退出路径先销毁过）：只要把主窗口叫回来
        reveal_main_window(app);
        return;
    };

    // 期间又点了一张图：这一次让位已经过期，谁也别动窗口 —— 旧窗口留给新预览
    // 复用，别销毁它。
    if app.state::<AppState>().viewer_epoch() != epoch {
        if std::env::var("PICSHOW_DEBUG").is_ok() {
            eprintln!("[picshow] 预览让位作废：期间又发起了新的预览");
        }
        return;
    }

    // 旧窗口的 webview 随窗口一起没了，它那个「我能收事件了」必须作废；下次
    // 重建的窗口会重新上报 `viewer_listening()`。
    app.state::<AppState>().set_viewer_listening(false);

    // `destroy()` 不发 `CloseRequested`、强制关闭，所以不会绕回前端那条关闭流程
    // 造成循环；它也不需要等任何平台转场。
    if let Err(e) = window.destroy() {
        eprintln!("[picshow] 销毁预览窗口失败: {e}");
    }

    if !confirm_viewer_destroyed(app) {
        eprintln!(
            "[picshow] 预览窗口销毁确认超时（{}ms）：仍照常叫回主窗口",
            DESTROY_CONFIRM_MS
        );
    }

    // 确认期间又开了一次预览：新窗口已经重建好了，别把主窗口叫到它前面
    if app.state::<AppState>().viewer_epoch() != epoch {
        if std::env::var("PICSHOW_DEBUG").is_ok() {
            eprintln!("[picshow] 预览让位作废（确认期间又发起了新的预览）");
        }
        return;
    }

    reveal_main_window(app);
}

/// 销毁确认的轮询间隔（毫秒）。
const DESTROY_POLL_MS: u64 = 20;
/// 销毁确认的总上限（毫秒）。`Destroyed` 事件只需事件循环转一圈，通常远小于此。
const DESTROY_CONFIRM_MS: u64 = 600;

/**
 * 确认预览窗口已经从 Tauri 的窗口注册表里移除。
 *
 * `destroy()` 强制关闭窗口并最终触发 `WindowEvent::Destroyed`，Tauri 在
 * `manager::on_window_close` 里把这个 label 从注册表删掉。在那之前
 * `get_webview_window(VIEWER_LABEL)` 仍返回 `Some(...)`，而 `set_focus()` 里的
 * `activateIgnoringOtherApps:` 会把还活着的窗口一起提到前台 —— 所以要等这一步
 * 真的发生，再叫回主窗口。
 *
 * 轮询跑在 `release_viewer` 的后台线程上（**不是**命令线程），不会阻塞事件循环
 * 处理 `Destroyed`。超时也照常返回，不能把主窗口永远晾在后头。
 */
fn confirm_viewer_destroyed(app: &AppHandle) -> bool {
    let deadline = Instant::now() + Duration::from_millis(DESTROY_CONFIRM_MS);
    while Instant::now() < deadline {
        if app.get_webview_window(VIEWER_LABEL).is_none() {
            if std::env::var("PICSHOW_DEBUG").is_ok() {
                eprintln!("[picshow] 预览窗口已销毁（从窗口层级移除）");
            }
            return true;
        }
        std::thread::sleep(Duration::from_millis(DESTROY_POLL_MS));
    }
    false
}

/**
 * 退出路径的兜底：进程要结束了，把预览窗口直接销毁，不等确认。
 *
 * 与 `release_viewer` 的区别：这里既不回填索引、也不叫回主窗口、更不等
 * `Destroyed` 事件 —— 进程一结束窗口自然没了。用**销毁**而不是「请求退出全屏」
 * 是关键：只撤全屏态的话，AppKit 仍会播一段缩回常规尺寸的转场，退出那一瞬
 * 可能闪出一帧空白窗口。
 */
pub fn release_viewer_now(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(VIEWER_LABEL) {
        let _ = window.destroy();
    }
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
            // 冷启动则**不能**在这里开预览：那时预览窗口的 webview 还在加载，
            // 事件没人接。那份请求留在 `state` 里，等预览自己装配完来取
            // （见 `viewer_boot`）；主窗口那边的 `boot()` 也会先等一等。
            if state.is_ready() {
                // 应用已经在跑（用户又从 Finder 打开了一张）：直接把预览推到
                // 那一张。主窗口一个字都不碰 —— 它一直就在那儿，尺寸位置从未
                // 被改动过，这才是「退出预览后回到原样」的根本保证。
                open_viewer(app.clone(), payload.index, None, true);
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

/**
 * 「打开方式」会话退出时，把桌面（Space）与焦点交还给触发打开的那个应用。
 *
 * 改动刻意收得很窄：只在 macOS、且这次会话确实是「被外部要求看图」
 * （`was_launched()`）时才动作。常规启动、从图片墙点开的预览走 `close_viewer`
 * → `reveal_main_window()`，根本不会调到这里；单桌面下交还前台等价于把焦点
 * 还给打开它的那个应用，与系统默认一致。
 *
 * 交还是**一次性的**（`macos::restore_launch_source` 里有闸门），所以
 * `exit_app` 与 `RunEvent::ExitRequested` 都调也不会切两次桌面。
 *
 * @returns 是否发出了激活请求 —— 调用方据此给 AppKit 留一小段落地时间再退出
 */
pub fn hand_back_launch_source(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<AppState>();
        // 两个条件缺一不可：既要是「被外部要求看图」的会话，又必须确实是
        // Finder 的「打开方式」事件（命令行 argv、拖放、图片墙点开都不算）。
        if !state.was_launched() || !state.space_restore_armed() {
            return false;
        }
        return crate::macos::restore_launch_source();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/**
 * 交还前台后给 AppKit 的落地时间（毫秒）。
 *
 * `activateWithOptions:` 是一次异步请求：进程立刻退出，可能把它丢在半路。
 * 这段等待只发生在「打开方式」的沉浸式退出上，且不改变用户看到的退出结果
 * —— 进程仍在几百毫秒内结束；常规退出（没有交还动作）一帧都不多等。
 */
const LAUNCH_SOURCE_EXIT_GRACE_MS: u64 = 140;

/// 退出应用。沉浸式预览是「为看这张图而存在」的，Esc 之后就该彻底退回去，
/// 而不是留下一个空的浏览器界面。
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    // 沉浸式预览关掉即退出应用：先把预览窗口**真正销毁**再走。进程一死 AppKit
    // 迟早也会回收那个全屏桌面，但先销毁窗口能让这一瞬不留下常规尺寸的空白
    // 窗口帧（见 `release_viewer_now`）。
    release_viewer_now(&app);

    // 「打开方式」来的那次：把桌面与焦点交还给触发打开的那个应用（访达），
    // 否则 macOS 会把用户丢回第一个 Space。常规启动 / 图片墙路径这里返回
    // false，一行多余动作都不会有。
    if hand_back_launch_source(&app) {
        std::thread::sleep(Duration::from_millis(LAUNCH_SOURCE_EXIT_GRACE_MS));
    }
    app.exit(0);
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
    // 两个窗口都要同步：预览是独立窗口，只喊主窗口那条，预览窗口里的文件
    // 对话框就是另一个颜色。
    for label in [MAIN_LABEL, VIEWER_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(e) = window.set_theme(Some(wanted)) {
                eprintln!("[picshow] 同步原生窗口主题失败: {e}");
            }
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

/**
 * 前端首屏装配完成后调用，把主窗口真正显示出来。
 *
 * 窗口在 `tauri.conf.json` 里配的是 `visible: false`——这是为了避免
 * webview 在 CSS 生效前先闪一帧白底。代价就是**必须**有人负责把它点亮，
 * 否则窗口会一直隐身，用户只能看到一个「启动了但什么都没有」的进程。
 *
 * 用自定义命令而不是内置的 `plugin:window|show`：应用自带的命令不走
 * capabilities 权限校验，少一处配置出错的可能；顺带把焦点也一起设了。
 *
 * 注意这里**只做 show 与 set_focus**，不碰几何、不碰全屏：主窗口的几何终身
 * 只读，是「退出预览后回到原样」的根本保证（见「预览窗口」那节的注释）。
 */
#[tauri::command]
pub fn window_ready(app: AppHandle) {
    let state = app.state::<AppState>();
    state.set_ready();
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!("[picshow] 前端首屏就绪");
    }

    // 「打开方式」那次启动：主界面**绝不能**在这里点亮。
    //
    // 那条路是「开一个独立的预览窗口」，主窗口从头到尾都不该露面 —— 这里
    // 一旦 show 出去，用户看见的就是「主界面一闪而过，然后才变成全屏」，而
    // 这是无论如何都抹不掉的：窗口已经被系统画出来了。
    //
    // 判断用「被要求打开过图片 **且** 那份请求还没被取走」：
    //   * 有待取件 → 预览分支正在路上，这里必须让位；
    //   * 已取走却还走到这一步 → 说明那条路没走通，与其留一个隐身窗口，
    //     不如点亮（lib.rs 里还有一道 3 秒兜底）。
    if state.was_launched() && state.has_pending_launch() {
        if std::env::var("PICSHOW_DEBUG").is_ok() {
            eprintln!("[picshow] 首屏就绪：这次是预览启动，主界面拒绝点亮");
        }
        return;
    }

    reveal_main_window(&app);
    // 主界面点亮之后，主窗口是不是真的拿到了焦点 —— 这条只有真机能回答
    // （沙箱里拿不到激活，连 `toggleFullScreen` 都会被 AppKit 悄悄取消）
    if std::env::var("PICSHOW_DEBUG").is_ok() {
        let info = app
            .get_webview_window(MAIN_LABEL)
            .map(|w| {
                format!(
                    "focused={} visible={}",
                    w.is_focused().unwrap_or(false),
                    w.is_visible().unwrap_or(false)
                )
            })
            .unwrap_or_else(|| String::from("(没有主窗口)"));
        eprintln!("[picshow] 主窗口点亮：{info}");
    }
}

/// 显示并聚焦主窗口；窗口不存在时静默跳过。
pub(crate) fn reveal_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
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
