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
| **图片墙 / 预览两个物理窗口** | `tauri.conf.json` 两个 window + `commands.rs` `open_viewer` / `close_viewer` | 见第七节：几何永不互相影响，退出预览必然回到原样 |
| 画廊式缩略图网格 | `grid.js` | justified 等高行 + 虚拟化滚动 |
| 双击 / 滚轮 / 键盘 / 捏合缩放 | `gestures.js` | 统一锚点缩放，连续无级 |
| 拖拽平移 + 越界回弹 | `geometry.js` `settle()` | iOS 风格橡皮筋阻尼 |
| 连续转场 | `viewer.js` `open()` / `close()` | FLIP：来源矩形 ↔ 适配矩形（跨窗口传的是屏幕坐标） |
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
│   ├── index.html                  # 图片墙页面（跑在 main 窗口）
│   ├── viewer.html                 # 预览页面（跑在 viewer 窗口，物理上另一个 webview）
│   ├── probe.html                  # 画廊交互的无头回归探针（npm run probe 会调它）
│   ├── exit_probe.html             # 退出路径探针：加载真实 viewer-main.js + 假 IPC（npm run test:exit）
│   ├── styles/app.css
│   └── js/
│       ├── tauri.js                # 极简 Tauri v2 IPC 封装（invoke/listen）
│       ├── api.js                  # 后端门面：命令 + 图片 URL + 前端解码缓存
│       ├── geometry.js             # 缩放/平移/橡皮筋 纯数学
│       ├── async.js                # 带兜底的异步：withTimeout / nextFrames / waitFor（rAF 会停！）
│       ├── chrome.js               # 控件层阈值/时长/缓动的唯一来源（写入 CSS 变量）
│       ├── theme.js                # 深浅主题：<html data-theme> 一处落地
│       ├── launch.js               # 跨窗口几何：来源矩形折成屏幕坐标 / 折回视口 + 中心兜底
│       ├── grid.js                 # 虚拟化 justified 画廊网格
│       ├── gestures.js             # 指针/滚轮/捏合/横滑 状态机
│       ├── strip.js                # 底部胶片条（窗口化缩略图列表 + 跳转）
│       ├── viewer.js               # 全屏画廊：轨道 + 三槽 + FLIP 转场（两个窗口共用）
│       ├── main.js                 # 图片墙入口（main 窗口）
│       └── viewer-main.js          # 预览入口（viewer 窗口）
└── src-tauri/                      # ============ 后端（Rust）============
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/
    │   ├── default.json            # 图片墙窗口的权限（能力按窗口授权）
    │   └── viewer.json             # 预览窗口：收事件 + 拖动行内标题栏
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
│   ├── check_window_split.mjs      # 两个窗口的几何「终身只读」（Rust 里不许出现 set_size 等）
│   ├── check_boot.mjs              # 启动路径：主界面该不该露面、焦点落在哪
│   ├── check_preview_entry.mjs     # 预览入口唯一 + 跨窗口几何对称
│   ├── check_unload.mjs            # 预览层的卸载出口与每一段 await 的硬超时
│   ├── check_exit.mjs              # 退出路径探针的驱动（假 IPC）
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
npm run check        # cargo check + JS 语法 + 几何 + 方法/导入 + 主题令牌 + 启动路径 + 预览入口 + 预览层卸载 + 手势状态机
npm run probe        # 画廊交互的无头回归探针（桌面 + 窄屏两种窗口尺寸各跑一遍）
npm run test:exit    # 退出路径探针（真实 main.js + 假 IPC，69 项）
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
| 触控板双指横向滑动 | **连续切换上一张 / 下一张**：一屏一张，甩得越远跨得越多（未放大时）；详见下方小节 |
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

### 一次手势最多换一张（仅单指拖拽）

单指拖拽（`decideSwipeRelease`）守着一条纪律：**一次「按下 → 抬起」最多只翻一张**，
想连续翻多张就必须抬起手再滑。松手那一刻判「位移 **或** 速度」，命中任意一条即
成立，然后置起 `swipeFired` 作为本次手势的消费凭证：

| 判据 | 取值 | 依据 |
| --- | --- | --- |
| 位移 | 视口宽的 `22%` | 按比例而非固定 px，4K 屏与手机上才一致；再大就得把整张拖掉一半才肯翻 |
| 速度 | `0.45 px/ms`（≈60Hz 下一帧 27px） | 「甩」与「拖」的分水岭，再低慢慢移动也会被判成甩 |
| 速度触发的最小位移 | `28px` | 某些合成器一帧会丢出一个跨度很大的 `pointermove`，只看 Δx/Δt 会算出虚高的速度 |

没命中、走到首尾、或在切图动画（那一瞬间 `enabled=false`）里松手，一律走回弹——
轨道必须回到 `0`，否则会停在「两张图各露一半」的位置下不去。切图 / 展开 / 关闭动画
期间也**不接受新的 `pointerdown`**：那时 `go()` 会因为 `switching` 直接返回，若还让
这一次松手去走流程，结果同样是卡在半张图上。

**触控板 wheel 不再共用这条纪律。** 它是一条带惯性尾巴的连续滚动流：一屏 = 一张，
甩得越远跨得越多；流停下来时仍**沿用上面这张表**判「最后那段不足一屏的余数要不要
补完一张」，所以慢拖一张、轻甩一张的手感没有变。详见下方「连续滚动流」小节。

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
| 6 | 目标方向还有图 | 累计位移跨过一整屏就交给 `onWheelAdvance` 同步换一张；到头则夹到一小段阻尼 |
| 7 | 只有一张图时上述都不成立 | 静默（邻槽是空的，回弹会把黑边拉出来） |

第 3 条以前是「拿**第一个事件**定生死」：起手那两帧常常是 `dx=3 / dy=4` 这种噪声，
`|dx| > 1.7·|dy|` 判不出来，代码就落到 `else if (dy !== 0) → 纵向`，于是整段横滑被
当成缩放丢掉 —— 用户得再滑一次才有反应。功能上「时灵时不灵」，观感正是「第一次滑
不动、迟钝」。改看累积总和之后几帧之内必然判对，代价只是 10px 的位移（不到一帧）。

注意第 1 条排在 `enabled` 闸门**之前**：吸附补完最后一张时 `go()` 仍会把手势冻结
一小段，但同一串惯性尾巴并没有跟着停 —— 那段时间若完全不记账，动画一结束同一串
尾巴会被当成「早停息过」，白白多出一个可以翻页的窗口。

#### 跟手：画面停在手指当前的位置

`t.x` 是一个**连续位置**：每个 wheel 事件把增量累加进去、写进轨道的 `transform`
（`1:1`），看到的就是手指当前的位置，而不是松手之后才跳一下。跨过一整屏时上层把
三槽同步轮转一格并扣掉那一屏，累计里剩下的永远是不足一屏的余数，视觉位置一帧
不断 —— 位移因此可以无限往一个方向延伸，不必被三槽的数量夹住。三个细节决定它
是否真的跟手：

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
- 一段流结算完（`clearWheelProgress`，无论补张还是回弹）都把 `base` 交回
  `null`，下一段重新量。

#### 回弹被打断：位移不能丢

上面的接管解决的是**切图收尾动画**（句柄在 viewer 手里）。还有一类是本实例自己的
**回弹动画**（`animateTrackTo`，没达标的那一滑用它归位）—— 同样是 WAAPI 关键帧，
同样是「`cancel()` 的瞬间视觉掉回内联值」。现在它把**起点**写进内联样式、用
`fill:'forwards'` 让关键帧接管（见下方「无缝排列与落位」），掉回去的位置是
**这一段的起点**而不是归位后的 0；没走完的那截位移照样会丢、画面往回跳一下：

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

#### 什么时候结算：只在流停下来时吸附一次

连续推进期间**不结算**。`handleWheelHorizontal` 每帧只做两件事：累进位移、必要时同步
换页，然后排一个 `WHEEL_GESTURE_END_MS`（65ms）的定时器；每个新事件都会把它重排，
只有真的没有新事件了才由 `settleWheelSwipe` 收尾：

| 情形 | 判定 | 结算 |
| --- | --- | --- |
| 余数够远 | `\|swipeX\|` ≥ 视口宽 `22%` | 补完到下一张：`onWheelSwipe` → `go(fromWheel)`，从当前跟手位置接着播 |
| 还在甩 | `\|swipeX\|` ≥ `28px` 且本段峰值速度 > `0.45 px/ms` | 同上 |
| 都不满足 | — | 回弹 `200ms` 归位 |

`fromWheel` 是这次动画优化新增的**轻量收尾**：整段流用的是同一个 `Gestures`
实例，吸附那一下不重建手势、不关 `enabled`、不落闸，只把变换目标 `retarget()`
到新的当前槽；收尾固定 `WHEEL_LAND_MS`（180ms，短于键盘切图的 `SWITCH_MS`
300ms）。否则松手那一下节奏会突然慢下来，就是「顿挫」，紧跟着的下一段横滑
也会因为等动画闸门而发木。

- **为什么不再「当帧结算」**：旧实现翻一张就落锁，惯性尾巴只记账不跟随，于是必须
  靠「拖过半张 / 甩到 48px」提前把结局定下来，否则画面会停住发木。连续模型里画面
  全程跟手，提前决定结局反而会插进一段收尾动画、打断后面还在走的尾巴 —— 那正是
  「连续快滑卡顿、反馈延迟一张张累积」的来源。现在整段流只有**一次**收尾，延迟
  不随跨过的张数增长。
- `65ms` ≈ 60Hz 下 4 帧：触控板惯性尾巴的事件间隔 8~16ms，连丢 4 帧说明真的停了；
  人抬手再落下至少几百毫秒。结算与「新的一段」共用这一个刻度，分开会留出一段
  「既没结算完、又不许重来」的窗口。上一版取 `120ms`，每次切图都白等两帧还有余。
