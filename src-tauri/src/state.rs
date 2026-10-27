//! 全局状态：图片注册表 + 两级缓存（内存 LRU / 磁盘）。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};

use moka::sync::Cache;
use parking_lot::RwLock;

use crate::model::{ImageItem, LaunchOrigin, LaunchPayload};

/// 内存缓存上限（字节）。缩略图/占位图体积都很小，256MB 足够覆盖几千张。
const MEM_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// 一次会话内所有已注册图片。
pub struct AppState {
    next_id: AtomicU32,
    /// id -> 元信息
    items: RwLock<HashMap<u32, ImageItem>>,
    /// id -> 绝对路径
    paths: RwLock<HashMap<u32, PathBuf>>,
    /// 变体缓存：key(`thumb:360:12`) -> 编码后的字节
    mem: Cache<String, Arc<Vec<u8>>>,
    cache_dir: RwLock<Option<PathBuf>>,
    /// 缓存命中/未命中计数，仅用于状态展示
    hits: AtomicU64,
    misses: AtomicU64,
    /// 系统（Finder / 资源管理器 / 命令行）要求打开的文件。
    ///
    /// 前端首屏可能还没装配完——那时事件没人接，所以既发事件也留一份，
    /// 由前端 ready 后主动 `take_launch_target()` 取走。
    launch: RwLock<Option<LaunchPayload>>,
    /// 前端是否已上报首屏就绪（见 `commands::window_ready`）。
    ready: AtomicBool,
    /// 本次启动是不是「被系统要求打开某张图」唤起的。
    launched: AtomicBool,
    /// 目标文件名（用于窗口标题）。
    launch_title: RwLock<Option<String>>,
    /// 是否处于沉浸式预览（无原生标题栏，画面铺满窗口）。
    immersive: AtomicBool,
    /// 「从文件管理器打开」时那张缩略图的近似位置（见 `model::LaunchOrigin`）。
    ///
    /// 由 `commands::capture_launch_origin` 在**后台线程**里补写，可能比前端
    /// 取 `take_launch_target` 晚一点点；前端在真正要播动画前才读它。
    launch_origin: RwLock<Option<LaunchOrigin>>,
    /// 进程启动时刻。
    ///
    /// 「这次启动是不是被系统要求打开某张图」这件事，在 macOS 上要到事件循环
    /// 转起来之后才由 Apple Event 告知 —— 那时前端首屏可能已经装配完了。
    /// 于是给它设一个**从进程启动时刻起算**的绝对截止点（见
    /// `commands::LAUNCH_DECIDE_MS`）：早于截止点，主界面宁可继续藏着；
    /// 过了截止点还没消息，就按常规启动点亮。
    ///
    /// 用绝对时刻而不是「从前端发问起等 N 毫秒」：前者在首屏加载慢的机器上
    /// 剩余预算已经是 0，常规启动一点都不被拖慢。
    started: Instant,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            items: RwLock::new(HashMap::new()),
            paths: RwLock::new(HashMap::new()),
            mem: Cache::builder()
                .weigher(|_key, value: &Arc<Vec<u8>>| value.len() as u32)
                .max_capacity(MEM_CACHE_BYTES)
                .build(),
            cache_dir: RwLock::new(None),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            launch: RwLock::new(None),
            ready: AtomicBool::new(false),
            launched: AtomicBool::new(false),
            launch_title: RwLock::new(None),
            immersive: AtomicBool::new(false),
            launch_origin: RwLock::new(None),
            started: Instant::now(),
        }
    }
}

impl AppState {
    /// 设置磁盘缓存目录（应用数据目录）。
    pub fn set_cache_dir(&self, dir: PathBuf) {
        let thumbs = dir.join("thumbs");
        let _ = std::fs::create_dir_all(&thumbs);
        *self.cache_dir.write() = Some(thumbs);
    }

    fn cache_dir(&self) -> Option<PathBuf> {
        self.cache_dir.read().clone()
    }

    /// 清空当前集合并用 `paths` 建立新集合。
    pub fn replace(&self, paths: Vec<PathBuf>) -> Vec<ImageItem> {
        self.items.write().clear();
        self.paths.write().clear();
        self.register(paths)
    }

    fn register(&self, paths: Vec<PathBuf>) -> Vec<ImageItem> {
        use rayon::prelude::*;

        // 并行读取尺寸：这是扫描阶段唯一的解码开销，只读取头部，不做完整解码。
        let metas: Vec<(PathBuf, Option<(u32, u32)>)> = paths
            .into_par_iter()
            .map(|p| {
                let dim = crate::imaging::dimensions(&p).ok();
                (p, dim)
            })
            .collect();

        let mut items = self.items.write();
        let mut paths_map = self.paths.write();
        let mut out = Vec::with_capacity(metas.len());

        for (path, dim) in metas {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let (width, height) = dim.unwrap_or((0, 0));
            let meta = std::fs::metadata(&path);
            let (size, modified) = match &meta {
                Ok(m) => (
                    m.len(),
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                ),
                Err(_) => (0, 0),
            };
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            let item = ImageItem { id, name, width, height, size, modified };
            items.insert(id, item.clone());
            paths_map.insert(id, path);
            out.push(item);
        }
        out
    }

