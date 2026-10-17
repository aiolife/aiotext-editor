//! F-01 §1.2 会话与未保存恢复命令（第九阶段）
//!
//! 与 `commands/settings.rs` 同形：三个命令都很轻（一份几 KB 的 JSON），
//! 写成 `async fn` 但不套 `spawn_blocking`（那点 I/O 不值得多一次线程切换）。

use crate::core::session::{self, SessionState};

/// 读取上次会话。
///
/// **永不失败**：文件不存在（首次启动）、不可读、JSON 坏掉、个别标签坏掉，
/// 都会得到一份可用的会话（坏标签丢弃，其余保留）。会话文件不该有能力让应用起不来。
#[tauri::command]
pub async fn session_load() -> SessionState {
    session::load()
}

/// 保存会话；返回**实际落盘**的值（已纠正越界的光标 / 行尾）
#[tauri::command]
pub async fn session_save(state: SessionState) -> Result<SessionState, String> {
    session::save(&state).map_err(|e| e.to_string())
}

/// 清除会话（连同 `.bad` / `.tmp` 残留）：下次启动回到「一个空标签」
#[tauri::command]
pub async fn session_clear() -> Result<(), String> {
    session::clear().map_err(|e| e.to_string())
}
