# PicShow

用 **Tauri 2 + 原生 HTML/CSS/JS** 写的跨平台桌面照片查看器，复刻早期 Google Picasso 的看图体验：
连续性展开转场、跟手缩放平移、下拉即关、控件自动隐身。

后端 Rust（图像解码 / 缩略图 / 缓存 / 协议），前端零依赖、零打包步骤——改完代码刷新窗口就生效。

---

## 一、特性对照

| 需求 | 实现位置 | 说明 |
| --- | --- | --- |
| 打开图片/文件夹 | `commands.rs` `pick_images` / `open_paths` / `open_folder` | 系统对话框 + 窗口内拖放 |
| **从文件管理器打开**（右键 → 打开方式） | `commands.rs` `open_file_context` + `scanner.rs` `scan_siblings` | 见第七节：装载同目录全部图片并停在右键那一张 |
| 画廊式缩略图网格 | `grid.js` | justified 等高行 + 虚拟化滚动 |
| 双击 / 滚轮 / 键盘 / 捏合缩放 | `gestures.js` | 统一锚点缩放，连续无级 |
| 拖拽平移 + 越界回弹 | `geometry.js` `settle()` | iOS 风格橡皮筋阻尼 |
| 连续转场 | `viewer.js` `open()` / `close()` | FLIP：缩略图矩形 ↔ 适配矩形 |
| 下拉关闭 | `gestures.js` dismiss 分支 | 速度 / 位移双阈值判定 |
| 控件自动淡出 | `chrome.js` + `viewer.js` `bumpChrome()` | 标题栏 / 按钮 / 胶片条**同一计时器、同一时长与缓动**，2.2s 空闲后一起隐藏，含鼠标指针 |
| 上一张 / 下一张 | `viewer.js` `go()` | 方向键、导航按钮、**单指横滑跟手拖动** |
| 按缩略图跳转 | `strip.js` | 底部胶片条，当前项高亮并自动居中 |
| 当前索引 / 总数 | `viewer.js` `updateInfo()` | 标题栏 `3 / 128` |
| `Home` / `End` / `Esc` | `viewer.js` `onKeyDown()` | 首张 / 末张 / 返回网格 |
| 低分辨率占位 → 原图渐进替换 | `viewer.js` `fill()` / `startFullLoad()` | 复用网格已缓存缩略图，命中即秒开 |
| 多图懒加载 / 占位 / 失败态 | `grid.js` `strip.js` | 窗口化渲染 + 延迟请求 + 模糊占位 + 失败重试 |
| 响应式（桌面 / 窄屏） | `app.css` 媒体查询 + `grid.js` 行高自适应 | 断点 720px，触摸目标 ≥44px |
| 窗口尺寸变化后自适应 | `grid.js` `onResize()` / `viewer.js` `onResize()` / `strip.js` `onResize()` | ResizeObserver + rAF 合并 + 重排后重新定位已挂载格子 |
| 缓存 + 流畅滚动 | `state.rs` `protocol.rs` | 内存 LRU(256MB) + 磁盘缓存 + webview HTTP 缓存 |

---

## 二、项目结构

```
PicShow/
├── package.json                    # 只装 Tauri CLI，前端无依赖
├── tools/
│   ├── serve.js                    # 开发用零依赖静态服务器 (:1420)
│   └── make_icons.py               # 生成 src-tauri/icons/*（无需 Pillow）
├── ui/                             # ============ 前端（纯静态）============
│   ├── index.html
│   ├── probe.html                  # 画廊交互的无头回归探针（npm run probe 会调它）
│   ├── styles/app.css
│   └── js/
│       ├── tauri.js                # 极简 Tauri v2 IPC 封装（invoke/listen）
│       ├── api.js                  # 后端门面：命令 + 图片 URL + 前端解码缓存
│       ├── geometry.js             # 缩放/平移/橡皮筋 纯数学
│       ├── chrome.js               # 控件层阈值/时长/缓动的唯一来源（写入 CSS 变量）
│       ├── theme.js                # 深浅主题：<html data-theme> 一处落地
│       ├── launch.js               # 「打开方式」的启动动画：来源矩形换算 + 中心兜底
│       ├── grid.js                 # 虚拟化 justified 画廊网格
│       ├── gestures.js             # 指针/滚轮/捏合/横滑 状态机
│       ├── strip.js                # 底部胶片条（窗口化缩略图列表 + 跳转）
│       ├── viewer.js               # 全屏画廊：轨道 + 三槽 + FLIP 转场
│       └── main.js                 # 入口装配
└── src-tauri/                      # ============ 后端（Rust）============
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs                 # 入口
        ├── lib.rs                  # 应用装配（插件 / 协议 / 命令）
        ├── error.rs                # 统一错误类型
        ├── model.rs                # 前后端数据模型
        ├── state.rs                # 图片注册表 + 两级缓存
        ├── scanner.rs              # 路径展开 + 自然排序
        ├── imaging.rs              # 解码 / 缩放 / 编码（含 EXIF 方向）
        └── protocol.rs             # img:// 异步自定义协议
├── tools/
│   ├── serve.js                    # 零依赖开发静态服务器（:1420）
│   ├── make_icons.py               # 纯标准库生成全部图标
│   ├── test_geometry.mjs           # 几何数学验证
│   ├── check_methods.mjs           # 跨文件检查未定义方法 / 失效导入
│   └── probe_gallery.mjs           # 画廊交互无头探针（桌面 + 窄屏各跑一遍）
├── package.json                    # 只含 @tauri-apps/cli
└── README.md
```

---

## 三、环境要求

| 平台 | 依赖 |
| --- | --- |
| 全部 | Rust ≥ 1.77.2（`rustup` 安装）、Node ≥ 18（仅用于 Tauri CLI 与开发服务器） |
| macOS | Xcode Command Line Tools（`xcode-select --install`） |
| Windows | MSVC 生成工具 + WebView2（Win10+ 自带） |
| Linux | `webkit2gtk-4.1`、`libayatana-appindicator3`、`librsvg2`、`libsoup3`（Debian/Ubuntu 见下） |

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev build-essential
```

## 四、运行与构建

```bash
cd PicShow
npm install          # 只装 @tauri-apps/cli（前端本身零依赖）

