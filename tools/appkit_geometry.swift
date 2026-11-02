//
//  AppKit 窗口几何探针 —— 「退出预览后窗口回不到原尺寸」的系统级证据。
//
//  这个文件不参与构建，也不被 Tauri / tauri 引用。它存在的唯一理由是：**把
//  PicShow 依赖的那条 AppKit 行为钉成可复跑的事实**。
//
//  它回答三个问题：
//
//    1. 退出原生全屏后，AppKit 自己能不能精确还原窗口几何？
//    2. 窗口层（tao 0.37.2）在 `windowDidExitFullScreen:` 里补的那笔
//       `set_maximized`，会不会把还原结果改掉？
//    3. 在进全屏前把窗口摆到整块屏，会不会让退出后停在最大化？
//
//  三个答案依次是：能；通常不会（取决于 zoomed 判定）；**会**。
//
//  跑法（需要 macOS + Xcode Command Line Tools）：
//
//      swiftc -O -o /tmp/psprobe tools/appkit_geometry.swift
//      /tmp/psprobe                       # 窗口态 → 全屏 → 退出
//      /tmp/psprobe --tao                 # 同上，并复刻 tao 的退出补偿
//      /tmp/psprobe --presize             # 进全屏前先摆到整块屏
//      /tmp/psprobe --presize --tao
//      /tmp/psprobe --hidden              # 全程不 show，切完全屏再说
//
//  每次约 10 秒，会真的弹一个窗口并切一次全屏。输出里逐行打印 frame 与
//  `isZoomed`，最后一行给出结论。
//
//  注意：`--tao` 复刻的是 tao 0.37.2 的
//  `platform_impl/macos/window.rs::restore_state_from_fullscreen()`：
//
//      shared_state.fullscreen = None;
//      let maximized = shared_state.maximized;      // 记账，我们从不写 → 恒 false
//      let mask = saved_style.unwrap_or(styleMask);
//      set_style_mask_async(mask);
//      set_maximized(maximized);                    // ← 无条件
//
//  而 `set_maximized` 的第一步是同步读 `is_zoomed()`，不等它就早退。
//

import AppKit

func rectStr(_ r: NSRect) -> String {
    String(format: "%.0f×%.0f @ (%.0f, %.0f)", r.size.width, r.size.height, r.origin.x, r.origin.y)
}

/// 是否复刻 tao 的 `restore_state_from_fullscreen()`（含那笔无条件的 setMaximized）
let simulateTao = CommandLine.arguments.contains("--tao")
/// 进全屏前是否先把窗口摆到整块屏（复刻被删掉的 `prepare_launch_window` 那一步）
let preSize = CommandLine.arguments.contains("--presize")
/// 是否全程不 show：直接切全屏，让 AppKit 自己去点亮（当前采用的方案）
let startHidden = CommandLine.arguments.contains("--hidden")

final class Probe: NSObject, NSWindowDelegate {
    var win: NSWindow!
    func log(_ tag: String) {
        print(String(format: "[%-14@] visible=%@ zoomed=%@ frame=%@",
                     tag as NSString,
                     win.isVisible ? "Y" : "n",
                     win.isZoomed ? "YES" : "no ",
                     rectStr(win.frame)))
        fflush(stdout)
    }

    func windowWillEnterFullScreen(_ n: Notification) { log("willEnter") }
    func windowDidEnterFullScreen(_ n: Notification) { log("didEnter") }
    func windowWillExitFullScreen(_ n: Notification) { log("willExit") }

    func windowDidExitFullScreen(_ n: Notification) {
        log("didExit")
        guard simulateTao else { return }

        // 复刻 tao：它记的 maximizd 我们从不写，恒为 false
        let maximized = false
        let mask = win.styleMask
        DispatchQueue.main.async { self.win.styleMask = mask }

        let zoomed = win.isZoomed          // set_maximized 的第一步：同步求值
        if zoomed != maximized {
            print("[didExit] tao 复刻：isZoomed(\(zoomed)) ≠ maximized(\(maximized)) → zoom(nil)")
            DispatchQueue.main.async { self.win.zoom(nil) }
        } else {
            print("[didExit] tao 复刻：isZoomed(\(zoomed)) == maximized(\(maximized)) → 直接返回")
        }
        fflush(stdout)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

// 与 tauri.conf.json 一致：1200×800，居中
let screen = NSScreen.main!.visibleFrame
let w: CGFloat = 1200, h: CGFloat = 800
let origin = NSPoint(x: screen.midX - w / 2, y: screen.midY - h / 2)

let win = NSWindow(
    contentRect: NSRect(origin: origin, size: NSSize(width: w, height: h)),
    styleMask: [.titled, .closable, .miniaturizable, .resizable],
    backing: .buffered,
    defer: false
)
win.collectionBehavior = [.fullScreenPrimary]
// PicShow 在启动时一次性设好的那三件事（见 src-tauri/src/macos.rs）
win.styleMask.insert(.fullSizeContentView)
win.titlebarAppearsTransparent = true
win.titleVisibility = .hidden
win.title = "PicShow"

let probe = Probe()
probe.win = win
win.delegate = probe

if !startHidden { win.makeKeyAndOrderFront(nil) }
app.activate(ignoringOtherApps: true)

print("=== AppKit 窗口几何探针 ===")
print("tao 补偿=\(simulateTao ? "开" : "关")  presize=\(preSize ? "开" : "关")  隐藏启动=\(startHidden ? "开" : "关")")
print("浏览态目标：\(rectStr(win.frame))   屏幕可视区：\(rectStr(screen))")
fflush(stdout)

var delay = 0.8
func step(_ t: Double, _ body: @escaping () -> Void) {
    delay += t
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { body() }
}

let enter = {
    if preSize {
        let fs = NSScreen.main!.frame
        win.setFrame(NSRect(x: 0, y: 0, width: fs.width, height: fs.height), display: false)
        probe.log("set_size 整屏")
    }
    win.toggleFullScreen(nil)
}
let reveal = {
    if startHidden {
        print("→ 切完全屏才 makeKeyAndOrderFront"); fflush(stdout)
        win.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
    }
}

step(0) { probe.log(startHidden ? "隐藏态" : "浏览态") }
step(0.5, enter)
step(2.5) { probe.log("全屏稳定") }
step(0.3, reveal)
step(0.8) { probe.log(startHidden ? "show 之后" : "全屏中") }
step(0.6) { win.toggleFullScreen(nil) }
step(2.2) {
    probe.log("退出后")
    let got = win.frame
    let same = abs(got.size.width - w) < 2 && abs(got.size.height - h) < 2
    print(same
        ? "✓ 退出后回到原始尺寸 1200×800"
        : "✗ 没回到原始尺寸：\(rectStr(got))（进入前被写成了别的大小）")
    app.terminate(nil)
}

app.run()