- 收尾动画时长分三档：单指横滑按**剩余距离**缩放（`110ms ~ 300ms`），跟手已经推掉
  大半时不用再走满 `300ms`；键盘 / 按钮的剩余距离恒为一屏，用完整的 `SWITCH_MS`；
  触控板 wheel 流结束的吸附固定 `WHEEL_LAND_MS`（180ms）—— 整段流都是 1:1 跟手，
  最后只补不足一屏的余数，再按键盘节奏播就会在松手那一下「顿」住。
- 速度用**峰值**判「还在甩」：末尾那几个惯性事件的样本太微弱，拿末值会几乎永远
  不达标。`dt`（事件间隔）夹在 `8~64ms`：下限 8ms 是 120Hz 触控板的最短帧距，夹住
  才不会被「同一毫秒里挤进来的两个事件」算出虚高速度。

#### 连续滚动流：一屏一张，不再落锁

旧实现把「一段流最多结算一次」当成硬性纪律：翻完立刻 `locked`，累积清零，剩下的
惯性尾巴和用户的余推只记账、不跟随、不结算，解锁要等 `wheelGestureRestarted` 判
「这一串真的结束了」。它当年是为了挡「滑得远一点就连翻两张」，但代价正是这次要
根治的三个症状：**惯性阶段的输入被丢弃（不跟手）**、**三槽把位移夹在一屏内
（画面停住）**、**每翻一张就 `go()` 一次（收尾动画 + `attachGestures()` 重建 +
`switching` 闸门，延迟一张张攒起来）**。

现在换成一条连续位置：

| 环节 | 做法 |
| --- | --- |
| 连续推进 | `handleWheelHorizontal` 里 `while (\|base + x\| >= 视口宽)`：调 `onWheelAdvance(direction)` → `viewer.advanceBy()` 同步轮转三槽、推进索引、把接管偏移归零；`x` 扣掉一屏后继续跟手 |
| 不重建 | `advanceBy()` 不播收尾动画、不设 `switching`、不 `attachGestures()`；只用 `Gestures.retarget()` 把变换目标指向新的当前槽（事件仍挂在 `track` 上） |
| 内容供给 | `prefetchNeighbor(direction, PREFETCH_RUN)` 沿方向预热多张；连续推进期间**不拉当前项原图**（槽里的低分辨率底图先顶着），流结束 `onWheelRest` 才补给最终那一张 —— 结算帧不撞解码。相邻几次推进的预热窗口彼此重叠，`api.js::preload()` 按 URL 复用同一份已解码结果（FIFO 限容、失败可重试），否则同一张 4K 图会在一段流里被解码十几遍，预热自己反倒成了跟手阶段的卡顿源；缩略图与原图**都要预热**（`fill()` 画的是缩略图）。`api.js` 另留一份「已解码 DOM 图片池」（`takeDecoded()`），`viewer.adoptSlotImage()` 把预热好的 `<img>` 节点**直接换进槽**，不走「设 src → 请求 → 解码」—— 邻图滚进视口那一帧就有像素，不会露出空白，这正是「下一张没紧跟着移入」的落点 |
| 首尾与异常 | `onWheelAdvance` 返回 false（到头）时把累计夹到 `WHEEL_OVERSCROLL_RUBBER`（90px）阻尼，既不无限堆、也不把空槽整屏拉进来；单个事件最多推进 `WHEEL_ADVANCE_MAX`（8）张 |
| 状态一致性 | 索引、标题/计数、胶片条高亮、按钮状态、控件唤醒都随 `advanceBy` 同步更新 |

#### 无缝排列与落位：起点先落地，两端都不跳

「相邻图片在滑动过程中按手势位移平滑跟随、始终无缝排列」靠的是三槽轨道的
**连续位置**：`t.x` 每跨过一整屏就同步轮转一格、扣掉那一屏继续 1:1 跟手，
视觉一帧不断；「达到切换条件自然落位、取消平滑回弹」则靠下面几条 WAAPI
提交纪律：

| 位置 | 做法 | 不这样做的症状 |
| --- | --- | --- |
| `viewer.animateTrack()` / `Gestures.animateTrackTo()` | **起点**先写进 inline style，动画 `fill:'forwards'`，终值在 `finished` 回调里提交回 inline 再 `cancel()` | 旧写法把**终点**预写进 inline、用 `fill:'none'`：WAAPI 关键帧要等下一帧才采样，中间那一帧显示的是 inline 的终点 —— 每次收尾都先「闪到终点、再弹回起点」，跑完又「闪回起点」，正是顿挫 / 跳变 / 闪烁 |
| 同上 | 提交前先认 `this.trackAnim !== anim` / `this.anim !== anim` | 动画被 `claimTrack()` 或下一段跟手掐掉时，把刚接管的画面又拽回终点，是一次位置跳变 |
| `advanceBy()` → `rebalance({ view, skipTransform: true })` | 连续推进时视口只量一次往下传，跳过静止基准那条 transform 写入 | 每跨一张都 `appendChild` 后再读 `clientWidth` 是一次强制同步重排；同一帧两次 transform 写入纯属多余 —— 120Hz 流上就是掉帧 |
| `viewer.fill()` / `adoptSlotImage()` | 预取阶段已 `decode()` 好的 `<img>` 直接换进槽；`fill()` 默认不量视口，由 `advanceBy` 传 `{ view }` | 设 src 要重走「请求 → 解码 → 绘制」，轮转进视口那一两帧露空白；空槽也去读 `clientWidth` 是白背一次布局 |
| `handleWheelHorizontal()` | 推进循环后把异常增量夹到不足一屏（`viewW - 1`） | 单个异常大 delta 撞到 `WHEEL_ADVANCE_MAX` 上限时，累计里还压着十几屏，`wheelFollowOffset()` 会把它压到槽位之外、甚至落到反方向 |

两条历史踩坑仍然成立，只是换了约束方式：

- **不能靠「单次增量 ≈ 峰值」判重新起手**：一次持续推力里每帧增量本来就在峰值
  附近，那种判据会在手指还按着的时候把位移重算一遍。现在跨一张就实打实要走满
  一整屏，行程与张数一一对应，不存在「攒够阈值又多翻一张」。
- **不能靠固定冷却 / 锁满动画时长**：它挡不住能持续一秒以上的惯性尾巴，却会把
  「抬手之后再滑的第二段」一起吞掉。现在没有锁，静默 ≥ `65ms` 就是新的一段
  （与结算同一个刻度），`clearWheelProgress()` 把 `x` / `base` / `peakV` 清干净，
  轴向与视口宽留着，起手不必再攒 10px 判一次轴。

此外 `600ms` 没有 wheel 事件则整份状态清空。吸附补完最后一张走 `go(fromWheel)`：
**不重建** `Gestures`、不关 `enabled`，只 `retarget()` 到新当前槽，收尾用固定的
`WHEEL_LAND_MS`；`wheelState` 的交接因此只服务单指 / 键盘 / 按钮那条会重建实例的
老路径。`check_wheel_swipe.mjs` 第 17~19 组钉住「峰值速度不跨段残留」
「抬手 100ms 后再滑重新接管」这两条交接细节。

三层回归各自负责一段：`tools/check_wheel_swipe.mjs` 用可控时钟跑纯时序（跟手度、
跨过的张数与行程成比例、流结束吸附、无逐张收尾、首尾阻尼、异常增量上限与
「异常增量夹到不足一屏」、接管偏移），`ui/probe.html` 第 17 节在真 DOM 上跑
跟手位移与切图结果（`17.14` 专门覆盖「连续切换中途起手」，`17.1f3` 核对落位
动画的起点/终点两帧与 `fill:'forwards'`），`tools/check_trackpad.mjs` 钉住
「旧锁定写法不得回归」、「`advanceBy` 不播动画 / 不重建手势」、「多张预热按 URL
去重」，以及第 11 组的「起点落地 + forwards + finished 提交」「`WHEEL_LAND_MS`
轻量收尾」「`takeDecoded` 邻槽无缝换源」「一次量视口 / 跳过静止位写入」
「异常增量夹取」。

#### 跟手度与帧率怎么验

1. **跟手度（毫秒级对齐）**：`npm run probe` 的 `17.1b` 逐事件比对
   `gestures.swipeX` 与累计手势位移，要求误差 < 1px —— 这一条不通过就说明「写进
   transform 的量」和「手指走的量」脱钩了。`tools/check_wheel_swipe.mjs` 第 1 组
   有同一个断言的纯 Node 版本。
2. **连续切换后的跟手**：`17.14a~e` 造出「上一次收尾动画跑到一半」的现场
   （真机上连续快切时这才是常态），断言接管后视觉位置连续、`switching` /
   `enabled` 立刻放开、接管偏移不参与判定；`e` 连做三次，逐次比对
   `computed transform` 与「接管偏移 + 本段位移」，误差必须 < 2px。
   纯 Node 版在 `check_wheel_swipe.mjs` 第 15~20 组。
3. **结算延迟不累积**：`check_wheel_swipe.mjs` 里用虚拟时钟量「最后一个事件 →
   吸附」的时间差，慢拖落在 `60~70ms` 窗口内；第 21 组断言整段流里
   `onWheelSwipe` 一次都没被逐张调用、推进全部发生在事件当帧
   （`advanceLatency() <= 0`）、流结束才发一次 `onWheelRest`。
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
打开：把大图先摆到来源矩形（translate + 等比 scale），再动画回适配位置
关闭：反向，从当前变换动画回来源矩形
```

因为来源矩形与适配矩形的宽高比一致，缩放是等比的，视觉上就是「那一格自己长大了」，
而不是两张图交叉淡入淡出。关闭时若正处于下拉状态，动画会从**当前跟手位置**继续，不回跳。

来源矩形现在要**跨窗口**送来（图片墙与预览是两个物理窗口，见下面第 9 条）：
主窗口把那一格折成物理像素的屏幕坐标，预览窗口减掉自己的原点折回视口。送到
就用它，没送到就退化为屏幕中心 0.8 倍 —— 仍是同一次放大，只是少了「从哪儿
来」这条信息。

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

### 9. 两个物理窗口：图片墙与预览

```
main 窗口   index.html + main.js        常规窗口   从不进全屏、几何从未被写过
     │  api.openViewer(index, origin, immersive)
     ▼  后端：AppState::current（有序列表）+ ViewerRequest
