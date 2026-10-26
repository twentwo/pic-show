//! 统一的错误类型。
//!
//! Tauri 命令的返回值需要 `Serialize`，因此这里手写实现，
//! 把错误压平成字符串传给前端（前端只需要展示信息，不需要结构化处理）。

use serde::ser::Serializer;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Image(#[from] image::ImageError),
}

impl serde::Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// 把任意 `Display` 类型快速包成 `Error`。
pub fn msg<T: std::fmt::Display>(e: T) -> Error {
    Error::Msg(e.to_string())
}
