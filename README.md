# PicShow

用 **Tauri 2 + 原生 HTML/CSS/JS** 写的跨平台桌面照片查看器，复刻早期 Google Picasso 的看图体验：
连续性展开转场、跟手缩放平移、下拉即关、控件自动隐身。

后端 Rust（图像解码 / 缩略图 / 缓存 / 协议），前端零依赖、零打包步骤——改完代码刷新窗口就生效。

---

## 一、特性对照

| 需求 | 实现位置 | 说明 |
| --- | --- | --- |
| 打开图片/文件夹 | `commands.rs` `pick_images` / `open_paths` / `open_folder` | 系统对话框 + 窗口内拖放 |
| 缩略图网格 / 全屏查看 | `grid.js` / `viewer.js` | justified 等高行 + 虚拟化滚动 |
| 双击 / 滚轮 / 键盘 / 捏合缩放 | `gestures.js` | 统一锚点缩放，连续无级 |
| 拖拽平移 + 越界回弹 | `geometry.js` `settle()` | iOS 风格橡皮筋阻尼 |
| 连续转场 | `viewer.js` `open()` / `close()` | FLIP：缩略图矩形 ↔ 适配矩形 |
| 下拉关闭 | `gestures.js`  dismiss 分支 | 速度 / 位移双阈值判定 |
| 控件自动淡出 | `viewer.js` `bumpControls()` | 2.2s 空闲后隐藏，含鼠标指针 |
| ← → 切换 / Esc 退出 / 纯黑背景 | `viewer.js` `onKeyDown()` | |
| 低分辨率占位 → 原图渐进替换 | `viewer.js` `buildSlide()` | 复用网格已缓存缩略图，命中即秒开 |
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
│   ├── styles/app.css
│   └── js/
│       ├── tauri.js                # 极简 Tauri v2 IPC 封装（invoke/listen）
│       ├── api.js                  # 后端门面：命令 + 图片 URL + 前端解码缓存
│       ├── geometry.js             # 缩放/平移/橡皮筋 纯数学
│       ├── grid.js                 # 虚拟化 justified 网格
│       ├── gestures.js             # 指针/滚轮/捏合 状态机
│       ├── viewer.js               # 全屏查看器 + FLIP 转场
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
│   └── check_methods.mjs           # 跨文件检查未定义方法 / 失效导入
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
npm run check        # cargo check + 几何测试 + 方法/导入检查（改动后跑一遍）
npm test             # 验证缩放/平移/FLIP 的数学（纯 Node，无需浏览器）
npm run test:methods # 检查未定义方法与失效导入
npm run rust:check   # 只做 cargo check
npm run rust:test    # 跑后端单测
```

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
| 双指捏合 | 触摸设备上的连续缩放 + 双指平移 |
| 拖拽（放大态） | 平移，越界橡皮筋回弹，松手带惯性 |
| 下拉（未放大） | 跟手缩小，松手按速度/位移决定关闭或回弹 |
| `←` `→` | 上一张 / 下一张 |
| `+` `-` `0` | 放大 / 缩小 / 适应窗口 |
| `Esc` | 返回网格 |
| 单击 | 唤醒 / 隐藏控件 |
| `Ctrl/Cmd + O` | 选择图片（`+Shift` 选择文件夹） |

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

### 5. 橡皮筋与惯性

内部维护两套平移量（见 `gestures.js` 顶部注释）：
`rawX/rawY` 是累加基准，`tx/ty` = clamp(raw) + rubberband(超出量)。
分开存是为了避免橡皮筋位移被逐帧重复累加、越拖越偏。

### 6. 渐进加载

网格与全屏查看器共用**同一个**缩略图 URL（`THUMB_SIZE` 由行高推导），
所以点开大图时底图必然命中缓存，立刻显示；原图到位后再淡入覆盖。
超过 4000 万像素的图会自动请求降采样版本，避免 webview 解码爆内存。

---

## 七、快捷键与手势常量

集中在 `viewer.js` 与 `gestures.js` 顶部，常见调整：

```js
// gestures.js
const RUBBER = 140;                   // 橡皮筋最大位移
const DISMISS_DISTANCE_RATIO = 0.2;   // 下拉关闭位移阈值（视口高度比例）
const DISMISS_VELOCITY = 0.55;        // 下拉关闭速度阈值（px/ms）

// viewer.js
const IDLE_MS = 2200;                 // 控件自动隐藏时间
const DOUBLE_TAP_SCALE = 2.6;         // 双击放大倍率

// api.js
const GRID_ROW_H = 210;               // 网格行高（缩略图尺寸随之变化）
```

---

## 八、常见问题

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

**Q：HEIC / AVIF 打不开？**
`image` crate 默认不支持这两种格式。需要的话在 `Cargo.toml` 里加 `image = { version = "0.25", features = ["avif"] }`（AVIF 会引入 dav1d，编译较慢），HEIC 则需额外的解码库。

**Q：想改网格密度？**
改 `api.js` 里的 `GRID_ROW_H`，缩略图请求尺寸会同步推导，保证网格与全屏底图命中同一份缓存。