viewer 窗口 viewer.html + viewer-main.js  全屏       关闭即 destroy()，下次进入重建
     │  picshow://viewer-closed { index }
     └──→ 主窗口把网格滚到用户最后看的那一张
```

为什么值得多开一条窗口：见第七节「退出预览后窗口停在最大化」—— 同一个窗口
在「浏览态 ↔ 全屏态」之间来回切，就一定会经过 AppKit 那套以 `saved_style` /
`zoomed` 记账的还原机制，那条路是堵死的。分家之后图片墙那条窗口**一次全屏都
没进过**，于是「退出预览要还原成什么」这个问题根本不存在。

两个 webview 之间没有共享的 JS 上下文，所以状态一律经后端中转：

| 方向 | 什么 | 走哪条 |
| --- | --- | --- |
| 主 → 预览 | 图片集合（有序）、当前索引、来源矩形、是否 immersive | `open_viewer`（存待取件）+ `picshow://viewer-goto`（事件），预览那边由 `viewer_boot` / 监听认领 |
| 预览 → 主 | 关掉时用户在看第几张 | `close_viewer` → `picshow://viewer-closed` |

「事件 + 待取件」两条并存是为了盖住冷启动竞态 —— 与主窗口那条
`take_launch_target` 是同一个套路，谁先到谁认领，只处理一次。

代价是几何要过一趟折算（见第七节），以及 `Viewer` 不能再顺手问网格：关闭动画
的落点因此改为**开场时记下的那一格**（`originRect`）。

**多一条窗口不止是改 `tauri.conf.json`。** Tauri 2 的能力是按窗口授权的：
不在任何一条 `windows` 列表里的窗口，连 `core:event:default` 都拿不到 ——
`event.listen` 被拒，预览就永远收不到会话。这个缺陷在静态检查、探针、
`cargo check` 里**全是绿的**，只有真机跑起来才暴露（本项目的 E2E 就是这么
发现的）。所以 `src-tauri/capabilities/` 里有一条独立的 `viewer.json`，
`tools/check_boot.mjs` 盯着「每条窗口都被某条能力覆盖」。

### 10. 窗口尺寸变化：三个组件各自重算，分工明确

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

这条入口与「先开 PicShow 再选图」跑的是**两条不同的窗口**：

```
图片墙  →  main 窗口（index.html + main.js）      常规窗口，从不进全屏
预览    →  viewer 窗口（viewer.html + viewer-main.js）  全屏，专门为看片存在
```

* **主界面不在这条路上**：`bootLaunch()` 是 `boot()` 里独立的一支 —— 它不调
  `showWindow()`，而是把会话交给后端 `open_viewer`，由后端去唤起**预览那条
  窗口**。"窗口一闪而过"的根因是「先显示、再切预览」，这里从根上不作为：
  `pending?.items?.length` 为真时走 `bootLaunch()` 并 `return`，
  `await api.showWindow()` 压根轮不到；主窗口这次**全程保持隐藏**；
* **后端还有一道闸门**：`window_ready` 在「这次是被要求打开图片的启动 **且**
  那份请求还没被取走」时直接返回，**拒绝点亮**主窗口。前端那道判断解决的是
  「我决定了没有」，这道解决的是「谁都能调 `showWindow()`」—— 包括出错兜底在
  内的任何一条路径，都别想在预览启动里把主界面画出来。3 秒兜底那一下还要先
  问「预览起来了没有」（`viewer_up`），否则预览已经开着了它还会再把主界面
  拽出来；
* 首条预览窗口是 `tauri.conf.json` 里**静态声明**的第二个窗口（`visible: false`
  起步）。它退出时会被**真正销毁**，下一次进入由 `ensure_viewer_window()` 按同一
  份配置重建一条 —— 任意时刻最多只有一条 viewer，不堆积也不泄漏；
* 顺序是 **先切全屏（不摆尺寸）→ 量布局 → 才播动画**（`viewer_ready`）：
  窗口还藏着就直接切进全屏，由 AppKit 自己把窗口带出来 —— 亮起的第一帧大小
  就是终态，没有「小窗口 → 放大」那一下位移；
* 窗口随即进入**操作系统级全屏**（不是最大化）：Windows 盖住任务栏，macOS
  把窗口搬进独立 Space 并收起菜单栏与 Dock；
* 预览自己的页面里**没有顶栏 / 网格 / 空状态** —— 那些属于图片墙，住在
  `index.html` 里。画面直接铺满整屏；
* 系统窗口标题跟随文件名（`IMG_2.png — PicShow`，用于程序切换器 / Dock）；
* **窗口样式在每条窗口诞生时设定一次**（`FullSizeContentView` + 透明标题栏 +
  隐藏标题文字），之后一次都不改：启动时遍历 `NSApp.windows()` 把两条窗口设好；
  预览重建时再跑一次同一个幂等函数，只设那条新窗口。运行时绝不改动已存在窗口
  的样式，进出预览只剩 `set_fullscreen` 一个动作；
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
* **预览那边的同款竞态**：预览 webview 可能比主窗口先加载完，也可能晚。所以
  后端同样备了「事件 + 待取件」两条通道（`picshow://viewer-goto` +
  `viewer_boot`），前端「先挂监听、再告诉后端我能收了（`viewer_listening`）」，
  正好卡在缝里的那次请求由待取件补上 —— 与主窗口那条 `take_launch_target`
  是同一个套路。

### 开场动画：从那一格长出来

**来源矩形怎么来的。** 没有一个桌面平台会把「你刚点了哪一格」告诉被启动的进程
—— LaunchServices / ShellExecute / xdg-open 都不给。于是取近似：

1. 后端在**收到文件的那一刻**（光标还停在那张图上）记录光标位置；
   `deliver_launch()` 每次派发前先把旧值作废，保证新鲜；
2. `ui/js/launch.js::launchOriginScreenRect()` 把它折成**物理像素、屏幕坐标系**
   里 96px 见方的小矩形；
3. 取不到（命令行启动、拖太久才问）→ 返回 null，预览窗口那边退化为
   **屏幕中心 0.8 倍**的中心放大（要求 3 的兜底）。

**跨窗口那一趟。** 预览是独立的物理窗口，它全屏落在哪块屏取决于主窗口在哪块
屏，两个 webview 的视口原点各不相同。所以几何只能折到共同的桌面坐标系里传递，
到那边再减掉自己的原点折回视口（`viewportRectFrom`）：

```
主窗口：DOM 矩形 + 自己的 outer_position × dpr  →  物理像素屏幕矩形
                                                    ↓（经后端中转）
预览：  （物理像素屏幕矩形 − 自己的 outer_position）÷ dpr  →  视口矩形
```

这一趟有两个坑，都实测出来过，写在这里免得有人再踩：

* **不能在命令里查 `scale_factor()`**：它是「发消息给事件循环 → 阻塞等回执」
  的 getter，命令跑在主线程上时自己和自己死锁。所以两端都用**物理像素**，
  乘除自然抵消，谁都不去问它；
* **别信 `window.screenX/screenY`**：全屏窗口上它给的是离谱的过期值（实测
  1080，整整一块屏的高度）。窗口原点是后端 `outer_position` 给的（`window_origin`
  / `viewer_ready`），拿不到就按 (0,0) 折，绝不硬猜。

```
                      ┌─ 图片墙点击 ─┐
                      │  图片墙回车 ─┤
                      │  打开方式  ──┘
                      ↓
          api.openViewer(index, origin, immersive)   ← 主窗口：只有这一条发起口
                      ↓  （后端 open_viewer / picshow://viewer-goto）
          openSession(session)                       ← 预览窗口：只有这一条接收口
                      ↓
          openLaunch(index, rect) → openFullscreen() → open()
                      ↓
          zoomStart() → slot.animate(...)
```

**动画本身。** `viewer.js::openFullscreen()` → `zoomStart()`：起点矩形经
`mapBoxToRect()` 算出 FLIP 的起始 transform，再叠加 `opacity 0 → 1`；时长
`OPEN_MS = 380ms`、缓动 `OPEN_EASE`（`.32,.72,0,1`）。**不阻塞首帧**：几何来自
`items` 里的宽高元数据，`fill()` 是同步的，`open()` 一返回就已经在动了。

#### 起点要对得上那一格：三个各自让起点偏掉的坑

分家之后这条动画横跨两个窗口，于是「起点偏一点」变得很容易，而它的表现是
**编译得过、跑得出、只是从错的地方长出来**。三处都实测出来过：

| 坑 | 现象 | 修法 |
| --- | --- | --- |
| **坐标系不对齐** | stage 给顶栏让出 `--chrome-top`、给胶片条让出 `--strip-h`，来源矩形却是**视口坐标**，直接拿去跟 `view()` 算，起点整体偏一个顶栏的高度 | `localRect()`：用之前先把视口坐标折成 stage 坐标 |
| **缩放取错了方向** | 网格那一格是 `object-fit: cover` **裁**出来的，按宽度对齐（contain 的思路）算出的起点框比那一格矮一截或窄一截 —— 开头那一帧和刚点的缩略图对不上，看着就是「先跳一下再长大」 | `mapBoxToRect()` 按 **cover** 取缩放（两方向各算一次取大值） |
| **溢出没裁** | cover 之后画面会溢出那一格一点，尺寸就对不齐 | 转场期间给 stage 加 `clip-path: inset(...)`，从那一格动画到 `inset(0)` —— 裁完第一帧与缩略图**逐像素相同** |

