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

/// `picshow://cache` 事件的载荷（调试/状态栏用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub entries: u64,
    pub bytes: u64,
}