npm run dev          # 开发：启动静态服务器 + 桌面窗口，改完刷新即可
npm run build        # 打包：产出 dmg / msi / AppImage|deb|rpm
npm run check        # cargo check + 几何测试 + 方法/导入检查 + 主题令牌 + 手势状态机（改动后跑一遍）
npm run probe        # 画廊交互的无头回归探针（桌面 + 窄屏各 211 项断言）
npm test             # 验证缩放/平移/FLIP 的数学（纯 Node，无需浏览器）
npm run test:methods # 检查未定义方法与失效导入
npm run rust:check   # 只做 cargo check
npm run rust:test    # 跑后端单测
```

`npm run probe` 会自己拉起静态服务器并用无头浏览器跑 `ui/probe.html`，
断言轨道偏移、三槽轮转、横滑跟手与回弹、胶片条跳转、下拉关闭、点空白关闭、
滚轮缩放、响应式断点，以及**窗口尺寸变化后的重排**（网格几何与时序、滚动锚定、
预览区等比缩放与轨道偏移、胶片条重新居中）。浏览器路径可用 `PICTAURI_BROWSER` 覆盖
（默认找 macOS 上的 Edge）。

前端 `ui/` 是纯静态资源，无需打包器；`ui/js/*.js` 为原生 ES Module，
Tauri 直接加载 `../ui` 目录。

产物位于 `src-tauri/target/release/bundle/`。

> 想完全不用 npm 也可以：`cargo install tauri-cli --version '^2'`，然后
> `cd src-tauri && cargo tauri dev`（需另开终端跑 `node ../tools/serve.js`）。

## 五、交互一览

| 操作 | 效果 |
| --- | --- |
| 双击图片 | 在「适配窗口」与 2.6× 之间切换（以点击点为锚） |
| 滚轮 | 以光标为锚点连续缩放 |
| 触控板捏合 | 连续缩放（浏览器表现为 ctrl+wheel） |
| 触控板双指横向滑动 | **上一张 / 下一张**（未放大时）；详见下方小节 |
| 双指捏合 | 触摸设备上的连续缩放 + 双指平移 |
| 拖拽（放大态） | 平移，越界橡皮筋回弹，松手带惯性 |
| 下拉（未放大） | 跟手缩小，松手按速度/位移决定关闭或回弹 |
| **左右滑动（未放大）** | **跟手拖动切换**，松手按速度/位移决定翻页或回弹；到首尾只剩阻尼 |
| `←` `→` | 上一张 / 下一张 |
| `Home` / `End` | 第一张 / 最后一张 |
| `+` `-` `0` | 放大 / 缩小 / 适应窗口 |
| `Esc` | 返回网格；**从文件管理器打开时则退出应用**（回到访达 / 资源管理器） |
| 单击图片 | 唤醒 / 隐藏控件 |
| 单击图片外黑边 | 关闭 |
| 点击底部胶片条 | 直接跳到那一张 |
| `Ctrl/Cmd + O` | 选择图片（`+Shift` 选择文件夹） |

### 手势的优先级与「交界处」

手指数是**最先**起作用的条件，比方向、位移、速度都优先：

| 手指数 | 分支 | 判定方式 |
| --- | --- | --- |
| 1 根（未放大） | `swipe` / `dismiss` | 过 `TAP_SLOP=4` 后按首次移动方向二选一（`\|dy\| >= \|dx\|` → 下拉，否则横滑） |
| 1 根（已放大） | `pan` | 直接平移 |
| **≥ 2 根** | **`pinch`** | **无条件，不判轴向、不设阈值**：间距变了就是缩放，没变就是平移 |

也就是说**触摸设备上没有独立的「双指横滑切图」**——它曾经存在过（由一个
`updateTwoFinger` 统一分发），因为和捏合共用同一份 `scale/tx/ty`、观感不好已经
回退。现在触屏上的双指横向移动只会被当成捏合的一种形态，所以：

* 双指横向拉动 → 缩放（哪怕纵向位移为零）；
* 双指整体横移 → 平移（未放大时受橡皮筋阻尼，松手回弹），不会翻页；
* 双指下拉 → 平移，**不会**触发「下拉关闭」（要关闭请用单指）。

两个容易出问题的交界处已在 `gestures.js` 显式处理：

* **单指横滑中途追加第二根手指**：横滑就此作废，`beginPinch()` 会先把轨道
  `animateTrackTo(0)` 归位。不清的话 pinch 全程不写 `swipeX`，那截偏移会一直挂在
  轨道上，松手后画面停在「半张图」的位置，只能靠再翻一页或改窗口尺寸自愈；
* **捏合中途抬起一根**：由 `releasePinch()` 以剩下那根重建基准（以前这里调的是
  `beginPinch()`，而它对「只剩一根」是直接 `return` 的空操作）。少了这一步，
  `start` 会停在最初那根手指的落点，若活下来的正是另一根，下一次移动算出的 `dx`
  里会混进「两指间距」—— 画面瞬间跳几百 px。抬手后统一判为 `pan`，不交回
  `undecided`，免得缩回适配尺寸后随手一划就被判成翻页。

### 一次手势最多换一张

两条横滑入口（单指拖拽、触控板 wheel）共用同一条纪律：**一次「按下 → 抬起」
最多只翻一张**，想连续翻多张就必须抬起手再滑。

单指拖拽（`decideSwipeRelease`）在松手那一刻判「位移 **或** 速度」，命中任意一条
即成立，然后置起 `swipeFired` 作为本次手势的消费凭证：

| 判据 | 取值 | 依据 |
| --- | --- | --- |
| 位移 | 视口宽的 `22%` | 按比例而非固定 px，4K 屏与手机上才一致；再大就得把整张拖掉一半才肯翻 |
| 速度 | `0.45 px/ms`（≈60Hz 下一帧 27px） | 「甩」与「拖」的分水岭，再低慢慢移动也会被判成甩 |
| 速度触发的最小位移 | `28px` | 某些合成器一帧会丢出一个跨度很大的 `pointermove`，只看 Δx/Δt 会算出虚高的速度 |

没命中、走到首尾、或在切图动画（那一瞬间 `enabled=false`）里松手，一律走回弹——
轨道必须回到 `0`，否则会停在「两张图各露一半」的位置下不去。切图 / 展开 / 关闭动画
期间也**不接受新的 `pointerdown`**：那时 `go()` 会因为 `switching` 直接返回，若还让
这一次松手去走流程，结果同样是卡在半张图上。

触控板那条路的参数与解锁条件见上方「一次物理手势只翻一张」小节。

### 触控板双指横向滑动切换图片（仅 macOS）

Mac 的多指手势在派发给页面之前就被系统翻译成了 `wheel` / `ctrl+wheel` / `click`，
DOM 里**永远凑不出第二个 `pointerId`**。所以 `pointers.size >= 2` 那条 pinch 分支
在 Mac 触控板上根本进不去 —— 想在 macOS 上接住「双指横滑」，只能看 wheel 的
`deltaX`。这与 Apple 自己的语义一致（系统手势表里「在页面之间轻扫」正是双指左右），
因此这条改动被限定为：**只服务 macOS 触控板、只在全屏看图场景生效**。

判定条件依次是（`gestures.js::handleWheelHorizontal`）：

| 顺序 | 条件 | 不满足时 |
| --- | --- | --- |
| 1 | 不在右边缘 `48px` 死区内 | 让给 macOS 通知中心 |
| 2 | 不是 `ctrl+wheel`（触控板捏合 / 旋转） | 与捏合互斥，互不打扰 |
| 3 | **累积**位移 ≥ `10px` 后，两轴总和满足 `\|Σx\| > 1.7·\|Σy\|`（整串只判一次） | 交回纵向 = 缩放；判不出来之前两轴都不认 |
| 4 | 累计位移越过 `8px` 抖动带 | 只记账，画面不动 |
| 5 | 未放大（`scale <= 1.02`） | 放大态走横向平移（顺带补上以前完全没用的 `deltaX`） |
| 6 | 目标方向还有图 | 交给 `go()` —— 它自己会给到首尾的回弹 |
| 7 | 只有一张图时上述都不成立 | 静默（邻槽是空的，回弹会把黑边拉出来） |

第 3 条以前是「拿**第一个事件**定生死」：起手那两帧常常是 `dx=3 / dy=4` 这种噪声，
`|dx| > 1.7·|dy|` 判不出来，代码就落到 `else if (dy !== 0) → 纵向`，于是整段横滑被
当成缩放丢掉 —— 用户得再滑一次才有反应。功能上「时灵时不灵」，观感正是「第一次滑
不动、迟钝」。改看累积总和之后几帧之内必然判对，代价只是 10px 的位移（不到一帧）。

注意第 1 条排在 `enabled` 闸门**之前**：切换动画那 `300ms` 里 `go()` 会把手势冻结，
但同一串惯性尾巴并没有跟着停 —— 那段时间若完全不记账，动画一结束同一串尾巴会被
当成「早停息过」，白白多出一个可以翻页的窗口。

#### 跟手：画面停在手指当前的位置

每个 wheel 事件都把累计位移写进轨道的 `transform`（`1:1`，推出一屏之后走橡皮筋），
所以看到的就是手指当前的位置，而不是松手之后才跳一下。三个细节决定它是否真的跟手：

| 位置 | 做法 | 不做会怎样 |
| --- | --- | --- |
| `handleWheelHorizontal` | 写样式前 `if (this.anim) this.cancelAnim()` | Web Animations 的关键帧优先级高于内联样式：回弹动画没跑完时写进去的 `transform` 是被盖住的，表现为「头几帧纹丝不动，动画一结束又突然跳过去」 |
| 同上 | 一段手势只量一次视口宽（`s.viewW`） | `view()` 要读 `clientWidth`，而每个事件的前脚刚写过 `transform`，读布局会强制同步重排；120Hz 的流上按事件读就是卡顿 |
| 同上 | 跟手路径不逐事件 `emit()`；`onUserActivity` 走 `noteMotion()` 节流 | 每个事件都去 `classList.toggle` + 写 `textContent` + 重排空闲计时器，主线程白背一堆活 |

首帧另有两件事：方向一确定（越过抖动带）就回调 `onSwipeIntent` → `viewer.prefetchNeighbor()`
把目标那张的原图取回来，`preload()` 在 `onload` 之后还会显式 `img.decode()` 一次 ——
只下载不解码的话，真正的位图解码仍发生在第一次绘制的那一刻，正好卡在收尾动画的第一帧。

#### 连续切换：先接管上一次的收尾动画

上面那条 `cancelAnim()` 只管**本实例**起的动画（松手回弹）。切图的收尾动画跑在同一个
`track` 节点上、句柄在 viewer 手里，手势够不到它 —— 于是连续快切时出现一个致命窗口：
用户几乎总是**在上一次的收尾还没播完时**再次起手，那一段跟手位移写进 `style.transform`
后立刻被 WAAPI 的关键帧盖住，要等动画结束才突然生效。主观感受正是「连续切几张之后，
怎么滑都不跟手，按下去要等一下才动」。

现在跟手之前先向 viewer 要一次 `claimTrack()`（一段手势只要一次）：

| 步骤 | 做法 | 为什么 |
| --- | --- | --- |
| 1 | 读 `getComputedStyle(track).transform` 的 `m41` | 拿**视觉**当前位置，而不是代码里预写的终值 |
| 2 | `anim.cancel()` | 关键帧撤掉，内联样式才有话语权 |
| 3 | `rebalance()` + `trackOffset = -slotWidth()` | 这一格算作已经切完，槽位与偏移重新对齐 |
| 4 | `switching = false`、`g.enabled = true` | 新手势不必再陪着旧动画等一轮 |

返回的偏移记进 `wheelSwipe.base`，跟手写出的量恒为 `base + x`：

- `x` 是本段手势**自己**推出来的位移，仍然是翻页判定的唯一依据 —— `base` 不参与，
  否则「画面停在两张图中间」会被当成「用户已经推了半张」，一碰就翻；
- `base + x` 是**显示**位置，接管那一帧它正好等于刚才的视觉位置，所以画面不跳；
- 翻完一张（`lockWheelSwipe`）或回弹归位（`reboundWheelSwipe`）都把 `base` 交回
  `null`，下一段重新量。

#### 回弹被打断：位移不能丢

上面的接管解决的是**切图收尾动画**（句柄在 viewer 手里）。还有一类是本实例自己的
**回弹动画**（`animateTrackTo`，没达标的那一滑用它归位）—— 同样是 WAAPI 关键帧，
同样是「`cancel()` 的瞬间视觉掉回内联值」。而 `animateTrackTo` 一上来就把终值写进
内联样式了，所以掉回去的位置是**归位后的 0**，没走完的那段位移会整段消失、画面往回
跳一下：

```
慢推 90px（不到 22% 视口）→ 松手回弹
  ↳ 回弹走到 -26px 时用户又滑了一下（+30px）
     ✗ 旧：cancel() → 视觉掉回 0 → 再写 -30   ⇒ 画面从 -26 跳到 -30，丢了 26px
     ✓ 新：先读视觉 -26 → cancel → 写 -26-30 ⇒ -26 → -56，全程跟手
```

两处改动：

| 位置 | 改动 |
| --- | --- |
| `reboundWheelSwipe()` | `base` 由 `0` 改为 `null` —— 回弹的**终点**才是 0，被打断时画面并不在 0 |
| 跟手分支 | 掐掉 `this.anim` **之前**先 `trackVisualOffset()` 读一次视觉位置（同样是 computed transform），作为 `base` 的兜底来源 |

「掐之前先读」这一条对两类动画都成立，所以统一放在跟手分支的开头：`claimTrack()`
有返回值就用它（切图收尾），否则用读到的回弹中途位置。

`go()` / `jumpTo()` 另加了世代号（`switchGen`）：接管会让旧那次 `go()` 的 `await`
提前回来，它必须认得出「我已经不是当前那一次」，不能把新实例的闸门提前放开。

#### 什么时候结算：意图明确就立刻走

| 情形 | 判定 | 结算时机 |
| --- | --- | --- |
| 甩 | 累计 ≥ `48px` **且** 当前速度 > `1.1 px/ms` | **当帧**结算（不等流停） |
| 拖过半张 | 累计 ≥ 视口宽的 `50%` | **当帧**结算 |
| 慢慢拖 | 以上都不满足 | 流停下来（静默 `65ms`）后按单指的判据结算：位移 ≥ 视口宽 `22%`，或峰值速度 > `0.45 px/ms` 且累计 ≥ `28px` |
| 都不满足 | — | 回弹 `200ms` 归位 |

- `65ms` ≈ 60Hz 下 4 帧：触控板惯性尾巴的事件间隔 8~16ms，连丢 4 帧说明真的停了。
  上一版取 `120ms`，每次切图都白等两帧还有余 —— 这是「松手之后发木」的主要来源。
- 收尾动画时长按**剩余距离**缩放（`110ms ~ 300ms`）：跟手已经推掉大半时，剩下那点
  距离不该再用满 `300ms`；键盘 / 按钮的剩余距离恒为一屏，仍是完整的 `SWITCH_MS`。
- 速度用**当前值**判「甩」、用**峰值**判「慢慢拖之后松手」：峰值一旦出现就永远为真，
  拿它判当帧结算会让「慢慢拖出去再停住」也被当成甩。
- 判甩的门槛是 `1.1 px/ms`，比单指松手的 `0.45` 高一倍多：触控板中速滑动（0.4~0.8）
  很常见，沿用 `0.45` 会让大部分正常滑动在 48px 处就被判成甩 —— 画面只跟了 3% 就
  飞走，观感反而更不跟手。
- `dt`（事件间隔）夹在 `8~64ms`：下限 8ms 是 120Hz 触控板的最短帧距，夹住它才不会被
  「同一毫秒里挤进来的两个事件」算出虚高速度（慢拖偶尔被判成甩就是这么来的）。

#### 一次物理手势只翻一张

翻完立刻进入 `locked`，并把累积位移清零；之后全部 wheel 增量只记账、不再触发。解锁
看的是**这一串 wheel 是否真的结束了**，而不是倒计时（`wheelGestureRestarted`）：

| 出口 | 条件 | 说明 |
| --- | --- | --- |
| 1 | 反向**累积行程** ≥ `60px` | 惯性尾巴不会自己掉头；没抬手直接往回滑算新的一次 |
| 2 | 静默 ≥ `65ms` | 上一段确实停了，这是新的一推（鼠标滚轮的每一格也落在这一条上） |
| 上限 | 锁定超过 `1200ms` | 兜底，防止异常长的尾巴把用户永久锁住 |

这里**不能**再加两条已在历史上踩过坑的判据：

- 「单次增量达到本次峰值某个比例就算重新推了一把」：一次持续的手指推力里，每帧增量
  本来就在峰值附近，它会在手指还按着的时候就把锁解掉，紧接着尾巴里剩下的一点位移又
  攒够一次阈值 —— 「一次滑得远一点就连翻两张」正是这么来的；
- 「锁定必须硬撑满切换动画时长（`380ms`）」：它能挡住连翻，但会把「抬手之后再滑的
  第二段」一起吞掉，表现就是「第二下没反应」。现在动画没跑完的情况交给
  `settleWheelSwipe()` 的重试去等，不需要提前猜时间。

固定时长挡不住 macOS 的惯性尾巴（能持续一秒以上），「格」冷却到点后那串尾巴依然
会把累积重新攒满。换成「等尾巴停息」才是根治 —— 反向验证也印证了这一点：把
`wheelGestureRestarted` 换回固定 `320ms` 冷却，探针里的长滑用例立刻连翻。

此外 `600ms` 没有 wheel 事件则整份累积清空；切换图片会重建 `Gestures` 实例，累积
与锁定状态由 `wheelState` 交接过去 —— 否则一次「甩」会因为每个实例都重新累积一次
而连翻好几张。

交接有个必须配套的细节：**静默 ≥ `65ms` 就是新的一段**（与结算同一个刻度），所以
重新收到事件时要先把 `x` / `base` / `peakV` / `intent` 清掉，只留轴向与视口宽。
65~600ms 这段窗口正是「抬手之后马上又滑」的常态，不清的话第二段会带着上一段的
`base`（回弹后是 0）继续算 —— 既不再接管新动画（跟手错开一屏），`peakV` 也会让
慢拖被上一段的峰值判成「甩」。`check_wheel_swipe.mjs` 第 17、18 组钉住这两条。

两套回归各自负责一半：`tools/check_wheel_swipe.mjs` 用可控时钟跑纯时序（跟手度、
结算延迟、一次一张、接管偏移），`ui/probe.html` 第 17 节在真 DOM 上跑跟手位移与
切图结果（`17.14` 专门覆盖「连续切换中途起手」）。

#### 跟手度与帧率怎么验

1. **跟手度（毫秒级对齐）**：`npm run probe` 的 `17.1b` 逐事件比对
   `gestures.swipeX` 与累计手势位移，要求误差 < 1px —— 这一条不通过就说明「写进
   transform 的量」和「手指走的量」脱钩了。`tools/check_wheel_swipe.mjs` 第 1 组
   有同一个断言的纯 Node 版本。
2. **连续切换后的跟手**：`17.14a~e` 造出「上一次收尾动画跑到一半」的现场
   （真机上连续快切时这才是常态），断言接管后视觉位置连续、`switching` /
   `enabled` 立刻放开、接管偏移不参与翻页判定；`e` 连做三次，逐次比对
   `computed transform` 与「接管偏移 + 本段位移」，误差必须 < 2px。
   纯 Node 版在 `check_wheel_swipe.mjs` 第 14~18 组。
3. **结算延迟**：`check_wheel_swipe.mjs` 里用虚拟时钟量「最后一个事件 → 结算」的
   时间差：甩必须是**负数**（流没停就结算），慢拖必须落在 `60~70ms` 窗口内。
4. **帧率（真机）**：DevTools → Performance 录一段「双指横滑 → 切图」，看
   Frames 轨道有没有掉到 60fps（16.7ms）以下的长任务；或打开 Rendering →
   Frame Rendering Stats 边滑边看 FPS。关注两处：跟手阶段的主线程（不该有
   `Layout` / `Recalculate Style` 尖峰），以及切图瞬间的 `Image Decode`（应该在
   跟手阶段就完成，不该出现在收尾动画的第一帧）。
5. **连续快切手测**：连甩三下，每一下都该是「手指一动画面就动」，不能出现
   「前两下正常、第三下按下去发木」；松手后画面应立刻从当前位置收尾，而不是
   等一个整档动画。

#### 方向与「滚动方向：自然」开关

「向左划 = 下一张」在两种系统设置下都成立。DOM 的 `deltaX` 描述的是**内容的移动**
（`deltaX > 0` = 向右滚动 = 内容向左），只有在 macOS 的「滚动方向：自然」开启时才
等于手势方向；该开关被关掉的机器上要取相反数才是屏幕坐标系下的手势位移
（`wheelSign`，按 `webkitDirectionInvertedFromDevice` 判定 —— 该属性 true 表示
AppKit 已按用户偏好反转过一次，非标准、Chromium 上恒为 false，只按值判断）。

纵向滚轮缩放共用同一个系数，因此手感不变：两种设置下都是「手指向上 = 放大」。

三个前提被 `tools/check_trackpad.mjs` 钉住：WKWebView 的
`allowsBackForwardNavigationGestures`（默认 false，一旦打开，系统的「在页面之间
轻扫」会把双指横滑整个吃掉）与 `allowsMagnification` 必须保持关闭；前端也不应该
引入 `history.pushState` 路由去制造前进/后退栈。

已知边界：Magic Mouse 的一指横向同样产出 `deltaX`，按同一套规则处理即可；Windows
/ Linux 的精确触控板若将来要覆盖，只需确认目标平台上 `deltaX` 的量纲
（`normalizeWheel` 已按 `deltaMode` 归一）。

## 六、架构要点

### 1. 图片数据的唯一出口：`img://` 自定义协议

不走 IPC 返回 base64——那会让体积膨胀 33%，还必须在主线程拼字符串再解码，大图上必卡。
自定义协议可以直接当 `<img src>` 用，解码与光栅化都在 webview 的独立线程完成，主线程只管合成。

```
img://localhost/placeholder/<id>      24px 模糊占位（几百字节）
img://localhost/thumb/<id>?s=360      网格缩略图（JPEG q82）
img://localhost/full/<id>[?max=4096] 原图直出；超 4000 万像素时降采样
```

协议用 `register_asynchronous_uri_scheme_protocol` 注册，解码在独立线程，
并用 3 个令牌的信号量限流——解码是 CPU 密集活，无限制并发会把 UI 线程饿死。

### 2. 两级缓存

* **内存**：`moka` 按字节计权的 LRU，上限 256MB；
* **磁盘**：`{appDataDir}/thumbs/{hash}.jpg`，键里含 `mtime`，图片改了自动失效；
* **webview**：响应带 `Cache-Control: immutable`，回看不产生任何请求。

原图不做缓存——文件系统本身就是最好的缓存。

### 3. 为什么网格用「等高行」而不是方形九宫格

方形格子需要 `object-fit: cover` 裁图，缩略图里显示的是「原图被裁掉的一块」，
从缩略图展开到全屏时两端形状对不上，FLIP 转场就会跳。
等高行布局让每张缩略图完整保留原图比例，展开动画才能做到像素级连续。

### 4. FLIP 转场

```
打开：把大图先摆到缩略图矩形（translate + 等比 scale），再动画回适配位置
关闭：反向，从当前变换动画回缩略图矩形
```

因为缩略图与适配矩形的宽高比一致，缩放是等比的，视觉上就是「缩略图自己长大了」，
而不是两张图交叉淡入淡出。关闭时若正处于下拉状态，动画会从**当前跟手位置**继续，不回跳。

### 5. 画廊：一条横向轨道 + 三个复用槽位

全屏查看器不是「一张 slide 播切换动画」，而是一条轨道里串着三张 slide：

```
┌──────┬──────┬──────┐
│ prev │  cur │ next │     track 的 translateX = -cur × 视口宽
└──────┴──────┴──────┘
```

* **跟手**：手指按下就实时拖动相邻那张进画面，松手只是把剩下的位移播完
  （位移 > 22% 视口宽，或速度 > 0.45px/ms 且位移 > 28px 即翻页）。
* **不闪**：切完把 DOM 顺序轮转一格（`appendChild` / `insertBefore`），
  基准偏移同步改回中间槽，两者同一帧生效 —— 只有视口外那个槽需要换内容。
* **不变暗**：两张图始终并排、各自完全不透明，不存在交叉淡入淡出把中间帧压暗的问题。

三种变换各写各的元素，互不打架：

| 元素 | 承载 |
| --- | --- |
| `track` | 横向槽位偏移（滑动切换） |
| 当前 `slide` | 缩放 / 平移 / 下拉关闭 / 展开与收起的 FLIP |

> 事件统一挂在 `track` 上（它铺满视口），所以「点图片外关闭」改为按坐标判断
> 是否落在图片矩形内，而不是靠背景层接收点击。

### 6. 胶片条：只渲染窗口，不渲染全部

一个文件夹几千张图，DOM 节点必须恒定。胶片条只挂载当前项 ±40 张，
用绝对定位 + 撑开的容器宽度伪造出完整滚动条；窗口随当前项滑动增量增删。
缩略图沿用与网格**同一个** URL，跳转时底图直接命中缓存，不会先白一下。
请求延迟 40ms 发出，快速拖动时大量请求在发出前就被作废。

### 7. 橡皮筋与惯性

内部维护两套平移量（见 `gestures.js` 顶部注释）：
`rawX/rawY` 是累加基准，`tx/ty` = clamp(raw) + rubberband(超出量)。
分开存是为了避免橡皮筋位移被逐帧重复累加、越拖越偏。

### 8. 渐进加载

网格与全屏查看器共用**同一个**缩略图 URL（`THUMB_SIZE` 由行高推导），
所以点开大图时底图必然命中缓存，立刻显示；原图到位后再淡入覆盖。
超过 4000 万像素的图会自动请求降采样版本，避免 webview 解码爆内存。

### 9. 窗口尺寸变化：三个组件各自重算，分工明确

| 组件 | 入口 | 做什么 |
| --- | --- | --- |
| 网格 | `grid.js` `onResize()` | 按新宽度重算每行张数 / 行高 / 间距，**把所有已挂载格子的几何重写一遍** |
| 预览 | `viewer.js` `onResize()` | 重算三个槽的 `--w/--h`、重算轨道基准偏移、把平移收敛回新边界（保留缩放倍率） |
| 胶片条 | `strip.js` `onResize()` | 跨断点时换尺寸，并重新居中当前项 |

空闲自动隐藏与指针事件的配合要点：

* **移动鼠标必须能唤醒**（`gestures.js` 的 `noteMotion()`，节流到 8 次/秒）。
  空闲时光标是 `cursor: none`，若只有按下才能唤醒，用户会以为鼠标失灵。
* **指针还按着时绝不进入 idle**（`viewer.js` 的 `busy` 判断）。
  空闲会给控件加 `pointer-events: none`，而此刻控件可能正持有指针捕获，
  结果 `pointerup` 永远收不到，手势状态卡死。
* 失焦 / 最小化 / 切程序由 `window.blur` → `Gestures.abort()` 兜底清理。

三条共同约定，缺一条就会出问题：

1. **尺寸为 0 直接跳过。** 窗口最小化 / 元素隐藏时 `clientWidth` 是 0，
   照算会得到「每行一张、行高拉满」的垃圾布局，还会把 `--w/--h` 写死成 0。
2. **回调合并到一帧。** 连续拖窗口时 ResizeObserver 每帧都回调，
   重排是 O(n)，必须用 rAF 合并；且**先 cancel 再 schedule**——
   只用「已排过就 return」的写法，一旦某帧的 rAF 被丢掉，句柄会永远挂着，
   之后的 resize 就再也不响应了。
3. **重排只改几何，不动内容。** 已挂载的格子走 `refresh()` 只重写
   `width/height/transform`，不重新请求缩略图，所以拖动窗口时不会闪。

网格重排还会**锚定滚动位置**：记住重排前贴在视口顶部的是哪一项，
重排后把它放回原处，否则行高一变，用户正看着的那排就被推走了。

---

## 七、从文件管理器打开 PicShow

### 怎么触发

| 平台 | 入口 | 由什么配置生成 |
| --- | --- | --- |
| macOS | 访达右键 → 打开方式 → PicShow（也可在「其他…」里选中并勾「始终以此方式打开」） | `tauri.conf.json` 的 `bundle.fileAssociations` → `Info.plist` 的 `CFBundleDocumentTypes` |
| Windows | 资源管理器右键 → 打开方式 → 选择其他应用 → PicShow | 同上，由 NSIS / MSI 写入注册表 |
| Linux | 文件管理器右键 → 打开方式 | 同上，写进 `.desktop` 的 `MimeType=` |
| 任意平台 | `picshow <图片路径>`（命令行自测） | `commands.rs` `argv_targets()` |

> 只有**打包并安装**后才会出现在右键菜单里：`npm run build`，把生成的
> `PicShow.app` 拖进 `/Applications`（Windows 跑安装包）。macOS 首次启动后
> LaunchServices 才完成登记；没出现就 `lsregister -R /Applications/PicShow.app` 手动触发。

### 装载什么

后端 `scanner.rs::scan_siblings()` + `commands.rs::build_launch()`：

1. 对目标文件所在目录做**非递归**扫描，只收图片文件（子目录里的不算）；
2. 按文件名**自然排序** —— `IMG_2` 排在 `IMG_10` 之前、忽略大小写，
   与访达 / 资源管理器的「按名称」一致（否则翻页顺序和用户在管理器里看到的完全不同）；
3. 目标文件在这个列表里的下标，就是打开后停留的位置；
4. 一次选了多个文件时不重排，按文件管理器给出的顺序展示，停在第一张。

### 界面形态

* **不经过主界面**：这条入口有自己的分支 `bootLaunch()` —— 它从不调用
  `showWindow()` 那条常规路径，因此窗口不会先以浏览界面的样子出现。"窗口一闪
  而过"的根因就是「先显示、再切预览」，这里从根上不作为：`boot()` 里
  `pending?.items?.length` 为真时走 `bootLaunch()` 并 `return`，
  `await api.showWindow()` 压根轮不到；
* **后端还有一道闸门**：`window_ready` 在「这次是被要求打开图片的启动 **且**
  那份请求还没被取走」时直接返回，**拒绝点亮**。前端那道判断解决的是「我决定
  了没有」，这道解决的是「谁都能调 `showWindow()`」—— 包括出错兜底在内的任何
  一条路径，都别想在预览启动里把主界面画出来；
* 顺序是 **先定形态与尺寸 → 再点亮 → 最后才播动画**（`prepare_launch_window`）：
  趁窗口还藏着把原生标题栏摘掉、把尺寸铺到目标屏幕可用区，所以亮起的第一帧
  大小就是终态，没有「小窗口 → 最大化」的那一下位移；
* 顶栏、缩略图网格、空状态一律 `display: none`，画面直接铺满整个窗口；
* 窗口自动最大化，系统窗口标题跟随文件名（`IMG_2.png — PicShow`，用于程序切换器 / Dock）；
* **没有系统原生标题栏**：进入沉浸式前由后端关掉窗口装饰
  （`set_immersive_chrome` → `set_decorations(false)`），画面铺满整个窗口。
  系统画的那条标题栏配色/毛玻璃跟着系统外观走，跟纯色预览面永远对不齐，
  而且它不在前端控件层里 —— 控件隐藏时它还会杵在那儿；
* `Esc` / 关闭按钮 / 点画面外黑边 = 关闭并**退出应用**，回到文件管理器；
* 页面里那条 `.viewer-bar` 就是**唯一标题栏**：显示 `文件名` 与
  `序号 / 总数`（如 `IMG_2.png  2 / 3`），右侧是缩放工具，空白处可拖动窗口；
* 2.2s 空闲后**标题栏、左右按钮、胶片条一起淡出**，动一下鼠标 / 按任意键立刻一起回来。

### 启动意图在第一行就判定（否则一定会有竞态）

「主界面一闪而过」最顽固的一种，不是顺序写反了，而是**判定时机太晚**：

| 平台 | 文件路径从哪来 | 什么时候能判定 |
| --- | --- | --- |
| Windows（关联打开）/ Linux（`.desktop` 的 `%F`） | 进程参数 argv | 进程第一行，比创建窗口还早 |
| macOS（访达「打开方式」） | Apple Event（`RunEvent::Opened`） | 要等事件循环转起来 —— 可能与首屏加载赛跑 |

于是分两层处理：

1. **能早就早**：`lib.rs::run()` 的第一行就调 `argv_targets()`，赶在
   `build()`（它会创建窗口并让 webview 开始加载）**之前**判定。这一层在
   Windows / Linux 上是决定性的，一次都不用等；
2. **不能早就给它一个绝对截止点**：macOS 那条慢通道由 `AppState::started`
   记下进程启动时刻，前端首屏就绪但还没拿到请求时，按
   `launch_decision_budget()`（预算 300ms，**从进程启动时刻起算**，不是「从
   现在起再等 300ms」）再问几次。首屏加载慢的机器来问时预算早已耗尽，常规
   启动一点都不被拖慢；万一前端快得离谱，也只是多藏了剩下的几十毫秒 —— 窗口
   本来就是藏着的。

两层之外还有两处保险：

* **同一请求不会被处理两遍**：请求会同时走「事件」与「待取件」两条通道，
  `claimLaunch()` 保证只有第一条认领成功，否则就是「打开 → 关掉 → 再打开」
  的一次实打实的闪烁；
* **冷启动遇到事件早到**：`enterImmersive()` 会看 `windowShown` —— 窗口还没
  点亮就说明是冷启动，转去走 `bootLaunch()`（它会趁窗口藏着定好形态再点亮），
  否则动画就播给一个隐身窗口看了。

### 开场动画：从那一格长出来

**来源矩形怎么来的。** 没有一个桌面平台会把「你刚点了哪一格」告诉被启动的进程
—— LaunchServices / ShellExecute / xdg-open 都不给。于是取近似：

1. 后端在**收到文件的那一刻**（光标还停在那张图上）记录光标位置；
   `deliver_launch()` 每次派发前先把旧值作废，保证新鲜；
2. `ui/js/launch.js::launchOriginRect()` 把它换算成视口坐标系里一个 96px 的小矩形；
3. 取不到（命令行启动、拖太久才问、多显示器时那张图在另一块屏上）→ 返回 null，
   退化为**屏幕中心 0.8 倍**的中心放大（要求 3 的兜底）。

坐标换算有两个坑，都实测出来过，写在这里免得有人再踩：

* **不能查 `AppHandle::cursor_position()` 之外还要查 `scale_factor()`**：后者是
  阻塞等回执的 getter，命令可能跑在主线程上 → 自己和自己死锁。所以物理→CSS
  的除法交给前端的 `devicePixelRatio`。
* **别信 `window.screenX/screenY`**：无边框最大化窗口上它给的是离谱的过期值
  （实测 1080，整整一块屏的高度）。用 `screen.availLeft/availTop` —— 启动路径
  一定会最大化到可用区，于是「可用区左上角」就是窗口左上角。

**动画本身。** `viewer.js::openLaunch()` → `zoomStart()`：起点矩形经
`mapBoxToRect()` 算出 FLIP 的起始 transform，再叠加 `opacity 0 → 1`；时长
`OPEN_MS = 340ms`、缓动 `OPEN_EASE`（`.22,1,.36,1`）与关闭、切换共用。
**不阻塞首帧**：几何来自 `items` 里的宽高元数据，`fill()` 是同步的，`open()`
一返回就已经在动了；来源坐标那一问与「点亮窗口」并行发出，不排在前面。

### 标题栏与预览面的统一

五条要求各自落在哪：

| 要求 | 做法 | 位置 |
| --- | --- | --- |
| 背景一致 | 标题栏与预览背景引用**同一个变量** `--viewer-bg`，不加渐变、不加毛玻璃；`stage` 把标题栏那一条（`--chrome-top`，54px / 窄屏 50px）**恒定让出来**，所以那条带子里永远只有背景 —— 色差与分界无从产生，图片也不会被压在标题栏下 | `app.css` `.viewer-bar` / `.viewer-stage` |
| 联动隐藏 | 三者同属 `.viewer.is-idle` 一条规则，隐藏时收 `opacity` + `visibility` | `app.css` |
| 联动显示 | 鼠标移动（`gestures.js` `noteMotion()`）、指针按下、滚轮、点击、**任意按键**都走同一个 `bumpChrome()` | `viewer.js` |
| 状态同步 | 阈值/时长/缓动只在 `chrome.js` 定义一份，写进 `--chrome-fade` / `--chrome-ease`；JS 计时与 CSS 过渡不可能各改一半 | `chrome.js` + `app.css` |
| 过渡平滑 | 三者只改 `opacity` / `visibility`，不动几何；`stage` 上下留白恒定 ⇒ 显隐不产生布局跳动，也不遮挡画面 | `app.css` |

### 主题：默认深色 + 手动切换 + 持久化

三条规则，按优先级：

1. 用户手动选过 → 永远用他选的（写进 `localStorage` 的 `picshow.theme`），
   下次启动直接生效、**覆盖默认深色**；
2. 没选过 → 深色，**不看系统外观**；
3. 存储不可用（隐私模式等）→ 退到深色，本次会话内的切换记在内存里。

**故意不跟随系统**：一旦接上 `prefers-color-scheme`，默认就不再是「深色」而是
「随缘」，而且要多付一笔代价——浏览器先按系统色画第一帧、JS 再改回来，那一下
就是肉眼可见的浅色闪烁。不跟随，反而两边都省了。

**不闪的实现**：`index.html` 头部有一段**同步内联**脚本，排在 `<link>` 之前、
不 defer / 不 module / 不 await，因此第一帧就带着正确的 `data-theme`；它还把底
色临时写在 `<html>` 上，连 CSS 还没到那几十毫秒的白底也一并压住
（`theme.js` 启动后摘掉，交还给 CSS）。这段脚本排在样式表之后这一点由
`check_tokens.mjs` 守着。

**入口两个**：顶栏右侧按钮（浏览器界面）和预览标题栏按钮（沉浸式下顶栏是
`display:none`，那里够不着）。图标用太阳 / 月亮表示「点下去会变成什么」，
纯 CSS 按 `[data-theme]` 切换，所以 JS 还没落地时图标也不会指错动作。

**配色统一维护**：全部颜色在 `app.css` 的令牌表里，深色块与浅色块**必须一一
对应**——`npm run check` 里的 `check_tokens.mjs` 会做两件事：组件里出现任何
硬编码十六进制就报错（避免深浅混杂），两侧令牌数量不一致也报错（避免某套主题
漏配某个变量）。零散组件因此不可能被落下。对比度则由画廊探针第 13.4 节按 WCAG
AA 实测（正文 4.5:1、图形 3:1，深浅两套都算）。

用户选完之后，前端会把结果同步给原生窗口一次（`set_window_theme`），否则会
出现「界面是浅色、弹出的文件选择器是深色」。这条通道是**单向**的：后端不再反
过来告诉前端该用什么主题。

### 键盘焦点：窗口显示之后、首图落地之后

「打开方式」进来的窗口常常要**点一下画面**方向键才肯工作。三个原因叠在一起，
缺一个都复现不出来：

1. 窗口是 `visible: false` 隐藏启动的（为了不闪白底）。隐藏窗口上调用
   `set_focus()` 会被平台**直接忽略** —— tao 的实现第一条判断就是 `isVisible`；
2. `maximize()` 在 macOS 上是一次 zoom 动画，会把刚抢到的 key window
   **又让出去**；
3. 图片还在解码时就落焦点，用户按下的第一个方向键落在「什么都没画出来」的
   画面上，观感就是「按了没反应」。

所以顺序被钉成：**show → maximize → set_focus**，然后前端在首图落地之后再补
一次（`focus_window`）。具体分工：

| 谁 | 做什么 |
| --- | --- |
| `commands::prepare_launch_window` | show → maximize → **再** `set_focus()`（顺序由 `check_boot.mjs` 守着） |
| `commands::focus_window` | 单独一条命令，供前端在图片落地后调用；窗口还没点亮时直接返回（要了也白要） |
| `Viewer#focusWhenReady()` | 等当前槽的底图或原图**谁先到算谁**（带 4s 超时兜底），再把 DOM 焦点给预览 |
| `Viewer#focusView()` | `#viewer` 带 `tabindex="-1"`（程序可聚焦、不进 Tab 遍历），`focus({preventScroll:true})` |
| `main.js::handOverFocus()` | 上面两步的合体，排在启动分支最后；顺便把 `document.hasFocus()` 打到终端（仅 `PICSHOW_DEBUG=1`） |

常规入口**不受影响**：网格焦点只在非沉浸式分支上给
（`if (!body.classList.contains('is-immersive')) grid.focus()`），
沉浸式那条路上网格是 `display:none`，抢这一步只会把焦点从预览上挪走。

### 支持的图片格式范围

**会出现在「打开方式」列表里的**（`bundle.fileAssociations` 显式声明）：

`jpg` `jpeg` · `png` · `gif` · `webp` · `bmp` · `ico` · `tif` `tiff`

**应用内部还能解码**（拖到窗口里、打开文件夹、命令行传入都可以）：

除上面那些外还有 `jpe` `jfif` `tga` `dds` `ff` `qoi` `hdr` `exr` `ppm` `pgm` `pbm` `pnm`

**明确不支持**：HEIC / HEIF、AVIF、各类 RAW（CR2 / NEF / ARW…）、PDF、SVG。
`LSItemContentTypes` 里刻意**没有**写 `public.image`——写了 PicShow 就会出现在
HEIC 的打开方式菜单里，点进来却解不开，是纯粹的负体验。
传入不支持的格式时后端直接返回「不支持的图片格式：xxx」，不进预览。

### 首 / 末张怎么处理

**默认：禁用（不循环）。**

* 到首张时「上一张」按钮置灰，到末张时「下一张」置灰；
* 键盘 / 滑动到头时给一次轻微横向回弹（`viewer.js` `nudgeAtEdge()`），
  不做「点了没反应」的假死。

想改成循环：把 `main.js` 的 `enterImmersive()` 里加上 `viewer.setLoop(true)`，
或直接调 `viewer.setLoop(true)`。循环时用淡入跨过首尾，不会让轨道飞过整条画廊。

### 目录里只有这一张图

* 集合长度 = 1 ⇒ 底部胶片条与左右按钮都隐藏（`no-strip`），画面完整占满；
* 标题栏显示 `lonely.png  1 / 1`；
* `←` `→` 无效果（回弹），`Esc` 仍然退出应用。

### 验证步骤

自动化：

```bash
npm run rust:test   # 后端：同目录扫描 4 项（自然排序 / 不递归 / 只有一张 / 不支持的格式）
npm run probe       # 前端：两种窗口尺寸各 211 项（… / 15 启动后的键盘焦点 / 16 双指状态机交界 / 17 触控板横向切换（跟手度 / 结算延迟 / 一次一张 / 方向 / 边界 / 回弹打断））
npm run check       # cargo check + 几何断言 + 方法/导入 + 主题令牌 + 启动路径与焦点（check_boot.mjs）+ 触控板前提（check_trackpad.mjs）+ 一次手势一张（check_wheel_swipe.mjs）
```

真机（右键菜单只有**打包安装后**才有）：

```bash
npm run build
cp -R src-tauri/target/release/bundle/macos/PicShow.app /Applications/
```

1. 访达里挑一张 jpg → 右键 → 打开方式 → PicShow；
2. 应当：**整个过程不出现浏览界面**（没有顶栏与缩略图网格那一帧），也**没有**
   系统原生标题栏（无交通灯），窗口直接最大化，中央就是那张图；
3. 开场是从**你右键的那一格**放大到全屏的（约 340ms，带透明度渐变）。想看清
   就把 `viewer.js` 的 `OPEN_MS` 临时改大，再连拍几张；
4. 标题栏显示 `文件名` 与 `3 / 12` 形式的序号，背景与画面浑然一色；
   **不用先点画面**，`←` `→` 直接在同目录图片间切换，到首末张时对应按钮置灰
   并有回弹（`PICSHOW_DEBUG=1` 会打出 `[focus] hasFocus=true active=viewer`）；
5. 静止 2.2s → 标题栏、左右按钮、胶片条**同时**淡出；动一下鼠标 / 按任意键 → 同时回来；
6. `Esc` → 应用退出，回到访达；
7. 换一个只有一张图的目录再来一次：无胶片条、无左右按钮、计数器 `1 / 1`；
8. 对照实验：不带任何参数启动（`PICSHOW_DEBUG=1 …/picshow`）→ 仍是老样子，
   主界面正常出现（这项保证「打开方式」之外的入口没被波及）。

主题（不需要打包，直接跑 debug 二进制即可）：

1. 冷启动 → 界面直接是深色，加载过程中不出现浅色帧；
2. 顶栏右侧按钮（太阳图标）点一下 → 浅色，全站同时变（顶栏 / 空状态 / 预览面
   / 滚动条），此时再点「打开图片…」弹出的文件对话框也是浅色 —— 那份配色不听
   CSS，是靠 `set_window_theme` 同步过去的；
3. 退出重启 → 仍然是浅色（偏好覆盖默认深色）；
4. 再点一次（月亮图标）回到深色并重启 → 深色；
5. 想体验「首次使用」：把会话里的偏好用
   `localStorage.removeItem('picshow.theme')` 清掉即可，存储位置由 WebKit 自己
   管理，不必去动 Application Support 目录。

不想打包也能验证同一条装载链路（命令行与 Windows / Linux 的关联打开同源）：

```bash
node tools/serve.js &                       # dev 模式要它；release 二进制不需要
PICSHOW_DEBUG=1 src-tauri/target/debug/picshow ~/Pictures/某目录/IMG_2.jpg
# [picshow] 打开外部文件：3 张，停在第 2 张（IMG_2.jpg）
# [picshow] 启动来源坐标：1234, 567（96px）   ← 拿不到就打「退回屏幕中心」
# [picshow] 前端取走打开请求：3 张，第 2 张
# [picshow] 沉浸式：已去掉原生标题栏
# [picshow][前端] [focus] hasFocus=true active=viewer   ← 焦点已落在预览上
```

注意这条路径**不会**打印「前端首屏就绪」——那行属于常规入口的 `window_ready`。
这里点亮窗口的是 `prepare_launch_window`（它还顺带把 maximize 与改标题做了）。

`PICSHOW_DEBUG=1` 还会把**前端**的未捕获异常一起打到终端 —— webview 的
`console` 不会出现在终端里，没有它就是「界面没反应」这类无从下手的报告。

### 两条通道，缺一不可

| 场景 | 走哪条 | 为什么 |
| --- | --- | --- |
| 冷启动（应用被这次打开唤起） | 前端 `take_launch_target()` 主动取 | 后端在 webview 执行第一行 JS **之前**就把事件发出去了，那时没有监听者，事件直接丢进黑洞 |
| 已运行时又打开一张 | `picshow://open-file` 事件 | 前端早已就绪，事件立刻到达，直接换集合并跳转 |

两条共用同一个入口 `commands::deliver_launch()`：既发事件，也存一份「待取件」，
取完即清空（避免重复打开）。

---

## 八、快捷键与手势常量

集中在 `viewer.js` 与 `gestures.js` 顶部，常见调整：

```js
// gestures.js
const RUBBER = 140;                   // 橡皮筋最大位移
const DISMISS_DISTANCE_RATIO = 0.2;   // 下拉关闭位移阈值（视口高度比例）
const DISMISS_VELOCITY = 0.55;        // 下拉关闭速度阈值（px/ms）

// chrome.js —— 标题栏 / 按钮 / 胶片条共用，改一处三者同时生效
const CHROME_IDLE_MS = 2200;          // 控件自动隐藏时间（JS 侧计时）
const CHROME_FADE_MS = 300;           // 显隐动画时长（同时写入 CSS --chrome-fade）
const CHROME_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'; // 写入 CSS --chrome-ease
const CHROME_RETRY_MS = 300;          // 到期时若指针还按着，隔多久重试
// 首末张是否循环：默认 false（禁用按钮 + 回弹），改 true 则首尾相接
const DOUBLE_TAP_SCALE = 2.6;         // 双击放大倍率
const SWITCH_MS = 300;                // 轨道切换动画时长
const JUMP_MS = 200;                  // 胶片条远距离跳转的淡入时长

// gestures.js
const MOTION_WAKE_MS = 120;           // 指针移动唤醒控件的最小间隔

// gestures.js
const SWIPE_DISTANCE_RATIO = 0.22;    // 横滑翻页位移阈值（视口宽比例）
const SWIPE_VELOCITY = 0.45;          // 横滑翻页速度阈值（px/ms）
const SWIPE_MIN_PX = 28;              // 只靠速度翻页时的最小位移
const SWIPE_EDGE_DAMP = 0.26;         // 到首尾时横滑的阻尼

// strip.js
const WINDOW_RADIUS = 40;             // 胶片条窗口半径（DOM 节点数 = 2R+1）
const ITEM_W = 78;                    // 胶片条缩略图宽度（窄屏 54）

// api.js
const GRID_ROW_H = 210;               // 网格行高（缩略图尺寸随之变化）
```

---

## 九、常见问题

**Q：浏览器里打开 `localhost:1420`，点击按钮报「无法调用命令：pick_images」？**

这是**预期行为**，不是 bug。`localhost:1420` 是 `beforeDevCommand` 起的静态服务器，
供 **Tauri 内部的 webview** 加载前端用；普通浏览器里没有 `window.__TAURI_INTERNALS__`
注入，所有 IPC 命令都不可用。

正确用法：运行 `npm run dev`，**在弹出的桌面窗口**中使用 PicShow。
（此时浏览器里那个页面会自动禁用所有入口并显示提示，避免误点。）

> 若 `npm run dev` 之后没有窗口弹出：多半是 Rust 还在编译（首次约数分钟），
> 或者上一次的实例还在后台跑着。先 `pkill -f picshow` 再重试。

**Q：窗口一片黑 / 没内容？**
开发模式依赖 `tools/serve.js`。确认 `http://localhost:1420` 可访问；若端口被占用，改 `PICTAURI_PORT` 与 `tauri.conf.json` 的 `devUrl`。

**Q：自定义协议图片加载不出来？**
检查 `app.security.csp` 里是否包含 `img-src ... img:`，以及 `capabilities/default.json` 是否含 `core:event:default`。

**Q：选择了图片 / 文件夹后界面没反应，状态栏显示「没有找到支持的图片」？**
说明后端其实已经正常扫描并推送了事件，但前端拿到的事件数据形状不对。本项目手写的 `listen`（`ui/js/tauri.js`）必须把 Tauri 桥接脚本传入的**完整事件对象** `{ event, payload, id }` 透传出去，再由 `api.js` 取 `event.payload`。如果在这里多包一层，`payload` 就会变成整个包装对象，`payload.items` 恒为 `undefined`——事件确实到了，数据却永远是空的。改事件回调形状时务必先跑一次 `diag` 式的往返验证。

**Q：切换上一张 / 下一张时会「闪一下」？**
现在的架构从根本上避开了它（轨道 + 三槽，见「架构要点 5」），但有三条经验别丢：

1. **别让 `display:grid` 自动排布多个图位。** 曾经 stage 里同时挂着新旧两张
   `.slide`，grid 把它们排进**两个隐式行**——新图先在错位的一行出现，旧图被
   `remove()` 后又瞬间跳回中间。凡是要让多个图位重合，必须显式声明单格
   （`grid-template: 1fr / 1fr` + `grid-area: 1 / 1`）。
2. **不要同时给两张图做对称的淡入淡出。** 旧图 `1→0`、新图 `0→1` 在黑底上叠加，
   中间帧的合成亮度只有 ~75%，肉眼就是一次「变暗再变亮」。轨道方案里两张图
   并排且各自不透明，天然没有这个问题。
3. **切换时立刻起拉原图**（不等动画结束）。动画只动 `transform`，跑在合成器
   线程上，解码抢不走它的帧；换来的是切换一结束画面就是清晰的。

**Q：HEIC / AVIF 打不开？**
`image` crate 默认不支持这两种格式。需要的话在 `Cargo.toml` 里加 `image = { version = "0.25", features = ["avif"] }`（AVIF 会引入 dav1d，编译较慢），HEIC 则需额外的解码库。

**Q：想改网格密度？**
改 `api.js` 里的 `GRID_ROW_H`，缩略图请求尺寸会同步推导，保证网格与全屏底图命中同一份缓存。

**Q：触屏上胶片条划不动？**
`touch-action` 会与祖先求交集。若把 `touch-action: none` 挂在 `.viewer` 上，
胶片条的 `pan-x` 会被一起吃掉，触屏就划不动缩略图列表了。
现在 `none` 只挂在 `.viewer-track`（手势区），胶片条单独用 `pan-x`。

**Q：图片底部被胶片条压住？**
`.viewer-stage` 的下边界是 `inset: 0 0 var(--strip-h) 0`，stage 高度已经让出了
胶片条；`viewer.view()` 取的也是 `stage` 的尺寸，所以平移边界与居中都对得上。
改胶片条高度只需改 `--strip-h`（窄屏断点里是 72px），不要另写一套居中逻辑。

**Q：最大化 / 还原 / 拖拽改变窗口大小后，缩略图错乱、预览图不跟着缩放？**
两类原因，都已修好，改动时别改回去：

1. **网格只给「新挂载」的格子写几何。** 虚拟化网格靠 `mount()` 写
   `width/height/transform`，`update()` 原来只对**不在** `mounted` 里的索引调
   `mount()`。于是重排之后，视口里那一屏格子仍然留着旧宽度和旧位置，只有滚出去
   再从池子里复用回来才会更新——表现就是缩略图重叠、留白、溢出到容器外。
   现在 `update()` 对已挂载的索引一律走 `refresh()` 重写几何（不动图片请求）。
2. **预览区只在 `window.resize` 里改尺寸，且顺手把缩放重置成 100%。**
   现在改用 `ResizeObserver` 观察 `.viewer-stage`（还能覆盖 CSS 断点变化、
   DPI 变化），并通过 `Gestures.refit()` 保留缩放倍率、只把平移夹回新边界。

另外三处容易忽略的坑：尺寸为 0 时必须跳过重算；rAF 合并要先 cancel 再 schedule；
网格重排要锚定滚动位置（否则行高一变，正在看的那排就被推走）。

**Q：控件自动隐藏之后，界面卡顿、鼠标像动不了？**
这是空闲计时器与指针事件的两处冲突，都已修好：

1. **只有「按下」类事件能唤醒控件。** 原实现里 `onUserActivity` 只挂在
   `pointerdown` / `wheel` / `dblclick` 上，`pointermove` 不唤醒。而空闲状态
   下 CSS 又会把 `cursor` 设成 `none` —— 于是用户移动鼠标时屏幕上
   **什么都不会发生**，光标也看不见，主观感受就是「鼠标动不了、界面卡死」，
   必须点一下才能恢复。现在 `onPointerMove` 会节流唤醒（约 8 次/秒，
   避免每个鼠标事件都去续期计时器）。
2. **`pointer-events: none` 打断了指针序列。** 空闲时给 `.nav-btn` 等控件加
   `pointer-events: none`，若此刻指针正被它们捕获，浏览器会隐式释放捕获并
   改派 `pointercancel`，`pointerup` 就再也不会来了。`Gestures.pointers` 里
   残留的 pointerId 会让之后**每一次** `pointermove` 都通过 `pointers.has(id)`
   走进拖拽分支并 `preventDefault()` —— 画面一直「粘」在鼠标上。
   现在空闲计时器到期时先检查 `busy`（pointers 是否为空），按着就过
   `IDLE_RETRY_MS` 再试，绝不在交互中途抽掉 `pointer-events`。

**Q：为什么控件隐藏时还要收掉 `visibility`？**
只把 `opacity` 降到 0 并不会让元素退出合成树。胶片条窗口半径 40，最多
81 个节点常驻 DOM，待加载项的 shimmer 动画用的是 `background-position` ——
**这个属性无法交给合成器**，每项每帧都要在主线程重新光栅化。结果是
「界面看着已经空了，主线程还在满负荷刷渐变」，这正是空闲隐藏之后反而变卡
的直接原因。所以空闲规则同时收掉 `visibility`（延迟到淡出结束）并
`animation-play-state: paused`；`.nav-btn` 上的 `backdrop-filter: blur(10px)`
同理，隐藏后也不再参与合成。

**Q：`npm run probe` 里为什么要手动调 `onResize()`？**
headless 浏览器在页面加载完之后基本不再产生渲染帧，`ResizeObserver` 的回调
（只在渲染帧里投递）和 `requestAnimationFrame` 都可能永远不触发。所以探针
先断言三个组件确实都挂了 ResizeObserver，再把 rAF 临时换成同步执行、手动调用
它们的 `onResize()` —— 与 RO 回调是完全同一个入口，去重判断、合并、重排都会真实执行。
同理，**不要断言 CSS transition 的计算值**（比如隐藏后的 `visibility`），
它同样要靠渲染帧推进；改成直接校验样式表规则，防的是「有人把规则删掉」这种回归。

> 顺带一提：某些受限环境（CI 容器、终端沙箱）里 Chrome 起不来自己的沙箱，
> 会直接崩退出，探针报「未跑完」看着像页面卡住。探针脚本已带 `--no-sandbox`
> （只用于加载 127.0.0.1 上的自有页面）。

**Q：访达「打开方式」里没有 PicShow？**

1. 必须在 **打包并安装之后** 才有：`npm run build`，再把 `PicShow.app` 拖进
   `/Applications`。`npm run dev` 跑起来的是未登记的调试进程，系统不会把它列进
   打开方式菜单。
2. 确认声明真的进了 bundle：
   `plutil -p /Applications/PicShow.app/Contents/Info.plist | grep -A6 CFBundleDocumentTypes`
   应当看到 jpg / png / gif / webp / bmp / ico / tiff 七组。
3. 刚拷进去没刷新：登出再登录，或手动
   `lsregister -R -f /Applications/PicShow.app`。
4. HEIC 不在列表里是**故意的**（解不开，见第七节的格式范围）。

**Q：为什么窗口最大化要放在 Rust 的 `show()` 之后？**

对**隐藏**的窗口调 `maximize()` 不可靠 —— macOS 会在窗口真正显示时把尺寸再改回去
（实测时有时无，是最难复现的那一类 bug）。现在 `commands::window_ready()` 里
先 `reveal_main_window()` 再 `maximize()` + `set_title()`，冷启动与「已运行再打开」
两条路径共用一个 `apply_immersive_window()`。

**Q：命令行传文件没反应？**

`argv_targets()` 会丢掉以 `-` 开头的参数和磁盘上不存在的路径。
另外 macOS 的「打开方式」根本不走 argv（走 Apple Event / `RunEvent::Opened`），
所以命令行只用于自测与 Windows / Linux。自测请用 debug 二进制，并且 dev 模式下
它是加载 `http://localhost:1420` 的（要先起 `node tools/serve.js`）。