另外两处「闪」：

* **首帧闪一下全尺寸** —— 动画对象创建之后要等一帧才真正开跑，那一帧元素显示
  的是它自己的基础样式（全尺寸、不透明），于是开场先闪一帧「画面已经到位」，
  再缩回去重新长大。开场那两条动画用 `fill: 'backwards'` 填满「开跑之前」。
* **空框长大再突然填上** —— `open()` 刻意不等图片（为了首帧就能动），而预览
  是另一个 webview、图片缓存是空的，那张图必然要现取。于是由宿主在**切全屏
  那段躲不掉的等待里并行**预热首图（`viewer.preload()` + `img.decode()`），
  等待上限 400ms：取不到也照常开场，退化成空框长大。

**等布局要等得准。** 全屏不是同步生效的，按旧尺寸算起点会让画面从错误的方向
长出来。以前前端拿 `window.screen` 去猜「视口铺满了没有」，而多显示器、带缩放
的屏上那两个值常常差着一两个像素 —— 判定迟迟不成立，白等出的那几帧画面还没
开始长，用户看到的就是**一段纯黑**。现在 `viewer_ready` 把窗口内容区的真实尺
寸（物理像素）一并回报，前端拿它判定（`viewportMatches`），通常一两帧就成立。

### 全屏预览只有一套实现

三条进入预览的路 —— 图片墙点击、图片墙里回车、「打开方式」启动 —— 在主窗口
那边都汇到 `api.openViewer(index, origin, immersive)`，到预览那边又都汇到
`openSession()` → `openLaunch()` → `openFullscreen(index, source)`：

| | 图片墙点击 / 回车 | 打开方式 |
| --- | --- | --- |
| 来源 | 那一格的 DOM 矩形折成屏幕坐标 | 后端记的启动光标位置折成屏幕坐标 |
| 会话标记 | `immersive: false` | `immersive: true` |
| 来源没送到 | 屏幕中心 0.8 倍兜底（同一次放大，只是少了「从哪儿来」） | 同左 |
| 关闭之后 | `close_viewer` → 主窗口接到前台 | `exit_app` —— 这次预览是为这一张开的 |
| 窗口形态 | 主窗口**一个像素都没动** | 同左（它全程藏着） |

以前是每条路**各自给 `open()` 配一套 options**：「打开方式」传 `fadeIn: true`、
图片墙那条不传；`centerScale` 同理。结果同一个全屏预览在两条入口上悄悄长成
两种观感，而且这类差异没有任何运行时报错，只有并排看才察觉。收敛成一个入口
之后，来源的两种情况（有矩形 / 没有矩形）**只决定起点几何**，不再影响呈现
—— `fadeIn` 这个开关已经被删掉，`opacity 0 → 1` 是这个入口的固有形态。

会话语义（关掉之后是回到图片墙还是退出应用）只落在预览那边的 `onClosed` 回调
里，`Viewer` 自己不认识「沉浸式」这个词：

```js
onClosed: () => {
  sessionSeq += 1;                 // 作废还在路上的那次打开
  if (immersiveSession) { api.exitApp(); return; }
  api.closeViewer(Math.max(0, viewer.index));
}
```

**只有一个出口**这件事是刻意守住的：早先 `Viewer` 自己揣着一个 `exitOnClose`
开关并另配一条 `onExit`，于是「打开方式」那次关闭会退出两次应用。两条出口并
存是这类重复动作的温床，`tools/check_preview_entry.mjs` 有一条断言专门盯着它。

切完全屏还要等 `viewportFillsScreen()` 成立（最多 12 帧）：全屏不是同步生效
的，按旧尺寸算出来的 FLIP 起点会让画面从错误的方向长出来。

### 预览要的是操作系统级全屏，不是最大化

这两件事在代码里只差一行，在屏幕上差的是**任务栏那一条**：

| 做法 | Windows | macOS | 结果 |
| --- | --- | --- | --- |
| `window.maximize()` | 停在任务栏上方 | 停在菜单栏与 Dock 上方 | 窗口最大化 —— 预览永远挡不住屏幕边缘那几条 |
| `window.set_fullscreen(true)` | 盖住任务栏 | 搬进独立 Space，收起菜单栏与 Dock | 真正的整屏 |

所以预览一律走 `set_fullscreen`，**没有** `maximize()` 兜底：最大化在本项目里
没有撤回路径，一旦走到就把窗口永久钉在放大态 —— 那正是「退出预览后停在最大化」
的直接来源。全屏拿不到就保持窗口态，预览照样能用，比不可逆的一步安全。

macOS 上还有一道坎，值得单独说，因为它的失败是**完全静默**的：

> AppKit 只让 `collectionBehavior` 里带 `NSWindowCollectionBehaviorFullScreenPrimary`
> 的窗口响应 `toggleFullScreen:`。带标题栏的常规窗口由 AppKit 自动授予，但预览
> 这条线早先恰恰必须把标题栏摘掉（系统画的标题栏永远跟纯色预览面对不齐，也不
> 受前端空闲计时控制），窗口因此变成无边框，能力跟着没了 —— 结果是
> `set_fullscreen(true)` 既不报错也不生效，屏幕上看不出任何变化。

现在不再摘标题栏了：每条窗口在**诞生时**一次性设成「保留 `Titled` +
`FullSizeContentView` + 透明标题栏 + 隐藏标题文字」，之后运行时一次都不改（见
`src-tauri/src/macos.rs`）。启动时遍历两条窗口设一次；预览窗口重建时再跑一次
同一个幂等函数，只设那条新窗口。保留 `Titled` 有两个好处 —— 三个交通灯还靠它，
而且 AppKit 会**自动**授予 `FullScreenPrimary`，那段手补能力的代码随之退役；
`FullSizeContentView` 让内容区一路顶到窗口上边缘，于是那条系统栏看不见了，
只剩我们自己的 `.topbar`（预览那边则是 `.viewer-bar`）。

图片墙这条 `.topbar` 就是**合并后的唯一顶部区域**：标题栏信息（品牌 + 名称）、
工具栏操作（打开图片 / 打开文件夹 / 主题）与状态信息都在同一条连续的栏内，
没有第二条标题栏、也没有另起一行的独立工具栏。它只有一行、高度恒为
`--topbar-h`；窗口变窄时由 `app.css` 统一收紧间距、让状态文字省略让位，三个
操作入口始终完整可点，下面 `.grid` / `.empty` 按 `--topbar-h` 算的 `inset`
因此永远对得上。

这条栏**已经**把「交通灯让位区」与「文件打开入口」排在同一行 —— 交通灯是
macOS 原生控件（系统固定在窗口左上角，`macos.rs` 只是用 `padding-left` 给它
让位），不是 DOM 元素；能做到的「同处一栏」在平台层面就只有这一种形式。

**边界：空状态里的「选择图片 / 选择文件夹」不并入这条栏。** 那两个按钮
（`index.html` 的 `.empty-actions`）不是第二条工具栏，而是**内容区的空状态引
导**：只在还没打开任何图片时出现，和图标、标题、提示语、快捷键表一起居中在
`.empty`（`inset: var(--topbar-h) 0 0 0`）里，顶栏则是常驻的。两组入口在
`main.js` 里绑到同一个 `pick('files' | 'folder')`，`applyHostMode` 的禁用列表
也一起列了四个 id，功能与可用性天然一致。硬把它们挪进顶栏会同时踩三处：
与已有的「打开图片… / 打开文件夹…」重复（五个按钮、两个命令）；`flex-wrap:
nowrap` 的固定高度单行在 `minWidth: 460` 的窄窗口放不下，只能压缩或藏按钮；
空状态那句「或者直接选择」失去所指，内容区布局跟着变。所以这里保持原结构，
不做合并。

代价是引入两个 macOS 专用的 objc2 crate —— 它们本来就是 tao（Tauri 的窗口层）
的依赖，版本一致，不会额外编译。非 macOS 平台根本不会构建这个模块。

> macOS 全屏会把窗口搬进独立 Space，因此**进入**预览有约 0.3~0.5s 的过场动画
> （与照片.app、Quick Look 一致）。退出是**直接销毁**那条全屏窗口，不播退出转场 ——
> 那段转场里「整屏缩回常规尺寸」的一帧正是空白窗口的来源。想退回上一版行为就
> 把 `commands::viewer_ready` 里的 `set_fullscreen(true)` 换成 `maximize()` ——
> 但先读一遍下面那一节，它解释的正是为什么不能这么做。

`tools/check_preview_entry.mjs` 钉死三件事（入口唯一、时长/缓动/背景同一份
常量、会话差异只落在语义上），`tools/check_window_split.mjs` 钉住几何「终身
只读」（Rust 侧任何文件出现 `set_size` / `set_position` / `set_maximized` /
`set_decorations` 直接失败），`tools/check_boot.mjs` 补上启动那一层（主界面
该不该露面、焦点落在哪一条窗口上），`ui/probe.html` 第 18 节比对的是**真正
传给 `animate()` 的实参** —— 静态检查只能看到有没有这个方法，看不到调的时候
传了什么。

> 无装饰不代表不能拖动：预览的标题栏 `.viewer-bar` 里留有
> `<div class="viewer-drag" data-tauri-drag-region>`，去掉系统标题栏之后由它
> 承接拖拽手势（拖动 / 双击最大化照旧），interactive 的按钮不受影响。

### 退出预览后窗口停在最大化：两个静默失效的根因，以及为什么最后拆成了两个窗口

这是本项目遇到过最"安静"的缺陷：图片墙里点开任意一张进全屏预览，用 `Esc` /
关闭按钮 / 点画面外空白都能正常退出 —— 但退出之后窗口**停在最大化**，回不到
打开预览前的尺寸，而且**没有任何报错**。

