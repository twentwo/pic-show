# PicShow 长期约定（2026-11-09 精简去重版）

## 窗口铁律（违反照样能跑，只在部分机器/时刻露馅）

1. **装饰永不变**：`Titled` + `FullSizeContentView` + 透明标题栏只在每条窗口诞生时由
   `macos::apply_immersive_frame` 设一次，运行时绝不改；进出预览只有 `set_fullscreen`。
   全屏期间改装饰会触发 tao `saved_style` 无条件覆盖链，标题栏回不来。
2. **几何终身只读**：禁 `set_size` / `set_position` / `set_maximized`；`tauri.conf.json`
   初始尺寸必须是普通尺寸。AppKit 以「进入全屏前一帧」为还原目标，写过几何就被判
   `zoomed`，退出预览永久停在最大化。由 `check_window_split.mjs` / `check_boot.mjs` 钉住。
3. **排查顺序**：先用独立探针把平台行为测成事实，再读自己的代码
   （`tools/appkit_geometry.swift`、`appkit_fullscreen_exit.swift`、`appkit_space_restore.swift`）。

## 预览窗口与焦点

- **常驻 + `hide()` 是错的**：不释放全屏独占 Space；想收回就得播退出转场，而缩回
  1200×800 那一帧正是空白窗口；`NSWindow.frame` 比 `windowDidExitFullScreen:` 早约
  530ms，靠多等补不上；tao 的 `is_fullscreen()` 只是记账。**直接 `destroy()` 仍全屏的
  窗口**，AppKit 自己走完 `didExit` 回收桌面，全程没有常规尺寸的可见帧。
- `ensure_viewer_window()` 查不到才用 `WebviewWindowBuilder::from_config` 按同一份
  config 重建；销毁后 `set_viewer_listening(false)`；确认移除 → 才 `reveal_main_window()`；
  世代号防并发让位作废；确认必须放后台线程（命令线程轮询等 `Destroyed` 会自锁）。
- 四条退出路径（Esc / 双击 / 关闭按钮 / Cmd+W）统一 `viewer.close() → close_viewer`；
  沉浸式 `exit_app`、进程退出 `ExitRequested` 都销毁。`destroy()` 不发 `CloseRequested`。
- 焦点只在「窗口已显示 + 首图已落地」之后由 `handOverFocus()` 要，隐藏窗口设焦点被忽略。
- 真机验证必须同时起 `tools/serve.js`（纯 `cargo build` 缺 `custom-protocol`）；
  CGWindowList 要用 `[.optionAll]`；Space / 转场观感只能按 README 人工验收，不要假报成功。

## 多桌面：「打开方式」退出后的桌面恢复

macOS 无公开 API 指定第 N 个桌面（`CGS*` 私有，产品代码不用），唯一可靠做法是**激活
来源应用**，WindowServer 连桌面/key window/焦点一起交还，绝不写窗口几何。

1. 来源捕获必须在 `lib.rs::run()` 第一行（`NSApplication` 初始化前）读
   `NSWorkspace.frontmostApplication`，`RunEvent::Opened` 再捕一次；读到自己就保留旧值。
2. 只在「访达打开方式」交还：`was_launched() && space_restore_armed()`；一次性闸门
   `SOURCE_HANDED_BACK` 防 `exit_app` 与 `ExitRequested` 叠加，恢复用 `take()` 清空。
   命令行 argv / 拖放 / 文件对话框 / 图片墙点开一律不改退出行为。
3. `pid + bundleIdentifier` 双标识防 pid 复用 → 回退访达 → 都找不到就什么都不做。
   `exit_app` 顺序：销毁全屏窗口 → 交还前台 → 140ms → `app.exit(0)`。

## 触控板横滑：产品契约（用户反复权衡后的最终版，勿回退）

「一次滑动」= 从起手到流停下的一整段横向 wheel 流（含惯性尾巴），**最多切相邻一张**，
流中间零换页。历史走过三轮：旧 `locked` 锁（吞惯性、不跟手）→ 连续模型（一次长甩跨
多张，违反语义）→ 现在：跟手/动画沿用连续模型，只把索引变化收成一次。

