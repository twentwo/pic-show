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
    use super::natural_cmp;

    #[test]
    fn orders_numbers_naturally() {
        let mut v = vec!["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
    }
}
