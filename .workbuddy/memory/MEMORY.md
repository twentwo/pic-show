# PicShow 项目长期约定

## 窗口：装饰永不变，几何终身只读

**这是本项目最硬的两条架构约束，违反它们的代码照样能编译、能运行、大部分时候
看着也对 —— 只在一部分机器上一部分时候露馅。** 由 `tools/check_window_split.mjs`
与 `tools/check_boot.mjs` 钉住，违反即检查失败。

1. **装饰永不变**：窗口样式（`Titled` + `FullSizeContentView` + 透明标题栏 +
   隐藏标题文字）只在**每条窗口诞生时**由 `crate::macos::apply_immersive_frame`
   设定一次，之后运行时绝不改。启动时遍历 `NSApp.windows()` 设两条；预览窗口
   重建时再跑一次同一个幂等函数（跳过已设过的窗口）。进出预览只有
   `set_fullscreen` 一个动作。
2. **几何终身只读**：任何地方都不许 `set_size` / `set_position` /
   `set_maximized`。`tauri.conf.json` 里的初始尺寸必须是普通尺寸（不是
   maximized / fullscreen）。

原因：AppKit 还原窗口用的是**进入全屏前那一帧**。只要在那之前写过几何（哪怕只是
为省一次布局而摆到整块屏），macOS 当场判定它 `zoomed`，AppKit 从此把「最大化」
当成还原目标，退出预览必然永久停在最大化。同时在全屏期间动装饰，会触发 tao
`saved_style` 那条无条件覆盖链，让标题栏回不来。

系统级证据与开关见 `tools/appkit_geometry.swift`（`--tao` / `--presize` /
`--hidden`）。**排查这类问题时，先用独立探针把平台行为测成事实，再读自己的代码。**

## 预览窗口：退出即销毁，进入按需重建

**不要再把预览窗口做成常驻 + `hide()`。** 这是三轮缺陷的根治结论：

- `hide()`（`orderOut:`）不释放原生全屏独占的 Space；
- 想让 AppKit 收掉 Space 就得先播退出全屏转场，而转场里窗口从整屏缩回
  1200×800 的**那一帧就是空白窗口**；转场收尾还会把刚藏掉的窗口拉回屏幕；
- `NSWindow.frame` 比 `windowDidExitFullScreen:` 早约 530ms 落到终值，靠「多等
  一会儿」补不上（`tools/appkit_fullscreen_exit.swift` 实测）。tao 的
  `is_fullscreen()` 是记账不是状态，同样不可信。

**直接 `destroy()` 一个仍处在全屏的窗口**：AppKit 自己走完 `didExit` 回收桌面，
窗口从层级与 Tauri 注册表移除，全程没有常规尺寸的可见帧（同探针
`--close-in-fullscreen`）。实现要点：

| 要点 | 说明 |
| --- | --- |
| `ensure_viewer_window()` | 先查 `get_webview_window("viewer")`，不存在才用 `WebviewWindowBuilder::from_config` 按 `app.config().app.windows` 里同一份配置重建；同一时刻最多一条 viewer |
| 销毁后 `set_viewer_listening(false)` | 新 webview 未装配，发事件会掉黑洞 |
| 确认移除 → 才 `reveal_main_window()` | `activateIgnoringOtherApps:` 会把还活着的窗口一起提到前台 |
| 世代号 | 销毁确认期间又开预览就让上一次让位作废 |
| 后台线程做确认 | 不能在命令线程轮询等 `Destroyed`（自锁） |

四条退出路径（Esc / 双击 / 关闭按钮 / 交通灯 Cmd+W）统一走前端 `viewer.close()`
→ `close_viewer`；沉浸式走 `exit_app`，进程退出走 `ExitRequested`，都销毁。
`destroy()` 不发 `CloseRequested`，不会与拦截形成循环。

## 焦点

焦点必须在「窗口已显示 + 首图已落地」之后才要，由前端 `handOverFocus()` 调用
`focus_window`。对隐藏窗口设焦点会被平台直接忽略。

## 真机验证

纯 `cargo build` 出来的 debug 二进制缺 `custom-protocol`，会去连 `devUrl`
（localhost:1420），前端跑不起来 —— **真机验证必须同时起 `tools/serve.js`**。
用 CGWindowList 观察窗口几何时要 `[.optionAll]`，全屏窗口被搬进了独立 Space，
「在屏」那一档看不见它。Space 切换、Finder 激活、全屏转场这类观感，沙箱/无 GUI
会话测不了（探针里 `activate()` 会返回 false），只能按 README 步骤真机人工验收，
且不要据此假报成功或失败。

## 多桌面（Space）：「打开方式」退出后的桌面恢复

macOS **没有公开 API** 指定「回到第 N 个桌面」（`CGS*` 私有，产品代码一行都不用）。
唯一可靠做法是**激活那个桌面上的应用**（`NSRunningApplication.activateWithOptions:`），
WindowServer 会把桌面、key window、焦点一起交还。根因不是全屏转场，而是
LaunchServices 唤起时系统切到「包含该应用窗口的桌面」，冷启动隐藏的 `main`
窗口被算在第一个 Space。

硬约束：

1. **捕获必须放在 `lib.rs::run()` 第一行**（`NSApplication` 初始化 / 应用被激活
   **之前**）读 `NSWorkspace.frontmostApplication`；`RunEvent::Opened` 开头再
   捕获一次。晚一步读到的就是 PicShow 自己（`tools/appkit_space_restore.swift`
   实测）。读到自己是自己时保留旧记录，别覆盖来源。
2. **交还只在「访达打开方式」一条路径**：`hand_back_launch_source` 要求
   `was_launched() && space_restore_armed()` 双条件，`space_restore_armed` 只有
   macOS `RunEvent::Opened` 会置起。命令行 argv、拖放、文件对话框、图片墙点开
   全部走 `close_viewer → reveal_main_window()`，绝不顺手改它们的退出行为。
3. **一次性**：`SOURCE_HANDED_BACK` 闸门防 `exit_app` 与 `ExitRequested` 叠加
   切两次；新一次打开到来时复位。恢复用 `take()` 取一次即清空。
4. **只用公开 API、绝不写窗口几何**：`pid + bundleIdentifier` 双标识防 pid
   复用；来源应用找不到才回退访达；连访达都找不到就什么都不做。
5. `exit_app` 顺序：先销毁全屏窗口 → 再交还前台 → 留 140ms 给异步激活落地 →
   才 `app.exit(0)`。由 `tools/check_boot.mjs` 的多桌面断言组钉住。
