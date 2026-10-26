//! 图像解码 / 缩放 / 编码。
//!
//! 三条流水线：
//!   * `placeholder` —— 极小的模糊占位图（~24px，几百字节），网格滚动时先糊后清；
//!   * `thumb`       —— 网格缩略图（最长边 = 请求尺寸），JPEG 编码；
//!   * `full`        —— 原图字节直出（无损、保留 GIF 动画 & EXIF 旋转），
//!                      仅在前端判断「超大图」时才走 `?max=` 重编码分支。

use std::path::Path;

use image::{
    codecs::jpeg::JpegEncoder,
    metadata::Orientation,
    DynamicImage, ImageDecoder, ImageEncoder, ImageReader,
};

use crate::error::Result;

/// 占位图最长边
const PLACEHOLDER_EDGE: u32 = 24;

/// 一次性打开并解码，同时按 EXIF 方向摆正。
pub fn decode_file(path: &Path) -> Result<DynamicImage> {
    let (mut img, orientation) = open_decoder(path)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// 只读取头部拿到「显示方向下的宽高」，不完整解码。扫描阶段用它，
/// 保证几千张图片的目录也能在可接受时间内列出。
pub fn dimensions(path: &Path) -> Result<(u32, u32)> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (w, h) = decoder.dimensions();
    Ok(if swaps_axes(orientation) { (h, w) } else { (w, h) })
}

fn open_decoder(path: &Path) -> Result<(DynamicImage, Orientation)> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let img = DynamicImage::from_decoder(decoder)?;
    Ok((img, orientation))
}

fn swaps_axes(o: Orientation) -> bool {
    use Orientation as O;
    matches!(o, O::Rotate90 | O::Rotate270 | O::Rotate90FlipH | O::Rotate270FlipH)
}

pub fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(64 * 1024);
    let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    // 转成 RGB8：JPEG 不支持带 alpha 的输入，且统一色彩空间能避免 CMYK 等分支。
    let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
    encoder.write_image(
        rgb.as_bytes(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(buf)
}

/// 网格缩略图：按最长边等比缩放后编码为 JPEG。
pub fn make_thumbnail(path: &Path, max_edge: u32) -> Result<Vec<u8>> {
    let img = decode_file(path)?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(crate::error::msg("图片尺寸为 0"));
    }
    let thumb = if w.max(h) > max_edge {
        img.thumbnail(max_edge, max_edge)
    } else {
        img
    };
    encode_jpeg(&thumb, 82)
}

/// 模糊占位图：缩到 24px，低质量 JPEG，配合 CSS `filter: blur()` 使用。
pub fn make_placeholder(path: &Path) -> Result<Vec<u8>> {
    let img = decode_file(path)?;
    let tiny = img.thumbnail(PLACEHOLDER_EDGE, PLACEHOLDER_EDGE);
    encode_jpeg(&tiny, 40)
}

/// 原图。`max` 为 `None` 时直接返回文件字节；
/// 否则在超过 `max` 时等比缩小后重编码（用于超大图，避免 webview 解码 OOM）。
pub fn load_full(path: &Path, max: Option<u32>) -> Result<(Vec<u8>, &'static str)> {
    let ext = crate::state::ext_of(path).unwrap_or_default();

    match max {
        None => {
            let bytes = std::fs::read(path)?;
            Ok((bytes, mime_for(&ext)))
        }
        Some(limit) => {
            // 先用头部判断尺寸，只有确实超限时才付出完整解码的代价。
            let (w, h) = dimensions(path)?;
            if w.max(h) <= limit {
                let bytes = std::fs::read(path)?;
                Ok((bytes, mime_for(&ext)))
            } else {
                let img = decode_file(path)?;
                let scaled = img.resize(limit, limit, image::imageops::FilterType::Lanczos3);
                let bytes = encode_jpeg(&scaled, 92)?;
                Ok((bytes, "image/jpeg"))
            }
        }
    }
}

pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        _ => "image/jpeg",
    }
}
