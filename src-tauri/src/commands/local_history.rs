//! 本地历史命令层（PRD §3.12）
//!
//! 只做「取根目录 → 调 core → 转错误字符串」。磁盘 IO 一律丢进
//! `spawn_blocking`（照 `commands/compare.rs`），避免在异步运行时里阻塞。
//! 不设全局锁：应用是单实例单窗口，前端 `localHistoryStore` 已把所有写操作
//! 串行化；core 的 tmp+rename 也保证读不会读到半截文件。

use crate::core::local_history::{self, SnapshotInput, SnapshotMeta, SnapshotPatch};
use crate::error::{AppError, AppResult};
use std::path::PathBuf;

fn base() -> Result<PathBuf, String> {
    local_history::base_dir().map_err(|e| e.to_string())
}

async fn run<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("本地历史任务异常：{e}"))?
        .map_err(|e: AppError| e.to_string())
}

/// 列出某文件的快照元数据（不含正文）。
#[tauri::command]
pub async fn history_list(path: String) -> Result<Vec<SnapshotMeta>, String> {
    let base = base()?;
    run(move || local_history::list(&base, &path)).await
}

/// 按需读取单条快照正文。
#[tauri::command]
pub async fn history_read(path: String, id: String) -> Result<Option<String>, String> {
    let base = base()?;
    run(move || local_history::read(&base, &path, &id)).await
}

/// 写一条快照；`input.path` 由 core 折成稳定 docId。
#[tauri::command]
pub async fn history_write(input: SnapshotInput) -> Result<(), String> {
    let base = base()?;
    run(move || local_history::write(&base, &input)).await
}

/// 改置顶 / 已保存标记 / 标签。
#[tauri::command]
pub async fn history_update(path: String, id: String, patch: SnapshotPatch) -> Result<(), String> {
    let base = base()?;
    run(move || local_history::update(&base, &path, &id, &patch)).await
}

/// 淘汰指定快照，返回删除失败的 id（空 = 全成功）。
#[tauri::command]
pub async fn history_remove(path: String, ids: Vec<String>) -> Result<Vec<String>, String> {
    let base = base()?;
    run(move || local_history::remove(&base, &path, &ids)).await
}

/// 彻底清除。`paths` 为空 = 清空全部；非空 = 按文件逐个删目录 + 摘映射。
/// 前端在「不保存 / 全部不保存」分支调用，返回失败路径供 toast 提示。
#[tauri::command]
pub async fn history_clear(paths: Vec<String>) -> Result<Vec<String>, String> {
    let base = base()?;
    run(move || local_history::clear(&base, &paths)).await
}

/// 实际占用字节数（按真实 `.snap` 文件统计，含孤儿）。
#[tauri::command]
pub async fn history_total_bytes() -> Result<u64, String> {
    let base = base()?;
    run(move || local_history::total_bytes(&base)).await
}
