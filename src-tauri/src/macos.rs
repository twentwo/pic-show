//! macOS 专有：让窗口的内容区一路顶到窗口上边缘。
//!
//! ## 为什么必须有这一个文件
//!
//! 预览要的是「整块屏幕都是画面」。原生标题栏碍事，因为它由**系统**绘制：
//! 配色和毛玻璃跟随系统外观，跟我们纯色的预览面对不上（深浅色切换时尤其明
//! 显）；而且它不在前端的控件层里 —— 空闲隐藏时按钮和胶片条都消失了，那条
//! 系统栏还杵在那儿。
//!
//! 于是直觉是进预览时 `set_decorations(false)`、退出时再 `set_decorations(true)`
//! 补回来。这条路**走不通**，原因在 tao 那一侧（版本号见 `Cargo.lock`）：
//!
//!   1. `util/async.rs` 的 `toggle_full_screen_async` 在进入全屏时，若发现窗口
//!      已是**无边框**，会临时把标题栏加回来，并把无边框这份 styleMask 记进
//!      `shared_state.saved_style` —— 也就是把「无边框」定成了退出全屏时的还原
//!      目标；
//!   2. 退出全屏时 AppKit 回调 `windowDidExitFullScreen:` → tao 的
//!      `restore_state_from_fullscreen()` **无条件**把那份 styleMask 写回去，并顺
//!      手 `set_maximized(进入时记下的值)`；
//!   3. 而那份 `maximized` 记的是 `is_zoomed()`，它对无边框窗口退化成「窗口框
//!      架是否等于屏幕可视区」的启发式判断 —— 我们刚摘掉标题栏，正好命中，记账
//!      于是失真。
//!
//! 合起来的语义是「进全屏时什么样，出全屏就什么样」，跟我们要的「进全屏前摘
//! 掉、出全屏后补回来」正好相反。我们补的那一笔和回调那一笔都排在
//! `DispatchQueue.main` 的 FIFO 里，谁在后谁生效 —— 纯竞态，靠「等 N 毫秒再
//! 写」去卡顺序是卡不住的。
//!
//! ## 这里的做法
//!
//! 不去碰「有没有标题栏」，而是把**每条窗口在诞生时一次性**设成：保留
//! `Titled`（红黄绿三个交通灯还在）+ `FullSizeContentView`（内容区延伸到标题
//! 栏底下）+ 标题栏透明 + 隐藏标题文字。设完之后就再也不动它。这里遍历
//! `NSApp.windows()` 并跳过已经设过的窗口（图片墙与预览是分开的物理窗口，见
//! 第七节；预览退出即销毁，重建时会再跑一次）：
//!
//!   * 图片墙 —— 看不到那条系统栏，只剩我们自己的 `.topbar`；
//!   * 预览 —— 看不到它，页面里 `.viewer-bar` 就是唯一的标题栏；
//!   * 进出预览 —— 只剩 `set_fullscreen` 一个动作，而且它只发生在**预览**那条
//!     窗口上。图片墙那条窗口的几何与最大化由 AppKit 精确还原 —— 更准确地说，
//!     它从来没被写过，所以没什么需要还原。
//!
//! 依赖 `objc2` / `objc2-app-kit`：它们本来就是 tao（Tauri 的窗口层）的依赖，
//! 版本完全一致，不会带来额外编译量，也不牵扯任何私有 API。
//!
//! ## 与 `set_decorations` 的关系
//!
//! 本文件存在的意义就是让项目里**再也不出现 `set_decorations`**。
//! `tools/check_window_split.mjs` 会把这条钉住：一旦有人重新引入运行时切换装饰
//! 或摆尺寸，检查直接失败。

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    NSWindowStyleMask, NSWindowTitleVisibility,
};

/**
 * 把窗口设成「内容铺满、标题栏透明」。
 *
 * **每条窗口一生只设定一次**：启动时对当时存在的窗口（图片墙 + 首条预览）设一
 * 次；预览窗口退出即销毁，下次重建时再跑一次，但已经设过的窗口会被跳过 —— 所
 * 以只有那条新窗口被设到。绝不改动任何**已存在**窗口的样式，这是整套方案成立
 * 的前提：不改「有没有标题栏」这一位，tao 的 `saved_style` 就永远不会被写入，
 * 也就没有那条会在退出时覆盖我们的回调。
 *
 * 判据用 `styleMask` 里有没有 `FullSizeContentView`：它是我们加的那一位，命中
 * 就说明这条窗口已经设过了。按位或而不是整体赋值，免得抹掉 AppKit 的其它默认
 * 位（尤其 `Titled` —— 红黄绿三个交通灯靠它）。
 *
 * AppKit 要求在主线程上调用。拿不到 `MainThreadMarker` 时**静默返回**：退化结果
 * 只是「顶部多一条系统标题栏」，预览和浏览都还能用，不会连带把形态弄坏。
 */
