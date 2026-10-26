//! 对前端暴露的 Tauri 命令。
//!
//! 设计约定：**打开资源是异步的**。`pick_images` 只是弹窗，
//! 真正的结果通过 `picshow://items` 事件推给前端——因为系统文件对话框
//! 的回调是 `FnOnce`，没法直接变成命令的返回值，硬要把异步转成同步
//! 只会阻塞 UI 线程。

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::{model::ImageItem, model::ItemsPayload, scanner, state::AppState};

/// 图片集合更新事件名。
pub const ITEMS_EVENT: &str = "picshow://items";

/// 弹出系统文件/文件夹选择框，结果通过 `ITEMS_EVENT` 事件推送。
///
/// `kind`: `"folder"` 选择文件夹，其它值均视为多选文件。
#[tauri::command]
pub fn pick_images(app: AppHandle, kind: String) {
    let dialog = app.dialog().file();
    let handle = app.clone();

    if kind == "folder" {
        dialog
            .set_title("选择图片文件夹")
            .pick_folder(move |picked| {
                let paths = picked
                    .and_then(to_path)
                    .map(|p| vec![p])
                    .unwrap_or_default();
                publish(handle, paths);
            });
    } else {
        dialog
            .set_title("选择图片")
            .add_filter("图片", scanner::IMAGE_EXTS)
            .pick_files(move |picked| {
                let paths = picked
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(to_path)
                    .collect();
                publish(handle, paths);
            });
    }
}

/// 直接打开一个文件夹（供「最近打开」、拖放、命令行参数使用）。
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<Vec<ImageItem>, String> {
    let paths = vec![PathBuf::from(path)];
    let expanded = scanner::expand(&paths, true);
    if expanded.is_empty() {
        return Err("该文件夹中没有找到支持的图片".into());
    }
    let source = scanner::source_name(&paths);
    let items = app.state::<AppState>().replace(expanded);
    emit(&app, items.clone(), source);
    Ok(items)
}

/// 直接打开一组文件路径。
#[tauri::command]
pub fn open_paths(app: AppHandle, paths: Vec<String>) -> Result<Vec<ImageItem>, String> {
    let inputs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let expanded = scanner::expand(&inputs, true);
    if expanded.is_empty() {
        return Err("没有找到支持的图片".into());
    }
    let source = scanner::source_name(&inputs);
    let items = app.state::<AppState>().replace(expanded);
    emit(&app, items.clone(), source);
    Ok(items)
}

/// 在系统文件管理器中定位到某张图片。
///
/// 只接受会话内的 `id`，不把磁盘路径暴露给 webview——这样即使前端
/// 被注入恶意脚本，也无法枚举用户目录结构。
#[tauri::command]
pub fn reveal_image(app: AppHandle, id: u32) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = state.path_of(id).ok_or_else(|| "未知图片 id".to_string())?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/// 缓存状态，用于调试面板。
#[tauri::command]
pub fn cache_stats(app: AppHandle) -> crate::model::CacheStats {
    app.state::<AppState>().stats()
}

/// 前端首屏装配完成后调用，把窗口真正显示出来。
///
/// 窗口在 `tauri.conf.json` 里配的是 `visible: false`——这是为了避免
/// webview 在 CSS 生效前先闪一帧白底。代价就是**必须**有人负责把它点亮，
/// 否则窗口会一直隐身，用户只能看到一个「启动了但什么都没有」的进程。
///
/// 用自定义命令而不是内置的 `plugin:window|show`：应用自带的命令不走
/// capabilities 权限校验，少一处配置出错的可能；顺带把焦点也一起设了。
#[tauri::command]
pub fn window_ready(app: AppHandle) {
    reveal_main_window(&app);
}

/// 显示并聚焦主窗口；窗口不存在时静默跳过。
pub(crate) fn reveal_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn to_path(fp: FilePath) -> Option<PathBuf> {
    fp.into_path().ok()
}

fn publish(app: AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let source = scanner::source_name(&paths);
    let expanded = scanner::expand(&paths, true);
    if expanded.is_empty() {
        return;
    }
    let items = app.state::<AppState>().replace(expanded);
    emit(&app, items, source);
}

fn emit<R: tauri::Runtime>(app: &AppHandle<R>, items: Vec<ImageItem>, source: String) {
    if let Err(e) = app.emit(ITEMS_EVENT, ItemsPayload { items, source }) {
        eprintln!("[picshow] 推送图片列表失败: {e}");
    }
}