#### 根因一：运行时摘过装饰

根因不在我们的代码里，在窗口层对「全屏转场」的处理方式上：

1. `set_fullscreen(false)` 只是**发出**退出请求，窗口还要播一段转场动画
   （macOS 上约 0.3~0.5s），命令本身立刻返回；
2. 我们紧接着调用 `set_decorations(true)`，于是它落在动画期间。tao 在 macOS
   上的实现是「全屏期间不动装饰，等 `windowDidExitFullScreen:` 再说」——
   **直接 return**；
3. 要命的是它在 return **之前**已经把内部的 `decorations` 标志写成了 `true`。
   于是之后再怎么调 `set_decorations(true)`，都被开头那句「已经是了」挡掉，
   连函数体都进不去；
4. 转场结束后，AppKit 回调 `windowDidExitFullScreen:` → tao 的
   `restore_state_from_fullscreen()` 把进入全屏时保存的**无边框**样式写回去。

四步合起来：请求永远生效不了，而调用方记账里写的是「已恢复」。

#### 根因二：进全屏前写过一次几何

**AppKit 还原窗口用的是「进入全屏前那一帧」。** 只要在那之前把窗口摆到整块
屏 —— 哪怕只是为了省一次布局 —— macOS 当场判定它 `zoomed`（frame 等于屏幕
可视区即命中），AppKit 从此把「最大化」当成还原目标，退出后必然停在最大化，
而且是**逐项精确**地停在最大化：它没出错，它还原的是我们写脏的那一帧。

`tools/appkit_geometry.swift` 把这条行为钉成了可复跑的事实（真机实测，
1200×800 的窗口往返一次原生全屏）：

| 场景 | 进全屏前 | 退出全屏后 |
| --- | --- | --- |
| 全程不写几何 | `1200×801 @(360,127)` zoomed=no | `1200×801 @(360,127)` ✅ |
| 同上 + 复刻 tao 的退出补偿 | 同上 | 同上（`isZoomed == maximized`，直接早退）✅ |
| 进全屏前摆到整块屏 | `1920×1055` **zoomed=YES** | `1920×1055` ❌ 停在最大化 |
| 隐藏态直接切全屏 | `1200×801`（不可见） | `1200×801` ✅ |

#### 中间两步：装饰永不变 → 几何终身只读 → 还是没修好

顺着这张表改过两轮，每一轮都是对的，但都没能把这个症状修掉：

| 轮次 | 做法 | 结果 |
| --- | --- | --- |
| A | **装饰永不变**：样式在启动时一次性设好，运行时一次都不改 | 标题栏回来了，尺寸仍然停在最大化 |
| A′ | **几何终身只读**：`prepare_launch_window` 不再 `set_size` / `set_position` / `show`，趁窗口还藏着直接切全屏 | 仍然停在最大化 |

A′ 之后去读 AppKit 才知道，那条路本来就是堵死的：**「进全屏」与「退出全屏」
是两个不同的窗口状态机**，而只要图片墙与预览共用同一个窗口，就一定有一段
「这个窗口既是浏览态、又是全屏态」的生命周期。那段生命周期里发生的所有写入
—— 哪怕只是「隐藏态直接切全屏」—— 都要经过 AppKit 那套以 `saved_style` /
`zoomed` 记账的还原机制，而我们的补偿与它的写入排在同一条
`DispatchQueue.main` FIFO 上。那是一场纯竞态：调 `sleep` 只能改变输的概率。

#### 现在的做法：两个物理窗口，几何永不互相影响

于是把这条不变量**从代码里挪到结构上**：

```
main 窗口（图片墙）    ——  从不进全屏、几何一次都没被写过、全程不被销毁
viewer 窗口（预览）    ——  拥有全屏，关闭即 destroy()，下次进入按需重建
```

图片墙那条窗口**一次全屏都没进过**，所以它根本不存在「退出预览要还原成什么」
这个问题 —— 它就待在用户最后摆放的位置上。还原这件事这回不是我们做对的，是
**没有发生**：没有任何一行代码能把它写脏，也就没有任何一个还原目标会被记下来。
根因一、根因二在上面的结构里一条都不成立。

代价是状态要在两个 webview 之间过一趟后端，以及多一条窗口：

| 代价 | 怎么付 |
| --- | --- |
| 图片集合 | 后端 `AppState::current` 存一份**有序**列表，`viewer_boot` / `picshow://viewer-goto` 把它连同源点一起转过去 |
| 来源几何 | 折成物理像素的屏幕坐标传递（见「开场动画」那一节） |
| 反向状态 | 预览关掉时把「用户在看第几张」回传（`picshow://viewer-closed`），图片墙据此滚到那一格 |
| 多一条窗口 | 静态声明首条；退出即销毁、进入时按需重建，同一时刻最多一条 viewer，不堆积也不泄漏 |

`tools/check_window_split.mjs` 把这条钉住：Rust 侧任何文件出现 `set_size` /
`set_position` / `set_outer_position` / `set_min_size` / `maximize()` /
`set_decorations` 直接失败；主窗口那条标签上不允许出现 `set_fullscreen`；
前端不许再有 `useImmersiveStage` / `stageQueue` / `set_stage` 这类记账。
`ui/probe.html` 第 11.6 节则从另一个方向判：主页面里不再有预览的入口与 DOM。

#### 分家之后的两个新问题：残留桌面 + 残留空白窗口

分家把「窗口回不到原尺寸」治好了，但常驻窗口 + `hide()` 换来两个 macOS 特有的
问题 —— 其实是同一件事的两面：

* **Mission Control 里多出一个写着 PicShow 的空桌面**：原生全屏窗口搬进独立
  Space，`hide()` 底层是 `orderOut:`，只把窗口从屏幕上摘走；全屏态还在，桌面
  就还在，切不过去也关不掉；
* **退出预览后一块空白 PicShow 窗口盖在图片墙上，而且再也不消失**：想让 AppKit
  收掉桌面就得先播退出全屏转场，而转场里窗口会从整屏缩回 1200×800 —— 那一帧
  正是空白窗口；转场收尾还会把刚 `orderOut:` 掉的窗口拉回屏幕。它跟图片墙窗口
  尺寸位置一模一样（都是 1200×800 居中），内容又被 `finishClose()` 清空
  （`root.hidden = true`），看着就是严丝合缝的一块空白。

`tools/appkit_fullscreen_exit.swift` 把这段时序测成了数字（macOS 实测）：

```text
[  4.079] toggleFullScreen → 退出
[  4.113] frame 落到终值 1200×801        ← 旧代码的判据在这一刻成立
[  4.119] orderOut（frame 一到终值就藏）
[  4.664] didExit                        ← 转场真正播完，晚 552ms
[  7.4~ ] 观察 visible=Y … 一直 Y        ← 窗口被转场收尾拉回来了
```

| 模式 | 结果 |
| --- | --- |
| 一量到 frame 到终值就 `orderOut:`（旧代码） | ✗ 窗口仍然可见 |
| 同上，但再等 400ms | ✗ 仍然可见（补不上那个 530ms 的差） |
| 等 `windowDidExitFullScreen:` 再 `orderOut:` | ✓ 窗口从层级移除，但**转场那一帧空白窗口仍在** |
| **全屏中直接 `close()`（现在）** | ✓ 窗口从层级移除、AppKit 自己回收桌面、**全程没有常规尺寸的可见帧** |

差不是固定值（随机器与动画时长变），靠「多等一会儿」补不上，只能等 AppKit 自己
那个信号。而**根本不必等它**：把一个仍处在全屏的窗口直接销毁，AppKit 会自己
走完 `windowDidExitFullScreen:` 收掉桌面，窗口对象同时从 `NSApp.windows()` 移除
（探针 `--close-in-fullscreen`：`windows 1 → 0`、`windowWillClose` 与 `didExit`
都收到、`sawNormalVisible = false`）。窗口实例都不存在了，也就谈不上残留、空白
或多余的层级。

#### 现在的窗口生命周期

```
进入预览  open_viewer → ensure_viewer_window()   （不存在才按 tauri.conf.json 同一份配置重建）
退出预览  close_viewer → release_viewer → destroy() → 确认 label 从注册表移除 → 叫回主窗口
应用退出  exit_app / ExitRequested → release_viewer_now → destroy()
```

| 细节 | 为什么 |
| --- | --- |
| **退出即 `destroy()`，不隐藏、不请求退出全屏** | 一步同时收掉 Space 与窗口实例，不播「缩回 1200×800」的转场，中间没有空白窗口帧 |
| **`ensure_viewer_window()` 先查再建** | 存在就复用，一条都不多建；销毁后 Tauri 把 label 从注册表移除，下次可用同 label 重建。配置取自 `app.config().app.windows`，与首条窗口逐字段一致 |
| **销毁后把 `viewer_listening` 置 false** | 新窗口的 webview 还没装配，发事件会掉进黑洞；它装配完会重新上报 `viewer_listening()` |
| **确认移除 → 才叫回主窗口** | `set_focus()` 里的 `activateIgnoringOtherApps:` 会把整个应用的窗口一起提到前台，预览还在层级里就会被一起提到最上面 |
| **销毁确认跑在后台线程** | `Destroyed` 事件要由事件循环处理；不能占住命令线程轮询，否则自锁 |
| **让位带世代号** | 销毁确认期间又发起新预览时，上一次让位自己作废，不把刚重建的窗口盖住 |
| **四条退出路径统一** | Esc / 双击 / 关闭按钮 → `viewer.close()` → `close_viewer`；交通灯 / `Cmd+W` 由 `CloseRequested` 拦下转成前端同一条关闭路径；沉浸式会话走 `exit_app`；进程退出走 `ExitRequested` |