pub(crate) fn apply_immersive_frame() {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[picshow] 不在主线程，跳过窗口样式设定");
        return;
    };

    for window in NSApplication::sharedApplication(mtm).windows().iter() {
        // 已经设过的（主窗口、或上一次跑时设过的预览窗口）一律跳过
        if window
            .styleMask()
            .contains(NSWindowStyleMask::FullSizeContentView)
        {
            continue;
        }
        let merged = window.styleMask() | NSWindowStyleMask::FullSizeContentView;
        window.setStyleMask(merged);
        window.setTitlebarAppearsTransparent(true);
        window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    }

    if std::env::var("PICSHOW_DEBUG").is_ok() {
        eprintln!("[picshow] macOS：已设定透明标题栏 + 内容铺满窗口");
    }
}

// 曾经这里有一份 `native_fullscreen()`：轮询 AppKit `styleMask` 的 `.fullScreen`
// 位，用来判断「退出全屏的转场播完没有」。改成「退出即销毁预览窗口」之后不再
// 需要等转场 —— AppKit 关闭全屏窗口时自己会走完 `windowDidExitFullScreen:` 并
// 回收那个桌面 —— 那段逻辑连同尺寸兜底一起删掉了。
//
// 实测数据留在 `tools/appkit_fullscreen_exit.swift`：`frame` 落到终值比
// `didExit` 早约 530ms，正是旧方案里那一帧「空白窗口」的来源；而
// `--close-in-fullscreen` 全程没有出现常规尺寸的可见帧。

/* -------------------------------------------------------------------------- *
 * 打开方式：退出预览后把桌面（Space）与焦点交还给触发打开的那个应用
 * -------------------------------------------------------------------------- *
 *
 * ## 缺陷
 *
 * 用户在**非第一个 Space** 的访达里右键 →「打开方式」→ PicShow。PicShow 被
 * LaunchServices 唤起、建一条全屏预览窗口（全屏窗口独占一个新 Space）。用户
 * 关掉预览（`exit_app`，进程随之退出）之后，macOS 把用户送回了**第一个
 * Space**，而不是触发打开操作时访达所在的那个：访达窗口与焦点都留在原处，
 * 用户被丢到一个空桌面。
 *
 * 根因不在「退出全屏转场」，而在**激活**：应用被唤起时系统会切到「包含该应用
 * 窗口的桌面」，而冷启动那条隐藏的 `main` 窗口被算在了第一个 Space；全屏窗口
 * 销毁后 AppKit 回到「进入全屏前所在的 Space」，也就跟着回到了那一个。我们
 * 拦不住系统那一次切换 —— macOS 没有公开 API 能指定「回到第 N 个桌面」。
 *
 * ## 做法：交还前台，让系统自己切回去
 *
 * 公开、可靠的「回到某个 Space」只有一条路：**激活那个 Space 上的应用**
 * （`NSRunningApplication.activateWithOptions:`）。WindowServer 会把它窗口所在
 * 的桌面切到前台，并把 key window / 焦点一并交还 —— 这正好同时满足「回到触发
 * 打开操作时访达所在的 Space」与「保持访达窗口及焦点状态」。
 *
 * 于是只需在**打开发生的最早一刻**记下前台应用是谁，退出时激活它。
 *
 * `tools/appkit_space_restore.swift` 把两件事测成了事实：
 *   * 进程第一行（`NSApplication` 尚未初始化、还没被激活）读到的
 *     `frontmostApplication` **是触发打开的那个应用**，不是自己；等
 *     `NSApplication` 初始化并激活之后就未必了 —— 所以捕获必须放在 `run()`
 *     第一行；
 *   * 记下的 pid 与 bundleIdentifier 能把那个应用找回来（`byPid` 命中）。
 *   这台无 GUI 激活的会话里 `activate()` 返回 false，所以「激活能否切 Space」
 *   这一环只能真机验收，探针不假报成功。
 *
 * ## 边界（改动刻意收得很窄）
 *
 *   * 只有「被外部要求看图」的会话（`AppState::was_launched()`）才恢复；
 *     常规启动、从图片墙点开的预览走 `close_viewer` → `reveal_main_window()`，
 *     一行都不碰；
 *   * 恢复是一次性的（`take()`），同一进程里重复退出不会重复激活；
 *   * 单桌面下「激活来源应用」等价于把焦点还给打开它的那个应用，与系统默认
 *     一致，不改变用户看到的结果；
 *   * 找不到来源应用（已退出、pid 被复用）时回退到访达：访达常驻，且正是
 *     「打开方式」最常见的来源。连访达都找不到就什么也不做，绝不乱激活。
 * -------------------------------------------------------------------------- */

