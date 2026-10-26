//! 路径收集与排序：把「用户选择的文件/文件夹」展开成有序的图片路径列表。

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// 支持的图片扩展名（与 `image` crate 默认启用的格式对齐）。
pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "bmp", "ico", "tif", "tiff", "tga", "dds",
    "ff", "qoi", "hdr", "exr", "ppm", "pgm", "pbm", "pnm",
];

/// 递归扫描目录。
pub fn scan_dir(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let walker = if recursive {
        WalkDir::new(dir).follow_links(true)
    } else {
        WalkDir::new(dir).max_depth(1).follow_links(true)
    };

    let mut out: Vec<PathBuf> = walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| crate::state::looks_like_image(p))
        .collect();

    out.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    out
}

/// 扫描 `target` 所在目录下的**同级**图片（不递归），按文件名自然排序，
/// 并返回 `target` 在结果里的下标。
///
/// 这是「在文件管理器里右键 → 用 PicShow 打开」的核心：
/// 用户点的是某一张，打开的却是**整个目录**，于是左右键就能接着翻。
/// 排序刻意与文件管理器的「按名称」一致（数字按数值、忽略大小写），
/// 否则 `IMG_10` 会排在 `IMG_2` 前面，翻页顺序和用户看到的完全不同。
pub fn scan_siblings(target: &Path) -> (Vec<PathBuf>, Option<usize>) {
    let Some(dir) = target.parent().filter(|p| p.is_dir()) else {
        return (Vec::new(), None);
    };

    let mut out = scan_dir(dir, false);
    let index = position_of(&out, target);

    // 目录里居然没有它（例如传入路径的大小写与磁盘不一致）：只要它本身是
    // 支持的图片就补进去 —— 至少「我右键的那一张」必须能看到。
    if index.is_none() && target.is_file() && crate::state::looks_like_image(target) {
        out.push(target.to_path_buf());
        out.sort_by(|a, b| natural_cmp(&name_of(a), &name_of(b)));
    }

    let index = index.or_else(|| position_of(&out, target));
    (out, index)
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 同一个目录内文件名唯一，所以按文件名定位就够了 —— 比逐个
/// `canonicalize()`（每张图一次系统调用）便宜得多。
fn position_of(list: &[PathBuf], target: &Path) -> Option<usize> {
    let want = name_of(target);
    if want.is_empty() {
        return None;
    }
    list.iter().position(|p| {
        let got = name_of(p);
        got == want || got.eq_ignore_ascii_case(&want)
    })
}

/// 把混合的文件/目录列表展开。
pub fn expand(inputs: &[PathBuf], recursive: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for input in inputs {
        let meta = match std::fs::metadata(input) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            out.extend(scan_dir(input, recursive));
        } else if meta.is_file() && crate::state::looks_like_image(input) {
            out.push(input.clone());
        }
    }
    out
}

/// 从 `inputs` 推断一个用于窗口标题展示的来源名。
pub fn source_name(inputs: &[PathBuf]) -> String {
    match inputs.first() {
        None => String::from("PicShow"),
        Some(p) => p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string_lossy().to_string()),
    }
}

/// 自然排序：把字符串切成「数字块 / 非数字块」逐段比较，
/// 使 `IMG_2.jpg` 排在 `IMG_10.jpg` 之前。
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut ia = a.chars().peekable();
    let mut ib = b.chars().peekable();

    loop {
        match (ia.peek().copied(), ib.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let na: String = take_digits(&mut ia);
                    let nb: String = take_digits(&mut ib);
                    // 去掉前导零后按长度再按字典序比较，等价于数值比较且不溢出
                    let ta = na.trim_start_matches('0');
                    let tb = nb.trim_start_matches('0');
                    let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                } else {
                    let oa = ca.to_ascii_lowercase();
                    let ob = cb.to_ascii_lowercase();
                    if oa != ob {
                        return oa.cmp(&ob);
                    }
                    ia.next();
                    ib.next();
                }
            }
        }
    }
}

fn take_digits<I: Iterator<Item = char>>(it: &mut std::iter::Peekable<I>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek() {
        if c.is_ascii_digit() {
            s.push(*c);
            it.next();
        } else {
            break;
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{natural_cmp, scan_siblings};
    use std::path::PathBuf;

    #[test]
    fn orders_numbers_naturally() {
        let mut v = vec!["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
    }

    /// 搭一个临时目录，返回它的路径（调用方自行清理）。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "picshow-scan-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn touch(dir: &std::path::Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"x").expect("写入临时文件");
        p
    }

    fn names(list: &[PathBuf]) -> Vec<String> {
        list.iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn siblings_are_sorted_like_the_file_manager() {
        let dir = temp_dir("siblings");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("创建子目录");

        let target = touch(&dir, "IMG_10.jpg");
        touch(&dir, "IMG_2.jpg");
        touch(&dir, "IMG_1.jpg");
        // 子目录里的图不应被算进「同目录」集合
        touch(&sub, "IMG_3.jpg");
        // 非图片文件同样排除
        touch(&dir, "notes.txt");

        let (list, index) = scan_siblings(&target);
        assert_eq!(names(&list), vec!["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
        assert_eq!(index, Some(2));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sibling_of_a_lonely_file_is_itself() {
        let dir = temp_dir("lonely");
        let target = touch(&dir, "only.png");

        let (list, index) = scan_siblings(&target);
        assert_eq!(names(&list), vec!["only.png"]);
        assert_eq!(index, Some(0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_target_is_not_injected() {
        let dir = temp_dir("unsupported");
        let target = touch(&dir, "movie.mp4");
        touch(&dir, "pic.jpg");

        let (list, index) = scan_siblings(&target);
        assert_eq!(names(&list), vec!["pic.jpg"]);
        assert_eq!(index, None, "不支持的格式不该被算作当前项");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
