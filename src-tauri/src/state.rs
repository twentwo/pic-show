//! 全局状态：图片注册表 + 两级缓存（内存 LRU / 磁盘）。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};

use moka::sync::Cache;
use parking_lot::RwLock;

use crate::model::ImageItem;

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
