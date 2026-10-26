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

/// 从一串原始路径里挑出**可打开的普通文件**（PRD §3.8 D-4 / D-5）
///
/// 界面拖放（`tauri://drag-drop`）会把拖进来的**目录**也放进 payload。这里统一按
/// 「只留存在的普通文件」过滤，与进程参数那条路（[`take_startup_files`]）合成
/// 同一套口径——不然两条拖拽路径的规则会各写一遍、慢慢走偏。
#[tauri::command]
pub fn filter_openable_paths(paths: Vec<String>) -> Vec<String> {
    crate::core::dragdrop::keep_openable(&paths)
}

/// 取走「本次启动被拖到图标上」的文件路径（PRD §3.8 D-6 / D-9）
///
/// **取走即清空**，所以只能看一次——这也是本命令存在的理由：不走 emit，避免
/// 「Rust 发的时候前端还没在听」的竞态；由前端在自己准备好的时刻主动拉。
///
/// 返回的路径已经过滤过（剥引号、跳过 argv[0]、丢掉目录与不存在的路径），
/// 前端直接逐个打开即可。
#[tauri::command]
pub fn take_startup_files() -> Vec<String> {
    crate::core::dragdrop::take_startup_files()
}