`destroy()` 强制关闭、不发 `CloseRequested` 事件
（`tauri-2.12.5/src/webview/webview_window.rs`），所以不会触发上面那条拦截形成
循环；销毁确认上限 600ms，超时也照常叫回主窗口。这些细节由
`tools/check_boot.mjs` 与 `tools/check_window_split.mjs` 钉住。

图片墙那条窗口**全程没被销毁、没被隐藏、没被改过几何**：布局、滚动位置、DOM
与焦点状态都在它自己那个 webview 里，从未被重建。`picshow://viewer-closed` 只
把「最后看的是第几张」送回去，`grid.ensureVisible(index)` 把那一格滚到可见
（多数情况下滚动位置根本不变），`dom.grid.focus()` 把键盘焦点交回网格。

#### 多桌面（Space）：退出预览后回到触发打开的那一个

上面那套「只销毁预览窗口」解决的是**本进程自己开的那个全屏桌面**。还有一种
残留跟它无关：用户有多个桌面，访达窗口在**非第一个** Space，右键图片 →
「打开方式」→ PicShow 全屏预览，`Esc`（或关闭按钮 / 交通灯）退出之后，macOS
把用户送回了**第一个 Space**，而不是触发打开操作时访达所在的那个 —— 访达
窗口与焦点都留在原处，用户被丢到一个空桌面。

根因不在退出全屏转场，而在**激活**：应用被 LaunchServices 唤起时，系统会切
到「包含该应用窗口的桌面」；冷启动那条隐藏的 `main` 窗口被算在第一个 Space，
全屏窗口销毁后 AppKit 回到「进入全屏前所在的 Space」，也就跟着回到了那一个。
我们拦不住系统那次切换 —— macOS **没有公开 API** 指定「回到第 N 个桌面」
（`CGS*` 那一套是私有的，产品代码一行都不用）。

能公开、可靠地「回到某个 Space」的路子只有一条：**激活那个 Space 上的应用**
（`NSRunningApplication.activateWithOptions:`）。WindowServer 会把它窗口所在
桌面切到前台，并把 key window / 焦点一并交还 —— 这正好同时满足「回到访达所在
的 Space」和「保持访达窗口及焦点状态」。

于是修复只有两半：

| 半边 | 位置 | 做什么 |
| --- | --- | --- |
| **记录** | `lib.rs::run()` 第一行 + `RunEvent::Opened` 开头 → `macos.rs::capture_launch_source()` | 在 `NSApplication` 初始化 / 应用被激活**之前**读 `NSWorkspace.frontmostApplication`，记下 pid + bundleIdentifier |
| **交还** | `commands.rs::hand_back_launch_source()` → `macos.rs::restore_launch_source()` | 沉浸式会话退出（`exit_app` / `ExitRequested`）时按 pid 找回那个应用、核对 bundleIdentifier 后 `activateWithOptions:` |

`tools/appkit_space_restore.swift` 把关键时序测成了事实：进程第一行读到的
`frontmostApplication` **是触发打开的那个应用**，不是自己；`NSApplication` 初始化
并激活之后就未必了 —— 所以捕获必须放在 `run()` 第一行。pid 与 bundleIdentifier
能把那个应用找回来（双标识也是为了防 pid 被复用）。这台无图形激活的会话里
`activate()` 返回 `false`，所以「激活能否真的切桌面」只能真机验收，探针不假报
成功。

**改动被钉死在这一条路径上**：交还要求 `was_launched() &&
space_restore_armed()` 同时成立，而 `space_restore_armed` 只有 macOS 的
`RunEvent::Opened`（访达打开方式的 Apple Event）会置起来。命令行
`picshow <文件>` 同样会 `mark_launched()`，但它不经过 `Opened`，退出行为原样
不变；拖放、文件对话框、图片墙点开的预览更是都走
`close_viewer → reveal_main_window()`，一行都没碰。单桌面下「激活来源应用」
等价于把焦点还给打开它的那个应用，与系统默认一致。

几个容易改坏的细节由 `tools/check_boot.mjs` 钉住：交还是**一次性的**
（`SOURCE_HANDED_BACK` 闸门，`exit_app` 与 `ExitRequested` 叠加不会切两次）；
`exit_app` 里顺序是「先销毁全屏窗口 → 再交还 → 才 `app.exit(0)`」，并留
140ms 给异步激活请求落地；来源应用已经不在了才回退到访达，连访达都找不到
就什么也不做，绝不乱激活。

### 转场动画：统一参数

退出预览时那一下**跳动**也是个次序问题。以前是「播关闭动画 → 撤遮罩 → 切窗
口形态」，于是窗口缩回与网格重排全发生在用户眼皮底下：动画刚把图片送回缩略
图，网格又被重排顶开。

现在是两段式（中间那段「幕后换场」随分家一起消失了 —— 预览是独立窗口，收摊
时它只是被藏起来，图片墙那条窗口一个像素都没被动过，也就没有需要藏在幕布后
面的重排）：

| 段 | 做什么 | 关键约束 |
| --- | --- | --- |
| ① 画面退场 | 图片缩回开场时**那一格**的方向并淡出 | 背景**保持不透明** |
| ② 幕布退去 | 根容器连它那层不透明背景一起淡出 | 之后后端才把预览窗口藏起来 |

注意淡的是**根容器**而不是 `.viewer-backdrop`：根容器自己带着一层不透明背景
（`--viewer-bg` 是实心色），只淡背景层的话底下仍是黑的 —— 那一层从来没有真正
"退去"过，以前是靠 `root.hidden = true` 硬切掉的。

退场落点用的是**开场时记下的那一格**（`originRect`），不再去问网格 —— 预览
窗口里压根没有网格 DOM，跨窗口之后那种问法也不成立。

参数统一到一组常量，位移与透明度分开用两条缓动（一条动画只能给一条曲线，而
这两种运动想要的节奏不一样）：

| 常量 | 值 | 用于 |
| --- | --- | --- |
| `EASE` | `cubic-bezier(0.22, 1, 0.36, 1)` | 位移（FLIP、轨道切换） |
| `TWEEN_FADE_EASE` | `linear` | 转场透明度 |
| `OPEN_MS` | 300 | 开场 |
| `CLOSE_MS` | 240 | 画面退场 |
| `CURTAIN_MS` | 180 | 幕布退去 |

> 注意别把 `TWEEN_FADE_EASE`（转场）和 `FADE_EASE`（控件层显隐，来自
> `chrome.js`）弄混 —— 两者各管一段。

其余三点：

* **减少动态效果** —— 读 `prefers-reduced-motion`。开着时跳过 FLIP 缩放位移，
  时长压到 `REDUCED_MS`（120ms）只留淡入淡出。完全去掉动画会让「预览开了 /
  关了」失去提示，反而更难用。
* **不卡顿** —— 全程只动 `transform` / `opacity`（合成层，不触发布局）；
  `will-change` 只在转场那几百毫秒挂上，跑完立刻撤掉（常驻会给整张预览图留
  一张合成层，低速设备上白白吃掉内存与合成开销）。
* **不等** —— 切全屏那段平台转场躲不掉，所以进场先挂一层幕布（`viewer.prime()`），
  点击的反馈是即时的，之后 `open()` 从这层幕布接着演，不会先把背景归零再淡一
  次（那会闪）。

### 退出预览后页面卡死：把界面押在了一串不一定会兑现的 await 上

**症状**：点图进全屏预览，无论用 `Esc`、关闭按钮还是点画面外的空白退出，
界面都变成一层不动的背景 —— 点不动、滚不了、CPU 还往上走。三种退出方式
全中，反复进出之后必现。

**根因不在「忘了卸载」，在「卸载排在了一串 await 后面」。** 关闭流程原本是：

```
播退场动画 → await 幕后换场（切回窗口形态） → 撤幕布 → finishClose()
```

`finishClose()` 才把预览层 `hidden = true`。而中间那一段「幕后换场」是
`IPC → 后端轮询等全屏转场播完 → 等两帧布局` —— **任何一环不兑现，那层
`position: fixed; inset: 0; z-index: 200` 的不透明预览就永远留在屏幕上**。
而它盖住一切：点不动、滚不了，和程序死了没有区别。

不兑现不是假设。`requestAnimationFrame` 在窗口做全屏转场、被最小化、被切到
另一个 Space 时**真的会停**，而且不通知任何人。于是 `await nextFrames(2)`
变成了一张没有日期的船票。更糟的是形态切换走的是**串行队列**：一次挂起会把
后面所有调用一起堵死 —— 下一次点图、下一次退出，全在排队等那张船票。

**修复只做一件事：让「卸载预览层」不依赖任何异步操作的成败。**

| 位置 | 改动 |
| --- | --- |
| `viewer.js` | `close()` 把 `finishClose()` 放进 `finally`——动画、幕布任一段挂住或抛错都收得掉；`finishClose()` 加幂等守卫，不会二次触发宿主回调 |
| `ui/js/async.js`（新） | `withTimeout()` / `nextFrames()` / `waitFor()`：**每个等帧函数都同时挂 `setTimeout` 兜底**。帧来了按帧走（快且准），帧不来也在预算内兑现 |
| `viewer.js` | 退场动画与幕布淡出各带硬超时（`animation.finished` 在帧停摆时不兑现），放大态的 `reset` 也一样 |
| `viewer-main.js` | **等待期间按 Esc = 取消这次打开**：那时预览还没开，关闭分支不认得它；用一个世代号作废还没落地的 `open()`，并连带把状态收干净（`abort()`） |
| `viewer.js` | 幕布加保险丝（4s 无人接手就自己撤）；`open()` 被拒时把幕布摘掉 |
| `viewer.js` / `strip.js` | 新增 `destroy()`：拆 `ResizeObserver` 与全局 `keydown` / `resize`，让「完全卸载」有一个明确出口 |

「幕后换场」那一段已经随分家删掉了：它原本要等一串 IPC 与平台转场，是整个
关闭流程里最会长的一坏。现在那里什么都不等 —— 因为**没有形态需要还**。

