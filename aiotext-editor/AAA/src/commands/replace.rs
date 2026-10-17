//! 自定义替换表命令（F-04 §4.6）
//!
//! 命令层只做参数解析 → 调 core → 构造返回类型；表解析与应用均属重 CPU
//! 工作（大表要建 Aho-Corasick 自动机），统一丢到阻塞线程池。

use std::path::PathBuf;

use crate::core::replace::{
    self, ApplyOpts, ApplyReport, ParsedTable, ReplaceTable, TableMeta, ValidationReport,
};

/// 列出全部替换表（用户表 + 内置示例表，F-04 §4.6 `list_replace_tables`）
#[tauri::command]
pub async fn list_replace_tables() -> Result<Vec<TableMeta>, String> {
    replace::list_tables().map_err(|e| e.to_string())
}

/// 载入一张表（先用户目录、后内置目录）
#[tauri::command]
pub async fn load_replace_table(name: String) -> Result<ReplaceTable, String> {
    replace::load_table(&name).map_err(|e| e.to_string())
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
#[tauri::command]
pub async fn ensure_replace_tables() -> Result<usize, String> {
    replace::ensure_builtin_tables(None).map_err(|e| e.to_string())
}
