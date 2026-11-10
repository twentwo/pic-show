//
//  WKWebView wheel 相位探针 —— 「Web 层拿不到 macOS 手势 phase」的系统级证据。
//
//  这个文件不参与构建，也不被 Tauri / tauri 引用。它存在的唯一理由是：**把
//  PicShow 依赖的那条 WebKit 能力边界钉成可复跑的事实**，避免靠文档印象决定
//  要不要上原生 NSEvent 监视器。
//
//  它回答三个问题：
//
//    1. WKWebView 里的 WheelEvent 到底暴露哪些属性？有没有 phase /
//       momentumPhase / momentum / hasPreciseScrollingDeltas？
//    2. 同一进程里，AppKit 本地监视器能不能读到 NSEvent 的 phase /
//       momentumPhase / scrollingDeltaX？
//    3. 把带 phase 的合成滚轮事件送进应用后，两路各看到什么？
//
//  跑法（macOS + Xcode Command Line Tools）：
//
//      swiftc -O -o /tmp/pswheel tools/appkit_wheel_phase.swift
//      /tmp/pswheel --capabilities             # 只查 WebKit API，约 2 秒，不弹窗
//      /tmp/pswheel --synth                   # 应用内投递，约 4 秒，无需触控板/权限
//      /tmp/pswheel --synth-post              # 系统事件队列注入，两路对照（可能需辅助功能权限）
//      /tmp/pswheel --seconds 12              # 真机：窗口里双指横滑，结束后打印对照
//      /tmp/pswheel --seconds 12 --out /tmp/wheel.jsonl
//
//  stdout 是 JSON lines：side = api / native / web / note / summary，另有
//  「结论:」开头的人读行。`--out` 把同样的行写进文件，便于两路对照。
//
//  注意：合成事件只用来验证探针链路与字段可读性，**不是真机触控板证据**。
//  真机已跑过 `--seconds 12 --out /tmp/wheel_live.jsonl`（2026-11-09）：4 次
//  双指横滑，原生侧 began/changed/ended + 动量 began/changed/ended 完整可辨，
//  Web 侧 205 个 wheel 全无相位字段。真机惯性手感仍只能人工验收，不要假报成功。
//  本地监视器只观察、不吞事件（原样返回），不会改变 WKWebView 自身滚动行为。
//

import AppKit
import WebKit
import CoreGraphics
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
let capabilitiesOnly = args.contains("--capabilities")
let synthPost = args.contains("--synth-post")
let synthMode = args.contains("--synth") || synthPost
var waitSeconds = 10.0
if let i = args.firstIndex(of: "--seconds"), i + 1 < args.count,
   let v = Double(args[i + 1]) { waitSeconds = v }