一句话总结取舍：**多等几十毫秒没人看得出来，卡死不能接受。**

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

从文件管理器进来的预览常常要**点一下画面**方向键才肯工作。三个原因叠在一起，
缺一个都复现不出来：

1. 预览窗口是 `visible: false` 隐藏起步的（`tauri.conf.json`）。隐藏窗口上调
   `set_focus()` 会被平台**直接忽略** —— tao 的实现第一条判断就是 `isVisible`；
2. 切全屏在 macOS 上是一段 Space 过场动画，会把刚抢到的 key window
   **又让出去**；
3. 图片还在解码时就落焦点，用户按下的第一个方向键落在「什么都没画出来」的
   画面上，观感就是「按了没反应」。

所以焦点**不在切全屏那条命令里要** —— 那时窗口还藏着，要了也是白要。它交给
前端在「首图已落地」之后补一次。具体分工：

| 谁 | 做什么 |
| --- | --- |
| `commands::viewer_ready` | 改标题 → 切全屏 → `show()` → 回窗口原点。**不 set_focus**（由 `check_boot.mjs` 守着） |
| `commands::focus_viewer` | 单独一条命令，供前端在图片落地后调用；窗口还没点亮时直接返回（要了也白要） |
| `Viewer#focusWhenReady()` | 等当前槽的底图或原图**谁先到算谁**（带 4s 超时兜底），再把 DOM 焦点给预览 |
| `Viewer#focusView()` | `#viewer` 带 `tabindex="-1"`（程序可聚焦、不进 Tab 遍历），`focus({preventScroll:true})` |
| `viewer-main.js` | 上面两步的合体，排在 `openLaunch()` 之后；顺便把 `document.hasFocus()` 打到终端（仅 `PICSHOW_DEBUG=1`） |

反向的一次同样讲究：预览关掉时，图片墙那条窗口才被叫到前台（`close_viewer`），
焦点交回网格 —— 用户在预览里翻到第几张，退出来网格就停在第几张
（`picshow://viewer-closed`）。两条命令各自只碰自己那条窗口，
`focus_window` 与 `focus_viewer` 因此是分开的两条。

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

想改成循环：在 `viewer-main.js` 的 `openSession()` 里加一句 `viewer.setLoop(true)`
（或直接调 `viewer.setLoop(true)`）。循环时用淡入跨过首尾，不会让轨道飞过整条画廊。

### 目录里只有这一张图

* 集合长度 = 1 ⇒ 底部胶片条与左右按钮都隐藏（`no-strip`），画面完整占满；
* 标题栏显示 `lonely.png  1 / 1`；
* `←` `→` 无效果（回弹），`Esc` 仍然退出应用。

### 验证步骤

自动化：

```bash
npm run rust:test    # 后端：同目录扫描 4 项（自然排序 / 不递归 / 只有一张 / 不支持的格式）
npm run probe        # 前端：两种窗口尺寸各跑一遍（… / 17 触控板横向切换 / 18 有来源 vs 无来源同一份开场 / 19 关闭时序 / 20 减少动态效果）
npm run test:exit    # 退出路径：真实 viewer-main.js + 假 IPC，三种退出方式 × 3 轮 + 连按 Esc + 关闭后立刻重开 + 幕布期取消 + 打开方式会话（60 项）
npm run check        # JS 语法（check_syntax.mjs）+ cargo check + 几何断言 + 方法/导入 + 主题令牌 + 启动路径与焦点（check_boot.mjs）+ 预览入口（check_preview_entry.mjs）+ 预览层卸载（check_unload.mjs）+ 窗口几何终身只读（check_window_split.mjs）+ 触控板前提（check_trackpad.mjs）+ 横向 wheel 连续滚动流时序（check_wheel_swipe.mjs）
npm run check:all    # 上面全部 + test:exit + probe
```

> `probe` 与 `test:exit` 覆盖的是**两段互不重叠的代码**：`probe.html` 自己
> new 一个 Viewer，直接走 `viewer.openLaunch()`，不经过后端的会话中转与
> 跨窗口几何那一趟；`exit_probe.html` 加载真实的 `viewer-main.js`，专门压那
> 一段。跨窗口那些故障（比如会话到了却没开画、沉浸式会话退出两次）只可能出
> 在后半段 —— 只跑 probe 是抓不到的。
>
> 反过来，窗口几何这条不变量没有任何一种运行时能测（浏览器与探针都碰不到窗
> 口装饰），所以它由 `check_window_split.mjs` 静态钉住：Rust 侧出现任何
> `set_size` / `set_position` / `maximize()` / `set_decorations` 直接失败。

真机（**窗口还原**这个缺陷只在真机上暴露，两个窗口的分家也只有真机看得到）：

```bash
npm run dev
```

1. 打开一个图片目录 → 点任意一张缩略图进入全屏预览（主窗口一直在原地，只是被
   独立 Space 的全屏预览盖住，屏幕上只剩预览）；
2. `Esc` 退出 → **图片墙窗口必须回到进入预览前的尺寸与位置**，顶部的系统标题
   栏（三个交通灯）原样在那儿，可以直接用鼠标拖动窗口；
3. 换另外两种退出方式各来一遍：**点预览右上角的关闭按钮**、**点画面外的空白
   区域** —— 三种方式的结果必须完全一致；
4. 连续开关 5~10 次（尤其是刚关掉就立刻点下一张），每次都要回到原处，不能
   出现「某次之后就再也回不去」；
5. 快速连按 `Esc` 两三下 —— 不能把预览卡在半开的状态；
6. 把主窗口拖到屏幕另一处、缩放到非默认尺寸（也可以先拖到第二块屏），再进
   一次预览并退出 —— 尺寸与位置**应当回到原处，而不是被全屏撑满**。这一项是
   整个方案的验收点；
7. 在预览里翻到第 20 张再退出 → 图片墙应当**停在第 20 张**（而不是还在第一张）；
8. 全程留意：退出时**不应看到网格从全屏布局"啪"地变成小窗口布局** —— 分家
   之后这条按结构就不可能发生，看到就说明主窗口进过全屏了。

**桌面（Space）是否回收**（这一项只在真机上看得到，浏览器与探针都碰不到）：

9. 开一次预览之前先记住有几张桌面：三指/四指上滑（或按 `F3` / `Control+↑`）
   进 Mission Control → 看顶部那一排；
10. 进入预览 → 桌面数 +1（预览那条会在最右边，名字是 PicShow）；
11. `Esc` 退出 → **桌面数回到原来的值**。还多一个就说明预览窗口没有被真正
    销毁（见上面那一节）；
12. 开关 5 次 → 桌面数始终是原值 +0，不越攒越多；窗口位置与尺寸每次都回到原处；
13. 在预览里点窗口左上角的红色交通灯（全屏时把鼠标移到屏幕顶边才会出现）→
    与按 `Esc` 完全一致：桌面回收、图片墙停在你正在看的那一张；
14. 用「打开方式」打开一张图 → 按 `Esc` 应用退出 → 桌面数回到原值；
15. 开着预览时从 Dock 图标菜单选「退出」→ 同样不留桌面。

**多桌面（Space）：退出预览后要回到触发打开的那一个**（这一组只在真机、
且确实有 ≥2 个桌面时才有意义；单桌面与浏览器/探针都碰不到）：

A. 在「系统设置 → 桌面与程序坞」里确认至少两个桌面（没有就进 Mission Control
   用右上角 `+` 加一个）。把**访达窗口放到第 2 个桌面**（非第一个），并让它成为
   前台应用 —— 这是复现缺陷的前提；
B. 在这个访达窗口里右键图片 →「打开方式」→ PicShow 全屏预览；
C. `Esc`（或关闭按钮 / 交通灯 / `Cmd+W`）退出 → **必须回到第 2 个桌面**。
   进 Mission Control 看顶部那一排，高亮的应当是第 2 个；菜单栏显示「访达」。
   **停在第一个桌面就是没修好**（这正是本轮缺陷）；
D. 访达窗口与焦点：退出后访达窗口还在原来那个位置、还是前台 —— 直接按
   `←` `→` 选文件、`Cmd+↑` 进父目录都能操作，不用先点一下窗口；
E. 重复 B→C 五次 → 每次都回到第 2 个桌面，不越切越偏、桌面数始终是原值；
F. 应用已经开着时，从第 2 个桌面的访达**再打开另一张** → 预览直接换图 →
   退出 → 仍回到第 2 个桌面。这条压 `RunEvent::Opened` 的再次捕获；
G. 预览前后对照：进入前记下访达窗口的位置、所在文件夹、选中的那张图；
   退出后这三项都没变；
H. 单桌面场景对照：只留一个桌面时重做 B→C → 行为与修复前一致（应用退出、
   焦点回访达、不留桌面、不留空白窗口），不因为这次修复多出任何动作；
I. 其他入口对照：命令行 `picshow 文件`、拖放到窗口、图片墙点开的预览 →
   退出行为与修复前完全一致（图片墙预览关闭后回到图片墙，**不**去激活访达）；
J. `PICSHOW_DEBUG=1` 跑一次，日志里应当出现
   `记录打开来源：pid=… bundle=com.apple.finder` → 退出时
   `交还前台给 com.apple.finder（pid=…）：activate=true`。
   少了第一行说明捕获没落在最早期；`activate=false` 说明这台会话拿不到激活
   （ssh / 沙箱 / 无 GUI 登录），换一个图形登录会话重验。

**退出后不留空白窗口**（这一步与桌面回收是同一次销毁完成的）：

16. `Esc` 退出 → 屏幕上**只剩图片墙窗口**。在图片墙上随便点一下、滚一下滚轮、
    按一下方向键 —— 能正常响应就说明上面没盖着东西。残留的空白窗口尺寸位置
    跟图片墙一模一样（都是 1200×800 居中），**叠上去是严丝合缝的**，只看一眼
    容易误判成「图片墙卡住了」；
