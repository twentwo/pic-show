//! macOS 原生 wheel 相位 —— 结算时机的**主判据**（默认开启）。
//!
//! ## 为什么需要它
//!
//! 真机探针（`tools/appkit_wheel_phase.swift`，2026-11-09）证实：WKWebView 的
//! `WheelEvent` 没有 `phase` / `momentumPhase`，而 AppKit 的 `NSEvent` 有；
//! 零 ΔX 的 `momentum ended` 边界帧根本不转成 Web wheel，Web 层拿不到明确的
//! 结束点。纯靠「65ms 静默」推断时，两次间隔 50~58ms 的连续快滑会被
//! `settled` 闸门合成一段、少切一张；调阈值只剩 37~58ms 的窄窗口，换机器或
//! 掉帧就翻车。
//!
//! 原型期真机统计：IPC 单程 0~3ms，14 次手势的 `phase began/ended` 与
//! `momentum began/ended` 四件套一个不缺。接入把「松手 → 落位」提前约
//! 24~41ms，并让 50~58ms 连滑各切一张；用户对比两种启动方式时能明确感到
//! 开启相位时快滑更流畅。
//!
//! ## 这一版：从只读原型收敛成产品能力
//!
//!   * **默认开启**：`install()` 不再需要 `PICSHOW_WHEEL_PHASE=1`；只有显式
//!     `PICSHOW_WHEEL_PHASE=0` 才关闭，用来 A/B 对照 65ms 静默兜底，或在
//!     平台异常时作为逃生开关。模块本身仍只在 macOS 编译（`lib.rs` 的
//!     `#[cfg(target_os = "macos")]`）。
//!   * **归一化搬到 Rust**：一次物理手势在这里被压成恰好一次 `begin` +
//!     一次 `end`，只发这两个语义事件。原型期每帧 `emit_to`（真机一轮
//!     324 / 400 帧）、逐帧 payload、IPC 延迟配对统计与 JSONL 落盘全部下线
//!     —— 从「每帧一次 IPC」降到「每手势两次 IPC」，其余只有几次便宜的
//!     ObjC 消息与原子读写。
//!   * **只观察、不吞事件**：本地监视器把 `NSEvent` 原样返回，WKWebView 自己
//!     那套 wheel 翻译一行没动；切图的方向、位移、速度、贴边、落位、边界
//!     回弹仍全部由 Web `wheel` 驱动。
//!   * **不碰窗口**：不改 `set_decorations` / `set_size` / `set_position` /
//!     `set_fullscreen`，也不改任何几何或样式 ——「装饰永不变、几何终身只读」
//!     两条铁律原样保留。
//!   * **不直接切图**：前端只把 begin / end 交给 `viewer.handleWheelPhase()`，
//!     由 gestures 那条唯一的结算路径决定切一张或回弹；这里绝不调用 `go()` /
//!     `settleWheelSwipe()`。
//!
//! **65ms 兜底不能因为默认开启就消失**：显式关闭 / 非 macOS / 权限缺失 /
//! IPC 失败时整条链路零调用，`Gestures` 仍是 `WHEEL_GESTURE_END_MS`（65ms）
//! + `settled` 闸门，行为逐字不变。
//!
//! ## 窗口过滤
//!
//! 本地监视器收到的是**整个应用**的 scrollWheel，图片墙自己也会滚。因此只在
//! 三个条件同时成立时才继续：预览窗口存在、它已上报 `viewer_listening()`、
//! 且事件所属 `NSWindow` 正是当前 keyWindow。真机探针里 `targetIsProbe` 与
//! `isKey` 在 213 个事件上全是 true。事件用 `emit_to(AnyLabel("viewer"))`
//! 定向发送，主窗口收不到。过滤不通过时连相位字段都不读 —— 图片墙滚动的
//! 开销只是两次 ObjC 消息与一次指针比较。
//!
//! ## 归一化规则（与原型期 `wheel-phase.js` 逐字一致）
//!
//! `NSEventPhase` 是位标志：1 began / 2 stationary / 4 changed / 8 ended /
//! 16 cancelled / 32 mayBegin（见 AppKit NSEvent.h），不是 CG 的顺序枚举。
//!
//!   * `phase == began(1)` → 发一次 `begin`，同时把惯性标志清掉；
//!   * `momentum == began(1)` → 置惯性标志（属于同一手势，不发第二次 begin）；
//!   * 有惯性段 → 只认 `momentum ended(8) / cancelled(16)` 发 `end`；
//!   * 无惯性短滑 → 只认 `phase ended(8)` 且惯性标志为假时发 `end`。
//!
//! 抬手的 `phase ended` 与惯性结束的 `momentum ended` 不再各记一次（旧原型
//! 14 次手势记成 28 笔）。惯性标志只由**已通过过滤的帧**推进：图片墙自己的
//! 滚动不参与预览的手势状态机，也不会把残留状态带进下一段预览手势。
//!
//! ## 生命周期
//!
//! 进程级只装一次（`INSTALLED` 闸门）。AppKit 返回的 monitor 对象必须一直活着，
//! 否则 block 会被释放；这里 `mem::forget` 一份强引用，进程退出由系统回收，
//! 不开新的释放路径，也就不会碰窗口销毁那套时序。
//!
//! 验收方式：
//!
//! ```text
//! npm run dev                      # 默认就有原生相位
//! PICSHOW_WHEEL_PHASE=0 npm run dev   # 对照：纯 65ms 静默兜底
//! # devtools 执行 __picshowWheelPhase() 看 begins / ends 是否相等
//! ```
//!

