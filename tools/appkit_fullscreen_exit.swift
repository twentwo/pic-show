//
//  AppKit 「退出全屏 → 隐藏 / 直接销毁」时序探针。
//
//  这个文件不参与构建。它回答 PicShow 那个反复出现的缺陷的系统级问题：
//
//    **退出全屏预览时，窗口会不会退化成一块盖在图片墙上的空白窗口？**
//
//  背景：预览曾经是**常驻窗口**，关闭时只 `hide()`。原生全屏窗口独占一个桌面
//  （Space），`orderOut:` 不释放它；想让 AppKit 收掉桌面就得先播一段退出全屏
//  转场，而转场里窗口会从整屏缩回 1200×800 —— 那一帧正是用户看到的空白窗口。
//
//  它测三件事：
//
//    1. `windowDidExitFullScreen:` 与「frame 落到终值」哪个先到、差多少毫秒；
//    2. 在「frame 已到终值」这一刻 orderOut:，窗口后来会不会自己又冒出来；
//    3. 在**全屏中**直接 `close()`（等价 Tauri `destroy()`），会不会出现常规
//       尺寸的空白帧、AppKit 会不会自己回收桌面。
//
//  跑法（需要 macOS + Xcode Command Line Tools），每次约 9 秒，会真的弹窗
//  并切一次全屏：
//
//      swiftc -O -o /tmp/psfs tools/appkit_fullscreen_exit.swift
//      /tmp/psfs --at-frame              # 复刻旧代码：frame 一到终值就 orderOut
//      /tmp/psfs --at-didexit           # 对照：等 windowDidExitFullScreen 再 orderOut
//      /tmp/psfs --at-frame --late      # 旧代码 + 再等 400ms 才 orderOut
//      /tmp/psfs --close-in-fullscreen  # 现在：全屏中直接销毁整条窗口
//
//  最后几行给出结论。
//
//  ## 实测结果（macOS，2026-11-02）
//
//      [  4.079] toggleFullScreen → 退出
//      [  4.113] frame 落到终值 1200×801        ← 旧代码的判据在这一刻成立
//      [  4.119] orderOut（frame 一到终值就藏）
//      [  4.664] didExit                        ← 转场真正播完，晚 552ms
//      [  7.4~ ] 观察 visible=Y … 一直 Y        ← 窗口被转场收尾拉回来了
//
//  三个「隐藏」模式各跑一遍，结论是钉死的：
//
//      --at-frame          ✗ 窗口仍然可见（正是那个缺陷）
//      --at-frame --late   ✗ 仍然可见（+400ms 补不上那个 530ms 的差）
//      --at-didexit        ✓ 窗口彻底从窗口层级移除
//
//  **frame 落到终值比 `windowDidExitFullScreen:` 早约 530ms。** 差不是固定值
//  （随机器与动画时长变），**靠「多等一会儿」补不上**，只能等 AppKit 自己那个
//  信号。那一帧「整屏缩回 1200×800」就是空白窗口的来源。
//
//  直接销毁那一路（`--close-in-fullscreen`）：
//
//      [  4.05 ] win.close()（全屏中直接销毁，不 toggle）
//      [  4.13 ] didExit                       ← AppKit 自己走完，回收桌面
//      windows: 1 → 0；windowWillClose 收到
//      全程没有「常规尺寸 + 可见」的一帧
//
//  这正是生产代码现在走的路：`release_viewer()` 直接 `destroy()` 预览窗口，
//  不播退出全屏转场，窗口实例被移除，中间没有常规尺寸的空白窗口帧。
//
//  注意：拿不到激活的会话（ssh / 沙箱 / 无 GUI 登录）里 AppKit 会静默取消
//  `toggleFullScreen` —— `willEnter` 照发但 `didEnter` 永不到，窗口从头到尾没
//  全屏过。探针会检测到这一点并打出「本次没跑成」，不会给出假的结论。
//

import AppKit

func rectStr(_ r: NSRect) -> String {
    String(format: "%.0f×%.0f", r.size.width, r.size.height)
}

let atFrame = CommandLine.arguments.contains("--at-frame")
let atDidExit = CommandLine.arguments.contains("--at-didexit")
let extraLate = CommandLine.arguments.contains("--late")
/// 全屏中直接 `close()`（等价于 Tauri 的 `destroy()`，不播退出全屏转场）
let closeInFullscreen = CommandLine.arguments.contains("--close-in-fullscreen")
let mode = closeInFullscreen
    ? "全屏中直接 close"
    : (atDidExit ? "等 didExit" : (extraLate ? "frame 终值 + 400ms" : "frame 终值"))

let start = Date()
func now() -> Double { Date().timeIntervalSince(start) }
func stamp(_ tag: String, _ extra: String = "") {
    print(String(format: "[%7.3f] %@ %@", now(), tag, extra))
    fflush(stdout)
}

final class Probe: NSObject, NSWindowDelegate {
    var win: NSWindow!
    var normal = NSZeroRect
    /// 「frame 首次落到终值」的时刻（现状的判据）
    var frameSettledAt: Double?
    var didExitAt: Double?
    /// 全屏**真的**进去过没有（拿不到激活时 AppKit 会静默取消，见文末）
    var enteredFullscreen = false
    var pollTimer: Timer?
    var phase = ""
    /// 全屏中 close() 之后有没有见过「常规尺寸 + 可见」的一帧（空白窗口）
    var sawNormalVisible = false
    var willCloseAt: Double?
    var windowsAfterClose: Int?

    func settleCheck() {
        guard frameSettledAt == nil, phase == "exiting" else { return }
        let f = win.frame
        if abs(f.size.width - normal.size.width) < 4 && abs(f.size.height - normal.size.height) < 4 {
            frameSettledAt = now()
            stamp("frame 落到终值", "\(rectStr(f))")
        }
    }

