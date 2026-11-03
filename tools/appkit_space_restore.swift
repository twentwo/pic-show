//
//  macOS「打开方式 → 退出后回到原来的 Space」平台行为探针
//  ============================================================
//
//  这个文件不参与构建。它只回答一件事，而且是先用**事实**回答、再让产品代码
//  照着做：
//
//    PicShow 从 Finder 的「打开方式」启动时，谁把用户从「Finder 所在的那个
//    Space」带走了？退出预览时又该把什么交还回去，才能连 Space 带焦点一起
//    回到触发打开操作的那一个？
//
//  ## 为什么需要探针，而不是推理
//
//  macOS 没有公开 API 能「读取当前 Space 的编号」或「切到第 N 个桌面」——
//  `NSWorkspace` 不暴露 Space，`CGS*` 那套是私有 API（本探针为了量事实会用
//  一下，产品代码一行都不用）。能公开、可靠地「回到某个 Space」的办法只有一
//  条：**激活那个 Space 上的应用**（`NSRunningApplication.activate`），由
//  WindowServer 自己把用户带过去。
//
//  所以修复方案是：在打开发生的**最早一刻**记下前台应用（那就是 Finder），
//  退出预览时把它重新激活。这依赖两个必须先量到的事实：
//
//    1. 进程刚起来的那一行（NSApplication 还没初始化、还没被激活）读到的
//       `frontmostApplication` **仍是触发打开的那个应用**，不是 PicShow 自己；
//    2. 记下的 pid / bundleIdentifier 能把那个应用找回来并成功激活。
//
//  本探针按时间顺序打印这两件事，顺带量一下当前 Space 的编号（私有 API，
//  仅用于观察「激活前后有没有换桌面」）。
//
//  ## 跑法（需要 macOS 图形登录会话）
//
//      swiftc -O -o /tmp/psspace tools/appkit_space_restore.swift
//      /tmp/psspace                     # 只观察，不打扰前台，约 1 秒
//      /tmp/psspace --activate-finder   # 真的激活一次 Finder，量 Space 前后变化
//
//  `--activate-finder` 会把 Finder 提到前台（无破坏性）；换回其它应用即可。
//  想量「非首个 Space」的场景，先手动切到 2 号桌面、把 Finder 窗口留在那儿，
//  再跑这个模式，看最后一行的 Space 编号有没有回到你原来那个。
//
//  ## 实测（2026-11-03，本机图形会话）
//
//      ① 最早：frontmost = Finder（不是自己）；NSApplication 初始化并激活
//        自己之后，frontmost 变成探针本身 —— 所以「捕获」必须发生在第一行，
//        晚一步就只能记到自己。
//      ② pid 能找回同一个 NSRunningApplication；bundleIdentifier 双标识可用。
//      ③ Finder 始终在 runningApplications 里，可作回退。
//      ④ activate(options: []) 返回 true；会话里能观察到 frontmost 变化。
//
//  拿不到激活的会话（ssh / 沙箱 / 无 GUI 登录）里 ④ 会失败、Space 编号可能
//  为 n/a，探针会如实打印，不给出假结论。
//

import AppKit
import Foundation
import Darwin
import CoreGraphics

let t0 = CFAbsoluteTimeGetCurrent()
func stamp(_ s: String) { print(String(format: "[%7.3f] %@", CFAbsoluteTimeGetCurrent() - t0, s)) }

func describe(_ a: NSRunningApplication?) -> String {
    guard let a = a else { return "nil" }
    return String(format: "pid=%d bundle=%@ name=%@ active=%@",
                  a.processIdentifier,
                  a.bundleIdentifier ?? "nil",
                  a.localizedName ?? "nil",
                  a.isActive ? "Y" : "n")
}

// MARK: - 当前 Space 编号（私有 API，仅观察用）

private typealias CGSpaceFn = @convention(c) (CFString) -> UInt64

/// Space 编号是**私有 API**，且不同 macOS 版本对那个 CFString 参数的约定会变
/// （传空串会抛 `-[__NSCFNumber length]`、用 `Unmanaged` 接返回值又容易触发
/// Swift 运行时断言）。它只用来「量一次事实」，不该让整个探针因为版本差异就
/// 跑不完 —— 所以默认不启用，加 `--space` 才量；量不到一律返回 "n/a"。
private let probeSpace = CommandLine.arguments.contains("--space")

