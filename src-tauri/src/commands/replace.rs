//! 自定义替换表命令（F-04 §4.6）
//!
//! 命令层只做参数解析 → 调 core → 构造返回类型；表解析与应用均属重 CPU
//! 工作（大表要建 Aho-Corasick 自动机），统一丢到阻塞线程池。

use std::path::PathBuf;

use crate::core::replace::{
    self, ApplyOpts, ApplyReport, ParsedTable, ReplaceTable, TableMeta, ValidationReport,
};

/// 列出全部替换表（用户表 + 内置示例表，F-04 §4.6 `list_replace_tables`）
///
/// 内置示例表已改为**按需**落盘：启动时不再后台复制一遍（那等于每次冷启动都白写
/// 一次磁盘，便携版尤其明显 —— 要从二进制里展开到临时目录）。这里在列出之前兜一次，
/// 幂等：只复制缺失的文件，不会把用户改名/删掉的内置表覆盖回来。
///
/// 注意：`ensure_builtin_tables` 是**同步**磁盘 I/O，必须丢进阻塞线程池。Tauri 的
/// async 命令默认跑在**主线程**上，直接调用会把窗口与前端渲染一起卡住。
#[tauri::command]
pub async fn list_replace_tables() -> Result<Vec<TableMeta>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if let Err(e) = replace::ensure_builtin_tables(None) {
            tracing::warn!(error = %e, "内置替换表初始化失败（不影响用户表）");
        }
        replace::list_tables()
    })
    .await
    .map_err(|e| format!("列出替换表任务异常：{e}"))?
    .map_err(|e| e.to_string())
}

/// 载入一张表（先用户目录、后内置目录）
#[tauri::command]
pub async fn load_replace_table(name: String) -> Result<ReplaceTable, String> {
    // 同上：这条路径可能在「从没打开过替换表对话框」时被直接调用，所以也要兜一次。
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = replace::ensure_builtin_tables(None) {
            tracing::warn!(error = %e, "内置替换表初始化失败");
        }
        replace::load_table(&name)
    })
    .await
    .map_err(|e| format!("载入表任务异常：{e}"))?
    .map_err(|e| e.to_string())
}

/// 保存表（结构化；新建重名时自动改名 `name (2)`）
#[tauri::command]
pub async fn save_replace_table(table: ReplaceTable) -> Result<TableMeta, String> {
    replace::save_table(&table).map_err(|e| e.to_string())
}

/// 读取表源文本（UI 镜像编辑器用，保留注释）
#[tauri::command]
pub async fn read_replace_table_source(name: String) -> Result<String, String> {
    replace::read_source(&name).map_err(|e| e.to_string())
}

/// 解析表文本并返回行号级校验报告（镜像编辑器实时校验）
#[tauri::command]
pub async fn parse_replace_table_text(text: String, name: String) -> Result<ParsedTable, String> {
    tauri::async_runtime::spawn_blocking(move || replace::parse_table_text(&text, &name))
        .await
        .map_err(|e| format!("解析任务异常：{e}"))
}

/// 保存表源文本（校验不通过时阻止保存，F-04 §4.8）
#[tauri::command]
pub async fn save_replace_table_source(
    name: String,
    text: String,
    source_path: Option<String>,
) -> Result<TableMeta, String> {
    let path = source_path.map(PathBuf::from);
    replace::save_source(&name, &text, path.as_deref()).map_err(|e| e.to_string())
}

/// 删除用户表（内置表不可删）
#[tauri::command]
pub async fn delete_replace_table(name: String) -> Result<(), String> {
    replace::delete_table(&name).map_err(|e| e.to_string())
}

/// 校验表（解析、重复候选、正则、表名合法性）
#[tauri::command]
pub async fn validate_replace_table(table: ReplaceTable) -> Result<ValidationReport, String> {
    Ok(replace::validate(&table))
}

/// 应用替换表（模式 A 独立引擎 / 模式 B OpenCC 内联字典）
#[tauri::command]
pub async fn apply_replace(
    text: String,
    table: ReplaceTable,
    opts: ApplyOpts,
) -> Result<ApplyReport, String> {
    tauri::async_runtime::spawn_blocking(move || replace::apply(&text, &table, &opts))
        .await
        .map_err(|e| format!("替换任务异常：{e}"))?
        .map_err(|e| e.to_string())
}

/// 导入 TextPro `.tab` 文件（自动识别 `=` 与空格分隔，F-04 §4.9）
#[tauri::command]
pub async fn import_textpro_tab(
    path: String,
    name: Option<String>,
) -> Result<ReplaceTable, String> {
    let path = PathBuf::from(path);
    replace::import_textpro_tab(&path, name).map_err(|e| e.to_string())
}

/// 首次启动复制内置示例表（幂等；返回本次复制数量）
///
/// 同步磁盘 I/O，同样丢进阻塞线程池（理由见 `list_replace_tables`）。
#[tauri::command]
pub async fn ensure_replace_tables() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| replace::ensure_builtin_tables(None))
        .await
        .map_err(|e| format!("内置替换表任务异常：{e}"))?
        .map_err(|e| e.to_string())
}