    /// 前端首屏已装配完（此后才能安全地显示窗口）。
    pub fn set_ready(&self) {
        self.ready.store(true, Ordering::Relaxed);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }

    /// 记下「这次是被系统唤起看图的」，并留好窗口标题。
    pub fn mark_launched(&self, title: String) {
        self.launched.store(true, Ordering::Relaxed);
        *self.launch_title.write() = Some(title);
    }

    pub fn was_launched(&self) -> bool {
        self.launched.load(Ordering::Relaxed)
    }

    pub fn launch_title(&self) -> Option<String> {
        self.launch_title.read().clone()
    }

    /// 切到 / 退出沉浸式预览（无原生标题栏）。
    ///
    /// 由前端在打开大图前设置，后端据此在窗口显示前就把装饰关掉 ——
    /// 亮起来之后再改形态，用户会看见标题栏「出现又消失」的跳动。
    pub fn set_immersive(&self, enabled: bool) {
        self.immersive.store(enabled, Ordering::Relaxed);
    }

    pub fn is_immersive(&self) -> bool {
        self.immersive.load(Ordering::Relaxed)
    }

    /// 存一份待处理的「系统要求打开」请求。
    pub fn set_launch(&self, payload: Option<LaunchPayload>) {
        *self.launch.write() = payload;
    }

    /// 还有一份没被取走的「待取件」。
    ///
    /// `window_ready` 靠它判断「这次启动是不是已经被预览分支接管」：接管了就
    /// 绝不能再点亮主界面，否则就是「主界面一闪而过」。
    pub fn has_pending_launch(&self) -> bool {
        self.launch.read().is_some()
    }

    /// 距离「启动意图判定」的截止时刻还剩多少毫秒（0 表示该决定了）。
    pub fn launch_decision_budget(&self, budget_ms: u64) -> u64 {
        let elapsed = self.started.elapsed().as_millis() as u64;
        budget_ms.saturating_sub(elapsed)
    }

    /// 取走待处理的启动请求（取完即清空，避免重复打开）。
    ///
    /// 注意**不要**顺手清掉 `launch_origin`：那份数据是后台线程补写的，
    /// 此刻大概率还没到 —— 清了就只剩中心兜底动画了。它的新鲜度由
    /// `commands::deliver_launch` 在派发新请求时负责（先置空再重新询问）。
    pub fn take_launch(&self) -> Option<LaunchPayload> {
        self.launch.write().take()
    }

    /// 记下来源矩形（后台线程补写，见 `commands::capture_launch_origin`）。
    pub fn set_launch_origin(&self, origin: Option<LaunchOrigin>) {
        *self.launch_origin.write() = origin;
    }

    pub fn launch_origin(&self) -> Option<LaunchOrigin> {
        *self.launch_origin.read()
    }

    pub fn item(&self, id: u32) -> Option<ImageItem> {
        self.items.read().get(&id).cloned()
    }

    pub fn path_of(&self, id: u32) -> Option<PathBuf> {
        self.paths.read().get(&id).cloned()
    }

    /// 读取内存缓存；命中则累加计数。
    pub fn mem_get(&self, key: &str) -> Option<Arc<Vec<u8>>> {
        let v = self.mem.get(key);
        if v.is_some() {
            self.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.misses.fetch_add(1, Ordering::Relaxed);
        }
        v
    }

    pub fn mem_put(&self, key: String, bytes: Vec<u8>) -> Arc<Vec<u8>> {
        let v = Arc::new(bytes);
        self.mem.insert(key, v.clone());
        v
    }

    /// 变体在磁盘上的缓存路径（幂等：同样的输入得到同样的文件名）。
    pub fn disk_path(&self, key: &str) -> Option<PathBuf> {
        self.cache_dir().map(|d| d.join(format!("{:016x}.jpg", hash(key))))
    }

    pub fn stats(&self) -> crate::model::CacheStats {
        crate::model::CacheStats {
            entries: self.mem.entry_count(),
            bytes: self.mem.weighted_size(),
        }
    }
}

/// FNV-1a 64 位哈希，仅用于生成缓存文件名，无安全用途。
fn hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 判断扩展名是否为我们支持的图片格式。
pub fn looks_like_image(path: &Path) -> bool {
    matches!(
        ext_of(path).as_deref(),
        Some("jpg" | "jpeg" | "jpe" | "jfif" | "png" | "gif" | "webp" | "bmp" | "ico"
        | "tif" | "tiff" | "tga" | "dds" | "ff" | "qoi" | "hdr" | "exr" | "ppm"
        | "pgm" | "pbm" | "pnm")
    )
}

pub fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}