17. 三种退出方式各来一遍：`Esc` / 预览右上角关闭按钮 / 点画面外的空白区域；
    再加上窗口交通灯与 `Cmd+W`（它们走的是「拦下关闭请求 → 转前端正常关闭」
    那条路）—— 五种方式的结果必须完全一致；
18. 关掉之后**立刻**再点下一张 → 新预览正常打开。这一项专门压「销毁确认期间
    又开预览要能作废」：世代号若失效，上一次让位会把刚重建的窗口盖住；
19. 开着预览的时候从 Dock 图标菜单选「退出」→ 既不留桌面，也不留空白窗口；
20. `PICSHOW_DEBUG=1` 跑一次，正常退出时日志里应当出现
    `预览窗口已销毁（从窗口层级移除）`，且**不应**出现
    `预览窗口销毁确认超时` —— 后者出现说明 `Destroyed` 事件没被处理，窗口仍留在
    注册表里。再点开一次，日志里还应出现
    `预览窗口已重建（上一条在退出时销毁）`。

**开场动画是否对得上那一格**（三条一起看，缺一条就是「从错的地方长出来」）：

21. 点**中间偏下**的一格（不是第一格）→ 画面应当从**那一格**长出来，而不是
    从屏幕中心或偏上的地方；
22. 点一个**特别扁或特别高**的格子（等高行里总有几个）→ 开头那一帧的画面
    应当与那一格里的缩略图**重合**（同样是被裁过的），而不是突然变成完整比例；
23. 连拍（`Cmd+Shift+4` 或 QuickTime）回看：全程**没有**「先闪一下全尺寸再缩回
    去」、也**没有**「空框长大、然后图片突然填上」；
24. `PICSHOW_DEBUG=1` 跑一次，日志里应当出现
    `预览窗口：请求进入全屏` → `预览窗口就绪：…内容区=…`，退出时出现
    `预览窗口已销毁（从窗口层级移除）`；**不该**出现「请求退出全屏」—— 现在不播
    那段转场，窗口在仍处于全屏时被直接销毁，桌面由 AppKit 自己回收。

打包后才有右键菜单，那条路径单独验：

```bash
npm run build
cp -R src-tauri/target/release/bundle/macos/PicShow.app /Applications/
```

1. 访达里挑一张 jpg → 右键 → 打开方式 → PicShow；
2. 应当：**整个过程不出现浏览界面**（没有顶栏与缩略图网格那一帧），预览那条
   窗口直接进入操作系统级全屏，中央就是那张图；
3. 开场是从**你右键的那一格**放大到全屏的（约 300ms，带透明度渐变）。想看清
   就把 `viewer.js` 的 `OPEN_MS` 临时改大，再连拍几张；
4. 标题栏显示 `文件名` 与 `3 / 12` 形式的序号，背景与画面浑然一色；
   **不用先点画面**，`←` `→` 直接在同目录图片间切换，到首末张时对应按钮置灰
   并有回弹（`PICSHOW_DEBUG=1` 会打出 `[focus][预览] hasFocus=true active=viewer`）；
5. 静止 2.2s → 标题栏、左右按钮、胶片条**同时**淡出；动一下鼠标 / 按任意键 → 同时回来；
6. `Esc` → **应用整体退出**，回到访达（这次不会有任何窗口被留下来）；
7. 应用已经开着的时候再从访达打开另一张 → 预览直接换到那张，不重播开场动画；
8. 换一个只有一张图的目录再来一次：无胶片条、无左右按钮、计数器 `1 / 1`；
9. 对照实验：不带任何参数启动（`PICSHOW_DEBUG=1 …/picshow`）→ 仍是老样子，
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
# [picshow] macOS：已设定透明标题栏 + 内容铺满窗口
# [picshow] 预览会话：3 张，第 2 张，immersive
# [picshow][前端] [focus][预览] hasFocus=true active=viewer   ← 焦点已落在预览上
```

注意这条路径**不会**打印「前端首屏就绪」——那行属于常规入口的 `window_ready`
（它点亮的是**主窗口**，这条路上一趟都不该走）。
这里也不点亮主窗口：`viewer_ready` 只改标题 + 切全屏 + `show()` **预览那条
窗口**（顺带把窗口原点回给前端算几何）。万一它没亮起来，前端量布局时会发现
视口没铺满，自己补一次 `showWindow()`（`lib.rs` 里还有一道 3 秒的全局兜底，
它会先问「预览起来了没有」再决定要不要点亮主窗口）。

`PICSHOW_DEBUG=1` 还会把**前端**的未捕获异常一起打到终端 —— webview 的
`console` 不会出现在终端里，没有它就是「界面没反应」这类无从下手的报告。

### 两条通道，缺一不可

主窗口那边：

| 场景 | 走哪条 | 为什么 |
| --- | --- | --- |
| 冷启动（应用被这次打开唤起） | 前端 `take_launch_target()` 主动取 | 后端在 webview 执行第一行 JS **之前**就把事件发出去了，那时没有监听者，事件直接丢进黑洞 |
| 已运行时又打开一张 | `picshow://open-file` 事件 | 前端早已就绪，事件立刻到达，直接换集合并跳转 |

两条共用同一个入口 `commands::deliver_launch()`：既发事件，也存一份「待取件」，
取完即清空（避免重复打开）。

预览窗口那边是同款，只是对象换成了会话：

| 场景 | 走哪条 | 为什么 |
| --- | --- | --- |
| 预览 webview 先加载完（常规情况） | 前端 `viewer_boot()` 主动取 | 它可能在主窗口点图**之前**就备好了，那时请求还没产生 |
| 已在看片时又打开一张 | `picshow://viewer-goto` 事件 | 预览早已在跑，换内容、不重播开场 |

「先挂监听、再告诉后端我能收了（`viewer_listening`）、最后才取待取件」—— 顺序
反了会在两条路之间开一条缝，正好卡在缝里的那次请求掉进黑洞。

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

**Q：为什么预览要单独开一个窗口，而不是让图片墙那一条切进全屏？**

因为「退出预览后停在最大化」这件事，在同一个窗口里**修不掉**。AppKit 还原窗口
用的是「进入全屏前那一帧」：只要在进全屏之前把窗口摆到整块屏，macOS 当场判定
它 `zoomed`，从此把「最大化」当成还原目标（实测与完整推导见第七节、
`tools/appkit_geometry.swift`）。而我们的补偿与 AppKit 的写入排在同一条
`DispatchQueue.main` FIFO 上 —— 那是一场纯竞态，`sleep` 只能改变输的概率。

改成两个物理窗口之后，这条不变量从**代码纪律**变成了**结构事实**：图片墙那条
窗口一次全屏都没进过、几何一次都没被写过，于是它根本不存在「退出预览要还原成
什么」这个问题。还原不是我们做对了，是没有发生。

代价是状态要在两个 webview 之间过一趟后端（图片集合、来源几何、退出时用户在
看第几张），以及一条「退出即销毁、进入按需重建」的预览窗口。详见第七节。

**Q：为什么预览窗口退出时是「销毁」而不是 `hide()`？**

因为隐藏这条路在 macOS 上会同时留下两样东西：原生全屏窗口独占的那个 Space
（`orderOut:` 不释放它），以及退出全屏转场里「整屏缩回 1200×800」那一帧空白
窗口 —— 转场收尾还会把刚藏掉的窗口拉回屏幕，盖在图片墙上，且再也不消失。
`tools/appkit_fullscreen_exit.swift` 把这段时序测成了数字：frame 落到终值比
`windowDidExitFullScreen:` 早约 530ms，靠「多等一会儿」补不上。

直接 `destroy()` 一个仍处在全屏的窗口，AppKit 自己走完 `didExit` 回收桌面，窗口
从层级里移除，全程没有常规尺寸的可见帧（同一探针的 `--close-in-fullscreen`
模式）。窗口实例都不存在了，也就谈不上残留。

代价是每次进入预览要重建一条 webview：`ensure_viewer_window()` 用
`WebviewWindowBuilder::from_config` 读 `tauri.conf.json` 里同一份配置，先查再建，
同一时刻最多一条 viewer，不会堆积或泄漏。首图预热与切全屏并行进行，这点开销
被那段躲不掉的平台转场吃掉了。反过来，那条窗口的几何从来不需要保存：它每次
都是 `viewer_ready` 里 `set_fullscreen(true)` 直接进全屏，销毁时没有任何还原目标。

**Q：为什么 `viewer_ready` 里不摆尺寸、也不 maximize？**

与上面是同一条规则的两面。预览窗口的**唯一**形态是操作系统级全屏：
Windows 上盖住任务栏，macOS 上搬进独立 Space 并收起菜单栏与 Dock。
`maximize()` 做不到这些（它停在任务栏上方），而且最大化在本项目里没有撤回
路径 —— 一旦走到就把窗口永久钉在放大态。所以没有 `maximize()` 兜底：全屏拿
不到就保持窗口态，预览照样能用，比不可逆的一步安全。

万一某台机器上切全屏没把窗口带出来，前端量布局时会发现视口没铺满，自己补一次
`showWindow()`；`lib.rs` 里还有一道 3 秒的全局兜底（它先问「预览起来了没有」
再决定要不要点亮**主窗口**）。两道都只补可见性，不碰几何。

**Q：命令行传文件没反应？**

`argv_targets()` 会丢掉以 `-` 开头的参数和磁盘上不存在的路径。
另外 macOS 的「打开方式」根本不走 argv（走 Apple Event / `RunEvent::Opened`），
所以命令行只用于自测与 Windows / Linux。自测请用 debug 二进制，并且 dev 模式下
它是加载 `http://localhost:1420` 的（要先起 `node tools/serve.js`）。