- **不装回旧锁**：`t.x` 记真实行程，`wheelFollowOffset()` 前 75% 1:1 后渐近压到不足
  一屏；累计夹在 `limit*2` 内（异常大 delta 会把画面推到槽外）。`WHEEL_GESTURE_END_MS`
  =65ms 静默推断流结束（**兜底**：macOS 默认已由原生相位接管，见下；
  只有 `PICSHOW_WHEEL_PHASE=0` / 非 macOS / IPC 失败时才轮到它），
  `settleWheelSwipe()` 是唯一索引变化点，命中只
  `go(direction)` 一次；`settled` 只在两个真正落地分支置起，由
  `clearWheelProgress()` 与「新的一段」共用 65ms 复位（或原生 began 直接复位）。
  同段掉头不靠速度结算，反向须位移重新达标。
- **边界不看 `loop`**：`onWheelCanStep()` 只问 `index + dir ∈ [0, n)`；`canSwipe()`
  （按钮/键盘）仍看 `loop`，两条别混。边界判定必须排在 `claimTrack()` **之前**（接管
  那一帧恰好露出边缘）：`swipeX` 恒 0、`applyTrack()` 每帧写基准，绝不调 `onWheelFollow`
  / `onSwipeIntent`；`WHEEL_OVERSCROLL_RUBBER`(90) 只夹累计行程。只把
  `WHEEL_EDGE_RUBBER`(22) 的弹性量写进**当前槽**两张 `<img>`，越界槽一律 0，
  `releaseWheelSeam(true)` 200ms/EASE_SOFT 收回即自然回弹；`fill()` 的越界保底
  只服务键盘/按钮 `nudgeAtEdge()`。`reboundWheelSwipe()` 在 `swipeX===0` 直接返回，
  绝不 `animateTrackTo(0)` 掐掉上一段回弹。
- **边界阴影是纯视觉附加层，勿并进切换语义**：`.viewer-edge-shade` 插在 stage
  之后 / chrome 之前（DOM 顺序即层序，不引入 z-index），`pointer-events:none`、
  渐变取 `var(--viewer-bg)` 保证深浅主题同源（不新增颜色令牌）。`followWheelEdge()`
  把同一份 `elastic` 交给 `paintEdgeShade()`：绝对值 → `scaleX(0…1)` 拉长 +
  不透明度（上限 0.45），符号 → 负落右边缘 / 正落左边缘；`releaseWheelSeam()`
  把**同一个 timing 对象**交给 `releaseEdgeShade()`，与当前图贴边量同长同缓动
  收回 0；`go()` 非 wheel 打断与 `finishClose()→resetSlots()` 硬清空。绝不调
  `go()` / `settleWheelSwipe()` / `fill()`，正常方向根本不出现。
  `check_trackpad.mjs` 第 16 组 / `probe.html` `17.22a~f` 钉住。
- **Web `WheelEvent` 不暴露 `phase` / `momentumPhase`**，这是与原生最本质的能力差。
  W3C `WheelEvent.momentum`（仅惯性布尔、无 began/ended）在 Chrome 151 落地，
  WebKit 无信号。真机实测（`tools/appkit_wheel_phase.swift`，2026-11-09，
  `/tmp/wheel_live.jsonl`）：205 个 Web wheel 全无相位字段；213 个原生 `NSEvent`
  4 次手势 began/changed/ended + 动量 began/changed/ended 齐全，**零 ΔX 的 ended
  边界事件不转成 wheel** → Web 侧永远拿不到明确结束点。两路一一对应、
  `scrollingDeltaX` 与 `deltaX` 符号相反且绝对值相等。
  **`NSEventPhase` 是位标志 1/2/4/8/16/32**（不是 CG 顺序值），别标错。
  65ms 静默实测：段内间隔 ≤37ms（不会提前结算 ✓），但两次连滑间隔 58ms < 65ms
  被合成一段、少切一张 ✗；可用阈值窗口只有 37~58ms，调阈值治标不治本，根治只能
  用原生 phase → Tauri emit → 前端（静默保留兜底）。真机逐帧手感仍需人工验收。
  真机 Tauri 原型（`~/Downloads/Console.txt`）：324 帧 / 14 次手势，IPC 单程
  0~3ms，`phase began/ended` 与 `momentum began/ended` 各 14 个一个不缺 →
  **已接成结算时机的主判据**。2026-11-09 收敛成**默认开启的产品能力**：
  `wheel_phase.rs` 默认装监视器（仅 `PICSHOW_WHEEL_PHASE=0` 可关），在 Rust 侧
  把一次手势归一成恰好一次 begin + 一次 end（旧原型两类 ended 双计、14 次记
  28 笔），只 `emit_to` 两个 `{kind}` 事件；`wheel-phase.js` 退成纯转发 +
  `begins/ends/last` 三个计数，逐帧 payload / 配对 / IPC 统计 / JSONL /
  `PICSHOW_WHEEL_PHASE_OUT` 全部下线，开销从「每帧一次 IPC」降到「每手势两次」。
  过滤通过后才读相位，图片墙滚动不参与手势状态机（`IN_MOMENTUM` 只由已转发
  帧推进）。语义链不变：`viewer.handleWheelPhase()` →
  `Gestures.onWheelPhaseBegin/End()`；began 复位 `settled` / `dir` / `phaseEnded`
  （不受 65ms 限制，50ms 连滑各切一张），`momentum ended` 置 `phaseEnded` 让
  `armWheelSettle()` 用 `WHEEL_PHASE_SETTLE_MS=24` 短刻度提前结算。
  **65ms 静默仍是兜底**：`=0` / 非 macOS / IPC 失败时整条链路零调用、行为逐字
  不变；方向、位移、速度、贴边、落位、边界回弹全部仍由 Web wheel 驱动。
  用户对比两种启动方式确认：带相位时快滑更流畅（松手→落位提前 24~41ms、
  50~58ms 连滑不再被吞）。**默认开启后的长期运行开销、真机逐帧手感 /
  `momentum cancelled` 仍未验证**，别假报成功。
