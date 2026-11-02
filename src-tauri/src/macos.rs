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

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindowStyleMask, NSWindowTitleVisibility};

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