var outURL: URL?
if let i = args.firstIndex(of: "--out"), i + 1 < args.count {
    outURL = URL(fileURLWithPath: args[i + 1])
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

let keysToCheck = [
    "phase", "momentumPhase", "momentum", "hasPreciseScrollingDeltas",
    "isDirectionInvertedFromDevice", "webkitDirectionInvertedFromDevice",
    "wheelDeltaX", "wheelDeltaY", "wheelDelta", "deltaX", "deltaY", "deltaZ",
    "deltaMode", "isTrusted", "timeStamp"
]

let html = """
<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#f2f2f4;font:14px -apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;color:#222;overflow:hidden}
#hint{text-align:center;line-height:1.8}
b{font-weight:500}
</style></head><body>
<div id="hint"><b>WKWebView wheel 相位探针</b><br>在这个窗口里用触控板双指横向滑动<br>
<span style="font-size:12px;color:#666">原生 NSEvent 与 Web WheelEvent 会分别记录</span></div>
<script>
const KEYS = __KEYS__;
function post(kind, payload) {
  try {
    window.webkit.messageHandlers.probe.postMessage(
      JSON.stringify(Object.assign({kind:kind}, payload)));
  } catch (e) {}
}
function cap() {
  const proto = Object.getOwnPropertyNames(WheelEvent.prototype);
  let ev = null;
  try { ev = new WheelEvent('wheel', {deltaX:12, deltaY:0}); } catch (e) {}
  const inEvent = {};
  for (const k of KEYS) inEvent[k] = !!(ev && (k in ev));
  post('api', {
    hasWheelEvent: typeof WheelEvent,
    protoKeys: proto,
    phaseLike: proto.filter(k => /phase|momentum|precise|gesture|webkit/i.test(k)),
    inEvent: inEvent,
    ownKeysOnInstance: ev ? Object.getOwnPropertyNames(ev) : [],
    gestureEvent: typeof GestureEvent,
    userAgent: navigator.userAgent
  });
}
window.addEventListener('wheel', function (e) {
  const vals = {};
  for (const k of KEYS) vals[k] = (k in e) ? String(e[k]) : null;
  post('web', {
    dx:e.deltaX, dy:e.deltaY, dz:e.deltaZ, dm:e.deltaMode,
    trusted:e.isTrusted, ts:e.timeStamp, vals:vals,
    ownKeys:Object.getOwnPropertyNames(e)
  });
}, {passive:true});
cap();
</script></body></html>
""".replacingOccurrences(of: "__KEYS__", with:
    "[" + keysToCheck.map { "'" + $0 + "'" }.joined(separator: ",") + "]")

// AppKit 的 NSEventPhase 是**位标志**（NSEvent.h），不是 CGEvent 滚轮相位字段
// 的 1/2/4/8 顺序枚举。合成事件里写 CG 字段值 n，AppKit 读出来是 1 << (n-1)，
// 两者差一位；按 CG 语义标注会把 changed 读成 ended、ended 读成 cancelled。
let phaseNames: [UInt: String] = [
    0: "none", 1: "began", 2: "stationary", 4: "changed",
    8: "ended", 16: "cancelled", 32: "mayBegin"
]
func phaseLabel(_ raw: UInt) -> String { phaseNames[raw] ?? "raw(\(raw))" }

final class Probe: NSObject, WKScriptMessageHandler, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var monitor: Any?
    var lines: [String] = []
    var nativeCount = 0
    var webCount = 0
    var phaseSet = Set<String>()
    var momentumSet = Set<String>()
    var apiRow: [String: Any]?
    var finished = false

    func emitRow(_ row: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
        lines.append(line)
    }

    func start() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let rect = NSRect(x: 140, y: 160, width: 620, height: 380)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "PicShow · WKWebView wheel phase probe"
        window.isReleasedWhenClosed = false

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "probe")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(webView)

        monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] ev in
            self?.recordNative(ev)
            return ev
        }

        webView.loadHTMLString(html, baseURL: nil)
        if !capabilitiesOnly {
            window.makeKeyAndOrderFront(nil)
            app.activate(ignoringOtherApps: true)
        }

        let deadline = capabilitiesOnly ? 2.0 : (synthMode ? 4.0 : max(waitSeconds, 3.0))
        DispatchQueue.main.asyncAfter(deadline: .now() + deadline) { [weak self] in
            self?.finish()
        }
        if synthMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                self?.synthesize()
            }
        }
    }

    func recordNative(_ ev: NSEvent) {
        nativeCount += 1
        let p = phaseLabel(UInt(ev.phase.rawValue))
        let m = phaseLabel(UInt(ev.momentumPhase.rawValue))
        phaseSet.insert(p)
        momentumSet.insert(m)
        emitRow([
            "side": "native", "t": nowMs(),
            "phase": p, "momentumPhase": m,
            "phaseRaw": ev.phase.rawValue, "momentumRaw": ev.momentumPhase.rawValue,
            "scrollingDeltaX": Double(ev.scrollingDeltaX),
            "scrollingDeltaY": Double(ev.scrollingDeltaY),
            "deltaX": Double(ev.deltaX), "deltaY": Double(ev.deltaY),
            "precise": ev.hasPreciseScrollingDeltas,
            "inverted": ev.isDirectionInvertedFromDevice,
            "subtype": ev.subtype.rawValue,
            "targetIsProbe": ev.window === window,
            "isKey": window.isKeyWindow
        ])
    }

    // 两条注入路径：`--synth` 走 NSApp.sendEvent（无需权限，验证原生侧能读到
    // phase，但不经过 WKWebView 的 wheel 翻译）；`--synth-post` 走系统事件队列
    // （更接近真实触控板，用来看两路能否同时收到，可能需要辅助功能权限）。
    func synthesize() {
        // CG 滚轮相位字段用顺序枚举 1=began / 2=changed / 4=ended / 8=cancelled，
        // AppKit 读出的 NSEventPhase 是 1<<(n-1) 的位标志；所以 1/2/2/4 会变成
        // 1/4/4/8 = began/changed/changed/ended。动量字段同理，但合成路径上只有
        // 写 1 能稳定读出 momentum began，写 4 实测读出 none —— 别拿它当证据。
        let phases: [Int64] = [1, 2, 2, 4, 0, 0]
        let momenta: [Int64] = [0, 0, 0, 0, 1, 4]
        for i in 0..<phases.count {
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                  wheelCount: 2, wheel1: 0,
                                  wheel2: Int32(18 - i * 3), wheel3: 0) else { continue }
            // kCGScrollWheelEventScrollPhase = 99 / MomentumPhase = 123 /
            // IsContinuous = 88（CoreGraphics CGEventTypes.h）
            cg.setIntegerValueField(CGEventField(rawValue: 99)!, value: phases[i])
            cg.setIntegerValueField(CGEventField(rawValue: 123)!, value: momenta[i])
            cg.setIntegerValueField(CGEventField(rawValue: 88)!, value: 1)
            if synthPost {
                // 走系统事件队列：更接近真实触控板路径。CG 坐标原点在左上，
                // NSWindow 原点在左下，需要按主屏高度翻一次 y。
                let screenH = NSScreen.main?.frame.maxY ?? 0
                cg.location = CGPoint(x: window.frame.midX,
                                      y: screenH - window.frame.midY)
                cg.post(tap: .cgSessionEventTap)
            } else if let ns = NSEvent(cgEvent: cg) {
                NSApp.sendEvent(ns)
            }
            usleep(40_000)
        }
        emitRow(["side": "note", "t": nowMs(),
                 "message": synthPost
                    ? "sent 6 synthetic scrollWheel events via CGEvent.post(session tap)"
                    : "sent 6 synthetic scrollWheel events via NSApp.sendEvent"])
    }

    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let s = message.body as? String,
              let data = s.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        var row = obj
        row["side"] = "web"
        row["t"] = nowMs()
        emitRow(row)
        let kind = obj["kind"] as? String ?? ""
        if kind == "api" {
            apiRow = obj
            printAPI(obj)
            if capabilitiesOnly { finish() }
        } else if kind == "web" {
            webCount += 1
        }
    }

    func printAPI(_ o: [String: Any]) {
        let proto = o["protoKeys"] as? [String] ?? []
        let phaseLike = o["phaseLike"] as? [String] ?? []
        let inEvent = o["inEvent"] as? [String: Any] ?? [:]
        print("WebKit UA: \(o["userAgent"] as? String ?? "?")")
        print("WheelEvent.prototype 共 \(proto.count) 个属性")
        print("  含 phase/momentum/precise/gesture/webkit 的: \(phaseLike)")
        for k in ["phase", "momentumPhase", "momentum", "hasPreciseScrollingDeltas",
                  "isDirectionInvertedFromDevice", "webkitDirectionInvertedFromDevice",
                  "wheelDeltaX"] {
            let present = (inEvent[k] as? Bool) ?? false
            print("  event.\(k): \(present ? "存在" : "不存在")")
        }
        print("  实例自有属性: \(o["ownKeysOnInstance"] as? [String] ?? [])")
        print("  typeof GestureEvent: \(o["gestureEvent"] as? String ?? "?")")
        fflush(stdout)
    }

    func finish() {
        guard !finished else { return }
        finished = true
        let inEvent = apiRow?["inEvent"] as? [String: Any] ?? [:]
        let webHasPhase = (inEvent["phase"] as? Bool) ?? false
        let webHasMomentumPhase = (inEvent["momentumPhase"] as? Bool) ?? false
        let webHasMomentum = (inEvent["momentum"] as? Bool) ?? false
        let nativeHasPhase = phaseSet.contains { $0 != "none" }
        let nativeHasMomentum = momentumSet.contains { $0 != "none" }

        emitRow([
            "side": "summary", "t": nowMs(),
            "mode": capabilitiesOnly ? "capabilities"
                : (synthPost ? "synth-post" : (synthMode ? "synth" : "live")),
            "nativeEvents": nativeCount, "webEvents": webCount,
            "nativePhases": Array(phaseSet).sorted(),
            "nativeMomentumPhases": Array(momentumSet).sorted(),
            "webHasPhase": webHasPhase,
            "webHasMomentumPhase": webHasMomentumPhase,
            "webHasMomentum": webHasMomentum
        ])

        print("---- 结论 ----")
        if apiRow != nil {
            print("结论: WKWebView 的 WheelEvent 暴露 phase=\(webHasPhase)、momentumPhase=\(webHasMomentumPhase)、momentum=\(webHasMomentum)")
        } else {
            print("结论: 页面未回传 API 能力表（WKWebView 未能执行 JS），本轮无效")
        }
        if capabilitiesOnly {
            print("结论: 仅 API 能力探测；要验证原生侧 phase 请跑 --synth，真机请跑 --seconds 12")
        } else {
            print("结论: 本地监视器收到 \(nativeCount) 个 scrollWheel，phase 取值 \(Array(phaseSet).sorted())，momentumPhase 取值 \(Array(momentumSet).sorted())")
            print("结论: Web 侧收到 \(webCount) 个 wheel 事件")
            if nativeHasPhase || nativeHasMomentum {
                print("结论: 原生侧确实读得到手势相位（began/changed/ended 或动量段），Web 侧没有对应字段")
            } else {
                print("结论: 本轮未观察到非零相位（真机模式请确认窗口里真的滑过触控板）")
            }
            if synthMode && !synthPost && webCount == 0 {
                print("结论: NSApp.sendEvent 不经过 WKWebView 的 wheel 翻译，webEvents=0 属预期；两路对照请看 --synth-post 或真机")
            }
            if synthPost && webCount == 0 {
                print("结论: 系统注入未被 WKWebView 接收（常见原因：辅助功能权限 / 事件未命中窗口）；以真机 --seconds 为准")
            }
        }
        fflush(stdout)

        if let u = outURL {
            try? (lines.joined(separator: "\n") + "\n").write(to: u, atomically: true,
                                                              encoding: .utf8)
            print("结论: JSON lines 已写入 \(u.path)")
        }
        exit(0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

let app = NSApplication.shared
let probe = Probe()
app.delegate = probe
probe.start()
app.run()