- **能力来源与释放契约（2026-11-10 补，别回退）**：`wheel-phase.js` 快照除
  `begins/ends/last` 还有 `source('native'|'none')` / `lastEventAt` /
  `sinceLastEventMs`；`source=none` 只说明**从未收到**，成因可能是 `=0` / 非
  macOS / IPC 失败 / 三重过滤，别读成「监视器未安装」。零新增 IPC、wheel
  监听或定时器。`gestures.js::releaseWheelControl()` 是唯一命名的生命周期
  释放口，只委托 `resetWheelSwipe()`，恰好 3 个调用点：`ctrl+wheel`、右边缘
  48px、`abort()`（失焦）。**`abort()` 的释放必须排在 `pointers.size===0`
  提前返回之前** —— 横滑没有指针，旧实现会留着结算定时器在后台翻页。
  **`detach()` 刻意不释放**：切图要经 `wheelState` 把状态交给新 Gestures。
  边界真正把 wheel 交还系统仍**未做**（与「只弹当前图、不露边缘」冲突，
  须真机 A/B）。第 31 组钉 `24 < 37 < 58 < 65`，改任一时间刻度先跑它。

## 动画与像素（别回退）

- **WAAPI 提交纪律**：`viewer.animateTrack()` / `Gestures.animateTrackTo()` 起点先写
  inline + `fill:'forwards'` + 终值只在 `finished` 里提交回 inline 再 `cancel()`，
  提交前认 `this.trackAnim === anim` / `this.anim === anim`。「终点预写 + none」会在
  采样前那一帧闪到终点、跑完又闪回起点。`gestures.animateTo()` 是另一套，别统一。
- **预览显示：淡入终值必须提交**（2026-11-10 修的根因，别回退）：`jumpTo()` 曾把
  `slide.style.opacity='0'` 写进 inline，却用 `fill:'none'` 播淡入且**从不提交终值**
  → 播完回到 inline 0，当前槽永久全透明；后续 `go()` 的 `rebalance()` 只填轮转出去
  那一格，透明一直残留 → 切换 / 连续切换张张空白，看着像图片加载失败。现在：
  `fill:'forwards'` + `withTimeout(fade.finished, JUMP_MS+ANIM_SLACK_MS)` 里
  `removeProperty('opacity')` 再 `cancel()`；**提交不设世代号守卫**（终值是「可见」，
  新切换接管也不能跳过）；等待仍用原来的 `setTimeout(JUMP_MS)`，交互时机不变。
  `fill()` 的清 inline opacity 必须排在「`__index/__shown` 未变提前返回」**之前**，
  否则再次打开 / 轮转中的当前槽跳过清理。`open()` 淡入不写 inline 0；
  `playClose()` 有意写 0 由 `resetSlots()` 收掉，别被兜底清掉。`jumpTo()` 同索引还要
  比对 `currentSlot.__low.__want` 与本次 `thumbUrl(item.id)`，不一致强制三槽重画
  （跨窗口换会话 index 不变时不能停在旧集合的图上）。
