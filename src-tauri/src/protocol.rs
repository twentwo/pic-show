//! `img://` 自定义协议 —— 图片数据的唯一出口。
//!
//! 为什么不走 IPC 返回 base64：
//!   * base64 会让体积膨胀 33%，且必须在 JS 侧做一次字符串拼接再解码，
//!     大图上会造成明显的主线程卡顿；
//!   * 自定义协议可以直接作为 `<img src>` 使用，解码与光栅化都在 webview
//!     的独立线程里完成，主线程只负责合成，天然不阻塞滚动和手势；
//!   * 响应上带 `Cache-Control`，webview 自己的 HTTP 缓存会自动帮我们兜底。
//!
//! URL 形式：
//!   img://localhost/placeholder/<id>
//!   img://localhost/thumb/<id>?s=360
//!   img://localhost/full/<id>[?max=4096]

use std::sync::{mpsc, Mutex, OnceLock};

use tauri::{
    http::{Request, Response, Uri},
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};

use crate::{error::Error, imaging, state::AppState};

/// 同时进行的解码任务数。解码是 CPU 密集型，无限制并发会把 UI 线程饿死。
const MAX_CONCURRENT_DECODES: usize = 3;

/// 图片变体。
enum Variant {
    /// 24px 模糊占位图
    Placeholder,
    /// 缩略图，最长边 = 参数
    Thumb(u32),
    /// 原图；`Some(n)` 表示超过 n 时降采样
    Full(Option<u32>),
}

pub fn img_protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let uri = request.uri().clone();

    // 解码放到独立线程；并发通过下面的信号量限制。
    std::thread::spawn(move || {
        let _permit = acquire_permit();
        responder.respond(handle(app, uri));
    });
}

fn handle<R: Runtime>(app: AppHandle<R>, uri: Uri) -> Response<Vec<u8>> {
    match route(&app, &uri) {
        Ok((mime, bytes)) => ok(mime, bytes),
        Err(e) => {
            eprintln!("[img] {} -> {}", uri.path(), e);
            Response::builder()
                .status(404)
                .header("Content-Type", "text/plain; charset=utf-8")
                .header("Cache-Control", "no-store")
                .header("Access-Control-Allow-Origin", "*")
                .body(e.to_string().into_bytes())
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
    }
}

fn route<R: Runtime>(app: &AppHandle<R>, uri: &Uri) -> Result<(&'static str, Vec<u8>), Error> {
    let state = app.state::<AppState>();

    let variant = parse_variant(uri)?;
    let id = variant_id(uri)?;

    let item = state.item(id).ok_or_else(|| Error::Msg("未知图片 id".into()))?;
    let path = state.path_of(id).ok_or_else(|| Error::Msg("未知图片路径".into()))?;

    match variant {
        Variant::Placeholder => {
            // 占位图和缩略图都是「派生数据」，值得落盘缓存。
            cached(&state, &format!("p:{id}:{}", item.modified), || {
                imaging::make_placeholder(&path)
            })
            .map(|bytes| ("image/jpeg", bytes))
        }
        Variant::Thumb(size) => {
            cached(&state, &format!("t:{id}:{size}:{}", item.modified), || {
                imaging::make_thumbnail(&path, size)
            })
            .map(|bytes| ("image/jpeg", bytes))
        }
        Variant::Full(max) => {
            // 原图不做缓存：文件系统本身就是最好的缓存。
            let (bytes, mime) = imaging::load_full(&path, max)?;
            Ok((mime, bytes))
        }
    }
}

fn variant_id(uri: &Uri) -> Result<u32, Error> {
    let last = uri
        .path()
        .trim_matches('/')
        .split('/')
        .last()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Msg("缺少图片 id".into()))?;
    last.parse()
        .map_err(|_| Error::Msg(format!("非法 id: {last}")))
}

fn parse_variant(uri: &Uri) -> Result<Variant, Error> {
    let kind = uri
        .path()
        .trim_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();

    let query = parse_query(uri.query());

    match kind {
        "placeholder" => Ok(Variant::Placeholder),
        "thumb" => {
            let size = query
                .get("s")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(360)
                .clamp(32, 2048);
            Ok(Variant::Thumb(size))
        }
        "full" => {
            let max = query.get("max").and_then(|v| v.parse::<u32>().ok());
            Ok(Variant::Full(max))
        }
        other => Err(Error::Msg(format!("未知变体: {other}"))),
    }
}

/// 两级缓存：先查内存 LRU，再查磁盘；都没有才调用 `generate` 并写回两级。
fn cached<F>(state: &AppState, key: &str, generate: F) -> Result<Vec<u8>, Error>
where
    F: FnOnce() -> Result<Vec<u8>, Error>,
{
    if let Some(bytes) = state.mem_get(key) {
        return Ok((*bytes).clone());
    }

    if let Some(disk) = state.disk_path(key) {
        if let Ok(bytes) = std::fs::read(&disk) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }

    let bytes = generate()?;

    if let Some(disk) = state.disk_path(key) {
        // 磁盘写入失败不应该让图片加载失败：忽略即可。
        let _ = std::fs::write(&disk, &bytes);
    }
    let arc = state.mem_put(key.to_string(), bytes);
    Ok((*arc).clone())
}

fn ok(content_type: &'static str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Content-Length", bytes.len().to_string())
        // id 与 mtime 都参与缓存键，所以可以放心长期缓存。
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn parse_query(query: Option<&str>) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                map.insert(k.to_string(), v.to_string());
            }
        }
    }
    map
}

/// 极简信号量：用带 N 个令牌的 channel 实现。
struct Permit(mpsc::Sender<()>);

impl Drop for Permit {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

static LIMITER: OnceLock<(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>)> = OnceLock::new();

fn acquire_permit() -> Option<Permit> {
    let (tx, rx) = LIMITER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        for _ in 0..MAX_CONCURRENT_DECODES {
            let _ = tx.send(());
        }
        (tx, Mutex::new(rx))
    });
    rx.lock().unwrap().recv().ok().map(|_| Permit(tx.clone()))
}