/// 触发「打开方式」的那个应用。只在沉浸式会话退出时取用一次。
static LAUNCH_SOURCE: Mutex<Option<LaunchSource>> = Mutex::new(None);
/// 本次会话是否已经交还过前台。
///
/// `exit_app` 与 `RunEvent::ExitRequested` 可能落在同一次退出上（取决于
/// `app.exit(0)` 会不会再走一遍事件回调）。没有这道闸门，第二次调用会在
/// `LAUNCH_SOURCE` 已被 `take()` 清空后走「回退访达」，把刚交还出去的桌面又
/// 切一次。`capture_launch_source()` 在新一次打开到来时把它复位。
static SOURCE_HANDED_BACK: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct LaunchSource {
    /// `libc::pid_t`（macOS 上即 i32）。
    pid: i32,
    /// 双标识：pid 可能被复用，激活前必须再对一次 bundleIdentifier。
    bundle_id: Option<String>,
}

fn debug_enabled() -> bool {
    std::env::var("PICSHOW_DEBUG").is_ok()
}

/// 在**尽可能早**的时刻记下前台应用。
///
/// 由 `lib.rs::run()` 的第一行（`NSApplication` 还没初始化）与
/// `RunEvent::Opened` 的开头各调一次。读到的是自己时**保留已有记录**：那说明
/// 应用已经被激活了，这次读不到触发者，但更早那次（冷启动第一行）读到了。
pub(crate) fn capture_launch_source() {
    // 新的一次「打开方式」开始了：允许这次会话结束时再交还一次前台
    SOURCE_HANDED_BACK.store(false, Ordering::Relaxed);
    let ws = NSWorkspace::sharedWorkspace();
    let Some(front) = ws.frontmostApplication() else { return };
    let pid = front.processIdentifier();
    if pid == std::process::id() as i32 {
        return;
    }
    let bundle_id = front.bundleIdentifier().map(|s| s.to_string());
    if debug_enabled() {
        eprintln!(
            "[picshow] 记录打开来源：pid={pid} bundle={}",
            bundle_id.as_deref().unwrap_or("(无)")
        );
    }
    if let Ok(mut slot) = LAUNCH_SOURCE.lock() {
        *slot = Some(LaunchSource { pid, bundle_id });
    }
}

/// 把前台 / 桌面 / 焦点交还给触发打开的那个应用。
///
/// @returns 是否真的发出了激活请求（调用方据此决定要不要给一小段落地时间）
pub(crate) fn restore_launch_source() -> bool {
    // 一次会话只交还一次（见 SOURCE_HANDED_BACK 的注释）
    if SOURCE_HANDED_BACK.swap(true, Ordering::Relaxed) {
        return false;
    }
    let source = LAUNCH_SOURCE.lock().ok().and_then(|mut slot| slot.take());
    let target = source
        .as_ref()
        .and_then(find_by_identity)
        .or_else(find_finder);

    let Some(app) = target else {
        if debug_enabled() {
            eprintln!("[picshow] 找不到打开来源应用，跳过桌面/焦点交还");
        }
        return false;
    };
    let ok = app.activateWithOptions(NSApplicationActivationOptions::empty());
    if debug_enabled() {
        eprintln!(
            "[picshow] 交还前台给 {}（pid={}）：activate={ok}",
            app.bundleIdentifier()
                .map(|s| s.to_string())
                .unwrap_or_default(),
            app.processIdentifier()
        );
    }
    ok
}

/// 按 pid 找回，并核对 bundleIdentifier —— pid 复用时旧 pid 可能指向别的应用。
fn find_by_identity(source: &LaunchSource) -> Option<Retained<NSRunningApplication>> {
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(source.pid)?;
    if same_identity(&app, source) {
        Some(app)
    } else {
        None
    }
}

fn same_identity(app: &NSRunningApplication, source: &LaunchSource) -> bool {
    if app.processIdentifier() != source.pid {
        return false;
    }
    let now = app.bundleIdentifier().map(|s| s.to_string());
    match (&source.bundle_id, now) {
        // 当初没读到 bundleIdentifier（无 Info.plist 的进程）：只认 pid
        (None, _) => true,
        (Some(want), Some(got)) => want == &got,
        // 当初有、现在读不到：宁可不用，免得激活到一个已经不是它的进程
        (Some(_), None) => false,
    }
}

/// 兜底：来源应用已经不在了，就交还给访达（「打开方式」最常见的来源）。
fn find_finder() -> Option<Retained<NSRunningApplication>> {
    let apps = NSWorkspace::sharedWorkspace().runningApplications();
    apps.to_vec().into_iter().find(|app| {
        app.bundleIdentifier().map(|s| s.to_string()).as_deref()
            == Some("com.apple.finder")
    })
}
