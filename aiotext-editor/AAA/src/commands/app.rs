//! 应用级只读指标（第九阶段）
//!
//! 目前只有启动耗时：把「启动 < 1.5s」从口号变成前端与 E2E 都能读到的数字。

use crate::StartupMetrics;

/// 读取启动耗时指标（`run()` → `setup` 完成的毫秒数）
///
/// 同步命令：只是一次内存读取。写成 `async fn` 反而会因为 `State<'_>` 的借用
/// 活不过 `'static`（`Future + 'static`）而编译不过。
#[tauri::command]
pub fn startup_metrics(metrics: tauri::State<'_, StartupMetrics>) -> StartupMetrics {
    metrics.inner().clone()
}

/// 应用版本号（`Cargo.toml` 的 `version`），供「帮助 → 关于」显示
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