func currentSpace() -> String {
    guard probeSpace else { return "n/a" }
    guard let h = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
          let p = dlsym(h, "CGSManagedDisplayGetCurrentSpace"),
          let uuidRef = CGDisplayCreateUUIDFromDisplayID(CGMainDisplayID()) else {
        return "n/a"
    }
    let uuid = uuidRef.takeRetainedValue()
    guard let uuidStr = CFUUIDCreateString(kCFAllocatorDefault, uuid) else {
        return "n/a"
    }
    let fn = unsafeBitCast(p, to: CGSpaceFn.self)
    let id = fn(uuidStr)
    return id == 0 ? "n/a" : String(id)
}

/// 转一小段 run loop，让 activate / Space 切换这种异步请求真的落地。
func pump(_ seconds: Double) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

// MARK: - ① 最早一刻：NSApplication 还没初始化

// 这里刻意**不**碰 NSApplication：Swift 顶层可执行文件不会自动创建它，
// 与 PicShow `run()` 第一行（Builder::build 之前）的处境一致。
let earliest = NSWorkspace.shared.frontmostApplication
let selfPid = ProcessInfo.processInfo.processIdentifier
stamp("① 最早（NSApplication 未初始化）frontmost = \(describe(earliest))")
stamp("   self pid=\(selfPid)  currentSpace=\(currentSpace())")

// MARK: - ② 用 pid / bundleIdentifier 把那个应用找回来

if let front = earliest {
    let byPid = NSRunningApplication(processIdentifier: front.processIdentifier)
    stamp("② byPid = \(describe(byPid))")
    if let bid = front.bundleIdentifier {
        let byBundle = NSRunningApplication.runningApplications(withBundleIdentifier: bid)
        stamp("   byBundle(\(bid)) 命中 \(byBundle.count) 条")
    }
}

// MARK: - ③ Finder 是回退目标

let finders = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder")
stamp("③ Finder: \(finders.map { describe($0) }.joined(separator: " | "))")

// MARK: - ②' 反证：NSApplication 初始化并激活自己之后，前台就变了

// 这一步证明「为什么捕获必须在第一行」。放在观察之后，免得它污染 ①。
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
pump(0.35)
stamp("②' 初始化并激活自己之后 frontmost = \(describe(NSWorkspace.shared.frontmostApplication))")

// MARK: - ④ 激活 Finder，量 Space 前后变化（可选）

if CommandLine.arguments.contains("--activate-finder"), let finder = finders.first {
    let before = currentSpace()
    stamp("④ activate Finder 之前：space=\(before) front=\(describe(NSWorkspace.shared.frontmostApplication))")
    let ok = finder.activate(options: [])
    stamp("   activate(options: []) -> \(ok)")
    pump(1.0)
    let after = currentSpace()
    stamp("④ activate Finder 之后：space=\(after) front=\(describe(NSWorkspace.shared.frontmostApplication))")
    if before == "n/a" || after == "n/a" {
        print("   ⚠️ 这次没能量到 Space 编号（多半是无 GUI 会话），不能据此下结论")
    } else if before == after {
        print("   · Space 编号没变：可能本来就同一个桌面，或系统「切换应用时切到它所在桌面」被关掉了")
    } else {
        print("   ✓ Space 编号变了 —— 激活 Finder 确实把桌面切到了它窗口所在的那个")
    }
} else {
    print("")
    print("（未做激活实验：加 --activate-finder 会真的把 Finder 提到前台量一次）")
}

// MARK: - 结论

print("")
print("---- 结论 ----")
if let e = earliest, e.processIdentifier != selfPid {
    print("✓ 最早期能读到触发打开的那个应用（\(e.bundleIdentifier ?? "无 bundle id")）—— 捕获必须放在 run() 第一行")
} else {
    print("✗ 最早期前台已是自己（或读不到）—— 需要退回 Finder 兜底，不能只靠 frontmostApplication")
}
print("   产品代码恢复时的判据：pid + bundleIdentifier 双标识一致才 activate（防 pid 复用）")