    func windowWillEnterFullScreen(_ n: Notification) { stamp("willEnter") }
    func windowDidEnterFullScreen(_ n: Notification) {
        enteredFullscreen = true
        stamp("didEnter", "frame=\(rectStr(win.frame))")
    }
    func windowWillExitFullScreen(_ n: Notification) { stamp("willExit") }

    func windowDidExitFullScreen(_ n: Notification) {
        didExitAt = now()
        stamp("didExit", "frame=\(rectStr(win.frame))")
        if atDidExit {
            win.orderOut(nil)
            stamp("orderOut", "（等 didExit 之后）")
        }
    }

    func windowWillClose(_ n: Notification) {
        willCloseAt = now()
        stamp("windowWillClose", "windows=\(NSApp.windows.count)")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

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
win.styleMask.insert(.fullSizeContentView)
win.titlebarAppearsTransparent = true
win.titleVisibility = .hidden
win.title = "PicShow"

let probe = Probe()
probe.win = win
probe.normal = win.frame
win.delegate = probe
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

print("=== 退出全屏 → 隐藏 时序探针（模式：\(mode)）===")
print("常规尺寸 \(rectStr(probe.normal))")
fflush(stdout)

var delay = 0.8
func step(_ t: Double, _ body: @escaping () -> Void) {
    delay += t
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { body() }
}

step(0) { stamp("浏览态") }
step(0.5) { win.toggleFullScreen(nil); stamp("toggleFullScreen → 进入") }

// 进入稳定后：要么「直接销毁」、要么「先退出全屏再隐藏」两条路各测一遍
step(2.5) {
    stamp("全屏稳定", "frame=\(rectStr(win.frame))")
    if closeInFullscreen {
        // 不复刻退出转场：全屏窗口整个没了，AppKit 自己决定怎么把桌面收掉
        probe.phase = "watching"
        stamp("win.close()", "（全屏中直接销毁，不 toggle）")
        win.close()
        probe.windowsAfterClose = NSApp.windows.count
        return
    }
    probe.phase = "exiting"
    probe.pollTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
        probe.settleCheck()
        if atFrame && probe.frameSettledAt != nil && probe.pollTimer != nil {
            let wait = extraLate ? 0.4 : 0.0
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                win.orderOut(nil)
                stamp("orderOut", extraLate ? "（frame 终值 + 400ms）" : "（frame 一到终值就藏）")
            }
            probe.pollTimer?.invalidate()
            probe.pollTimer = nil
        }
    }
    win.toggleFullScreen(nil)
    stamp("toggleFullScreen → 退出")
}

// 收尾：把窗口的可见性盯 2 秒，看它会不会自己冒回来 / 有没有闪过常规尺寸
step(3.0) {
    var ticks = 0
    Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
        ticks += 1
        let normalSize = abs(win.frame.size.width - probe.normal.size.width) < 4
            && abs(win.frame.size.height - probe.normal.size.height) < 4
        if win.isVisible && normalSize && !win.styleMask.contains(.fullScreen) {
            probe.sawNormalVisible = true
        }
        stamp("观察",
              "visible=\(win.isVisible ? "Y" : "n") frame=\(rectStr(win.frame)) windows=\(NSApp.windows.count)")
        if ticks >= 20 {
            timer.invalidate()
            let visible = win.isVisible
            print("")
            print("---- 结论 ----")
            print("模式：\(mode)")
            if let a = probe.frameSettledAt { print(String(format: "frame 落到终值：%.3f", a)) } else { print("frame 落到终值：没量到") }
            if let b = probe.didExitAt { print(String(format: "didExit 回调：%.3f", b)) } else { print("didExit 回调：没收到") }
            if let a = probe.frameSettledAt, let b = probe.didExitAt {
                print(String(format: "两者相差：%+.0f ms（正 = didExit 更晚）", (b - a) * 1000))
            }
            // 拿不到激活的会话里（ssh / 沙箱 / 无 GUI 登录会话）AppKit 会把
            // toggleFullScreen 静默取消：willEnter 照发，didEnter 永远不来，
            // 窗口从头到尾就没全屏过。这时下面那句「✓」是假的 —— 必须先把这
            // 件事说清楚，否则它就是一份误导人的证据。
            guard probe.enteredFullscreen else {
                print("⚠️ 本次没跑成：AppKit 把进入全屏取消了（进程没拿到激活）")
                print("   换一个能弹窗的终端（本机登录会话，不要 ssh / 沙箱）重跑。")
                app.terminate(nil)
                return
            }
            if closeInFullscreen {
                print("close 时窗口总数：\(probe.windowsAfterClose.map(String.init) ?? "没量到")；2 秒后：\(NSApp.windows.count)")
                print("是否收到 windowWillClose：\(probe.willCloseAt != nil ? "是" : "否")")
                print("是否收到 didExit：\(probe.didExitAt != nil ? "是" : "否")")
                print("全程有没有「常规尺寸 + 可见」的一帧：\(probe.sawNormalVisible ? "有" : "没有")")
                let gone = !visible && NSApp.windows.count == 0
                print(gone
                    ? "✓ 窗口已从层级移除，全程没有出现常规尺寸的空白窗口"
                    : "✗ 窗口仍留在窗口层级里")
                print(probe.sawNormalVisible
                    ? "✗ 出现过常规尺寸窗口 —— 那就是盖在图片墙上的那块空白"
                    : "✓ 没有空白窗口帧")
            } else {
                print(visible
                    ? "✗ orderOut 之后窗口仍然可见 —— 正是「空白窗口盖在图片墙上」"
                    : "✓ orderOut 生效，窗口已彻底从窗口层级移除")
            }
            app.terminate(nil)
        }
    }
}

app.run()