- **`fromWheel` 收尾只 `retarget()`**：不重建 `Gestures`、不关 `enabled`、不落闸。
  `wheelLandTiming(dist, v)` 纯函数给 `T=clamp(2d/v0, 24, 180)`、
  `cubic-bezier(1/3, y1, 2/3, 1)`（起点速度=vStart、终点=0，`y1 = x1·vStart·T/d`，
  `vStart=min(v0, d/(T·x1))`）；`WHEEL_LAND_MS`(180) 自此只是上限。下限曾取 60ms，
  短余数被顶长造出新慢尾。`go()` 与 `releaseWheelSeam()` 必须调同一函数、同源 `dist`。
  `onWheelSettle()` 在补完/回弹动作**前**触发，贴边 CSS transition 与轨道 WAAPI 同源。
- **槽位永不空白**：绝不原地 `setSrc()`（先抹旧像素）；`swapSlotImage()` 原子换整个
  `<img>` 节点，池命中同帧 `replaceWith`，池空用 `api.js::decodedImage()` 新建 +
  `decode()` 完才替换（慢路径不能省：取走即出池，反向滑回永远没有第二个节点），
  `__swapGen` 挡乱序；`imageReady()` 用 `MutationObserver` 按槽重绑 load/error。
- **预热**：静止期 `preloadNeighbors()` 双向备缩略图 + 原图（`fill()` 画的是
  `thumbUrl()`，只备原图=预热错资源）；`advanceBy()` 的方向预热排在 `rebalance()`
  之前；`open()` 把两槽像素 Promise 接在 FLIP 之后、开放手势之前
  （`NEIGHBOR_READY_MS = OPEN_MS`，`openGen` 作废旧回调）。
- **贴边跟随**：`.slide img` 是 `object-fit: contain`，槽留白 `m=(视口宽-图宽)/2`；
  轨道一动先进视口的是留白。`handleWheelHorizontal()` 必须在写 `applyTrack()` **之前**
  调 `onWheelFollow()`，`followWheelSeam()` 只给 `slots[1+dir]` 写
  `-dir*m*(1-p)`（`p=|swipeX|/视口宽`），随进度线性收回 0。`m` 只从缓存
  `slot.__box.w` 算，热路径禁读布局；换源由 `paintSlotSeam()` 继承，
  `fill()`/`resetSlots()` 硬清空。贴边前校 `target.__index/__shown` 并
  `bindSlotPixels()` 补装晚到的解码节点。**窄屏 `m=0` 是合法退化**，断言不许假设非零。
- **热路径不碰布局**：`advanceBy()` 一次 `view()` 传给 `rebalance({view,skipTransform:true})`
  与 `fill()`；`fill()` 默认参数别写 `this.view()`（`check_methods.mjs` 的 `RE_DEFINED`
  用 `[^)]*`）。静态断言按方法体切片（如 `swapSlotImage` → `installSlotImage`），
  别拿整份 `viewerCode` 做正则，否则世代号这类断言会漏网。

## 回归纪律

语义改动必须同批同步：`tools/check_wheel_swipe.mjs`（时序，含 22/24/27/28/29/30/31 组，
29 = 原生相位结算与兜底、30 = 慢滑回弹曲线、31 = 成对阈值与失焦释放）、
`tools/check_trackpad.mjs`（结构 + 旧锁定不得回归 +
7a2 边界 + 11~17 组动画/像素/相位/边界阴影/释放契约）、`tools/check_wheel_phase.mjs`（产品链路边界 + vm 行为级，第 8 组 = 能力来源快照）、
`tools/check_preview_entry.mjs` 第 7 组（预览显示：淡入提交纪律 / fill 可见性兜底顺序 /
同索引换集合重画 / 开场不写 inline 0 / 关闭置 0 仍在）与第 8 组（资源就绪与结算解耦）、
`ui/probe.html` 第 17 节（`17.2` 一次一张、`17.8`/`17.19` 边界、`17.17` 贴边、
`17.18` 落位速度、`17.20` 相位转发、`17.21` 慢滑复位、`17.22` 边界阴影）与
第 21 节（`21.1~9`：把 `img://` 换成可加载 SVG，逐步量当前槽画的是不是目标图、
有没有像素、不透明、计数器一致；这是唯一能验「真的显示了」的行为层）、
README 设计章节，否则「代码对了、检查器红」。
三层回归：纯时序 → 真 DOM 双视口探针（1440×900 + 414×896）→ 反向变异验证
（必须实跑一遍，别只看断言写没写）。
