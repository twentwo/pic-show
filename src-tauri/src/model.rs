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

/// `prepare_launch_window` 的入参：目标窗口矩形（CSS 像素，桌面坐标系）。
///
/// 让前端算而不是后端查：查显示器要用 `current_monitor()`，那是一个**阻塞等
/// 回执**的 getter —— 命令跑在主线程上的话就自己和自己死锁了。前端的
/// `window.screen` 本来就知道这一切，没必要绕这一遭。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchWindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `picshow://cache` 事件的载荷（调试/状态栏用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub entries: u64,
    pub bytes: u64,
}