use std::{
    ptr::NonNull,
    sync::atomic::{AtomicBool, Ordering},
};

use block2::RcBlock;
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask};
use serde_json::json;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use crate::{commands::VIEWER_LABEL, state::AppState};

/// 前端监听的事件名。与 `ui/js/wheel-phase.js` 保持一致。
pub const WHEEL_PHASE_EVENT: &str = "picshow://wheel-phase";

static INSTALLED: AtomicBool = AtomicBool::new(false);
/// 归一化用的「当前手势是否处在惯性段」。见模块文档里的归一化规则。
static IN_MOMENTUM: AtomicBool = AtomicBool::new(false);

/// 在 setup 里由 `run_on_main_thread` 投递；AppKit 要求主线程安装监视器。
pub fn install(app: AppHandle) {
    // 默认开启；唯一关闭方式是显式 `=0`，用于 A/B 对照兜底或平台异常时逃生。
    if std::env::var("PICSHOW_WHEEL_PHASE").as_deref() == Ok("0") {
        eprintln!("[picshow] wheel-phase：已由 PICSHOW_WHEEL_PHASE=0 关闭，退回 65ms 静默兜底");
        return;
    }
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }

    if MainThreadMarker::new().is_none() {
        eprintln!("[picshow] wheel-phase：不在主线程，跳过安装");
        return;
    }

    // block 的 ABI 必须是 `NSEvent * (^)(NSEvent *)`：返回值要么原样传回事件，
    // 要么返回 nil（吞事件）。这里永远原样传回，只做旁路观测。
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let ptr = event.as_ptr();
        observe(&app, event);
        ptr
    });

    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &block)
    };
    match monitor {
        Some(monitor) => {
            std::mem::forget(monitor);
            eprintln!("[picshow] wheel-phase：本地监视器已安装（默认开启，每手势只发 begin·end）");
        }
        None => eprintln!("[picshow] wheel-phase：AppKit 拒绝安装监视器"),
    }
}

/// 单个 scrollWheel 的旁路观测。任何失败都只影响这一帧，不改事件流。
fn observe(app: &AppHandle, event: NonNull<NSEvent>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ev: &NSEvent = unsafe { event.as_ref() };

    // 窗口归属：事件窗口必须就是当前 keyWindow。预览全屏时它必是 viewer；
    // 图片墙可见时即使 keyWindow 匹配，viewer_listening 也是 false。
    let key = NSApplication::sharedApplication(mtm).keyWindow();
    let window = ev.window(mtm);
    let key_matches = match (&window, &key) {
        (Some(w), Some(k)) => std::ptr::eq(Retained::as_ptr(w), Retained::as_ptr(k)),
        _ => false,
    };
    if !key_matches {
        return;
    }
    if app.get_webview_window(VIEWER_LABEL).is_none() {
        return;
    }
    if !app.state::<AppState>().is_viewer_listening() {
        return;
    }

    // 到这一步才读相位：绝大多数帧（图片墙滚动 / 预览未就绪）在上面就返回了。
    let phase = ev.phase().0;
    let momentum = ev.momentumPhase().0;

    let mut in_momentum = IN_MOMENTUM.load(Ordering::Relaxed);
    // 一次手势最多两个事件；同帧若同时成立也按 begin → end 的顺序发，绝不
    // 把两类 ended 各记一次。
    let mut kinds: [Option<&str>; 2] = [None, None];
    if phase == 1 {
        in_momentum = false;
        kinds[0] = Some("begin");
    }
    if momentum == 1 {
        in_momentum = true;
    }
    let momentum_ended = momentum == 8 || momentum == 16;
    let ended = momentum_ended || (phase == 8 && !in_momentum);
    if momentum_ended {
        in_momentum = false;
    }
    IN_MOMENTUM.store(in_momentum, Ordering::Relaxed);
    if ended {
        kinds[1] = Some("end");
    }

    for kind in kinds.iter().flatten() {
        if let Err(e) = app.emit_to(
            EventTarget::AnyLabel {
                label: VIEWER_LABEL.to_string(),
            },
            WHEEL_PHASE_EVENT,
            json!({ "kind": *kind }),
        ) {
            eprintln!("[picshow] wheel-phase：发送失败 ({kind}): {e}");
        }
    }
}
