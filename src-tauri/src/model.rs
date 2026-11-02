//! 前后端共用的数据模型。

use serde::{Deserialize, Serialize};

/// 一张图片的基础信息。
///
/// `id` 只在本次会话内有效：它是后端注册表里的句柄，
/// 前端用 `id` 拼出 `img://localhost/thumb/<id>` 这样的地址，
/// 从而避免把完整文件路径（可能含中文、空格、敏感目录）暴露给 webview。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageItem {
    pub id: u32,
    /// 文件名（含扩展名）
    pub name: String,
    /// 原始像素宽高；扫描时读取，用于网格占位与 FLIP 转场的初始计算
    pub width: u32,
    pub height: u32,
    /// 文件字节数
    pub size: u64,
    /// 秒级 UNIX 时间戳
    pub modified: u64,
}

/// `picshow://items` 事件的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsPayload {
    /// 本次打开的全部图片
    pub items: Vec<ImageItem>,
    /// 来源名称，用于窗口标题
    pub source: String,
}

/// 「从文件管理器打开某张图」的载荷。
///
/// 与 `ItemsPayload` 的区别：它多带一个 `index` —— 用户右键的是**哪一张**，
/// 打开后就要停在哪一张，而不是从头开始。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPayload {
    /// 目标图片所在目录里的全部图片（已按文件名自然排序）
    pub items: Vec<ImageItem>,
    /// 目标图片在 `items` 里的下标
    pub index: usize,
    /// 目录名，用于窗口标题
    pub source: String,
    /// 目标文件名
    pub name: String,
}

/**
 * 「从文件管理器打开」时的来源矩形：那张缩略图在屏幕上的位置与大小。
 *
 * 坐标是**物理像素**（`AppHandle::cursor_position()` 给的就是这个单位），
 * 原点在桌面左上角（多显示器时可负）；换算到 CSS 像素交给前端做，
 * 因为只有它知道 `devicePixelRatio` 与自己的窗口位置。
 *
 * 为什么拿不到真实矩形还要留这个结构：没有一个桌面平台会把「你刚点了哪一格」
 * 告诉被启动的进程。退而求其次，用**启动那一刻的光标位置**近似——用户必然是
 * 在那张图上面右键 / 双击的，实测这个近似足够贴近。真忘了 / 不支持就拿不到，
 * 届时前端退化为「屏幕中心 0.8 倍」的兜底动画（见 `ui/js/launch.js`）。
 */
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOrigin {
    /// 光标横坐标（物理像素，桌面坐标系）
    pub x: f64,
    /// 光标纵坐标（物理像素，桌面坐标系）
    pub y: f64,
    /// 来源那一格的边长（CSS 像素）—— 与文件管理器里图标的常见尺寸同量级
    pub size: f64,
}

/// `picshow://cache` 事件的载荷（调试/状态栏用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub entries: u64,
    pub bytes: u64,
}

/**
 * 屏幕坐标系里的一个矩形（CSS 像素，原点在桌面左上角，多显示器时可负）。
 *
 * 用来把「主窗口里那一格缩略图」的位置交给**另一个**窗口：预览窗口要用它当
 * 开场动画的起点，但它自己的视口原点未必是 (0,0)（全屏窗口落在哪块屏取决于
 * 主窗口在哪块屏）。所以统一用**屏幕坐标**做中间表示，谁拿到谁再减自己的
 * 原点 —— 跨窗口传几何只有这一种不会出错的表示法。
 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 屏幕坐标系里的一个点（CSS 像素）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/**
 * 预览窗口就绪时回报的「自己在哪儿、有多大」（**物理像素**）。
 *
 * `x / y` 是窗口左上角（把来源矩形从屏幕坐标折回视口坐标要用），
 * `width / height` 是内容区尺寸 —— 前端拿它判断「视口真的长到终态了没有」，
 * 比拿 `window.screen` 去猜准得多：多显示器、带缩放的屏上那两个值常常差着
 * 一两个像素，逼着人放宽阈值、于是白等好几帧。
 */
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/**
 * 主窗口发起的一次预览请求。
 *
 * 预览是**另一个物理窗口**，两个 webview 之间没有共享的 JS 上下文，所以这次
 * 请求的全部信息都得先落在后端，再由预览窗口自己来取。这是「状态共享」的
 * 唯一通道 —— 任何「让预览窗口直接去读主窗口的变量」的写法在这里都不成立。
 */
#[derive(Debug, Clone)]
pub struct ViewerRequest {
    /// 停在第几张
    pub index: usize,
    /// 开场动画起点（屏幕坐标）；拿不到时为 `None`
    pub origin: Option<OriginRect>,
    /// 这次预览是「从文件管理器打开」来的 —— 关闭即退出应用
    pub immersive: bool,
    /// 来源名称（用于预览窗口的标题）
    pub source: String,
    /// 这次请求的图片集合。两个 webview 不共享内存，图片集合只能随请求一起
    /// 递过去。
    pub items: Vec<ImageItem>,
}

/// `picshow://viewer-closed` 事件的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerClosed {
    /// 预览关闭时停在第几张 —— 主窗口据此把网格滚到那一张
    pub index: usize,
}

/// 预览窗口取走的会话：图片集合 + 停在哪一张 + 从哪儿长出来。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSession {
    pub items: Vec<ImageItem>,
    pub index: usize,
    /// 来源名称，用于窗口标题
    pub source: String,
    /// 关闭即退出应用（「打开方式」进来的会话）
    pub immersive: bool,
    /// 开场动画起点（屏幕坐标）；拿不到时为 `null`，前端退化为中心放大
    pub origin: Option<OriginRect>,
}
