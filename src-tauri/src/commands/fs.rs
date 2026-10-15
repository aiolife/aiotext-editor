//! 文件 I/O 命令（F-02 多编码 I/O）
//!
//! 命令层约定（docs/03-tech-architecture.md §3.2）：
//! 只做参数解析 → 调 core → 构造返回类型，不含业务逻辑。

use crate::core::encoding::{self, Encoding, SaveOptions};

/// 读取文件：自动探测编码并解码（F-02 §2.2 检测顺序）。
#[tauri::command]
pub async fn fs_read(path: String) -> Result<encoding::LoadResult, String> {
    encoding::read_file(&path).map_err(|e| e.to_string())
}

/// 按手选编码重新读取（「重新载入」，F-02 §2.2）。
#[tauri::command]
pub async fn fs_read_with(
    path: String,
    encoding_label: String,
) -> Result<encoding::LoadResult, String> {
    let enc = Encoding::from_label(&encoding_label)
        .ok_or_else(|| format!("不支持的编码：{encoding_label}"))?;
    encoding::read_file_with(&path, enc).map_err(|e| e.to_string())
}

/// 保存前预检：定位目标编码不可表示的字符（F-02 §2.4）。
#[tauri::command]
pub async fn fs_check_mappable(
    text: String,
    encoding_label: String,
) -> Result<Vec<encoding::UnmappableChar>, String> {
    let enc = Encoding::from_label(&encoding_label)
        .ok_or_else(|| format!("不支持的编码：{encoding_label}"))?;
    Ok(encoding::check_mappable(&text, enc))
}

/// 编码写出文件（F-02 §2.4 `fs_write`）。
///
/// `UnmappablePolicy::Ask` 且存在不可编码字符时返回错误，
/// 前端据此弹窗供用户决策后，以 CharRef / ToUtf8 重调本命令。
#[tauri::command]
pub async fn fs_write(
    path: String,
    text: String,
    opts: SaveOptions,
) -> Result<encoding::SaveReport, String> {
    encoding::write_file(&path, &text, opts).map_err(|e| e.to_string())
}
