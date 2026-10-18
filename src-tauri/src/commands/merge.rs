//! 文件合并命令（F-07 §7.3 `merge_files`）
//!
//! 命令层职责：读源文件（编码自动探测，失败**跳过并报告**，不中断整批）→
//! 调 `core::merge::plan_merge` 规划 → 写出（UTF-8，LF 行尾）。
//! 输出已存在且未开「覆盖」时跳过并报告，避免静默覆盖。
//!
//! 自动合并的输出落在源文件所在目录；手工合并的输出路径由前端
//! 另存为对话框选定。写出内容为规划器产物（各文件去尾换行、空行相接）。

use serde::{Deserialize, Serialize};

use crate::core::encoding;
use crate::core::merge::{self, MergeItem, MergePlanOptions, MergeStrategy};
use crate::error::{AppError, AppResult};

/// 合并请求的共用选项（经 serde flatten 平铺进两种模式的请求 JSON）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeShared {
    pub strategy: MergeStrategy,
    /// 源文件名正则（含捕获组；自动合并必填，手工合并可选）
    pub source_pattern: Option<String>,
    /// 输出文件名模板（`\1.txt`；仅自动合并使用）
    pub output_pattern: Option<String>,
    /// 排序关键字（模板或正则，见 `core::merge` 文档）
    pub sort_key: Option<String>,
    /// 手工合并的输出文件（自动合并时为空：输出落在源目录）
    pub output_path: Option<String>,
    /// 输出已存在时是否覆盖（默认跳过并在报告里说明）
    pub overwrite: bool,
}

/// 合并请求（F-07 §7.3 `MergeRequest`）
///
/// 序列化形状（前端 TS 判别联合一一对应）：
/// `{"mode":"manual","files":[…],"strategy":"simple",…}` /
/// `{"mode":"auto","directory":"…","strategy":"sameName",…}`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum MergeRequest {
    /// 手工：源文件清单 + 输出文件
    Manual {
        files: Vec<String>,
        #[serde(flatten)]
        shared: MergeShared,
    },
    /// 自动：目录 + 文件名正则三件套
    Auto {
        directory: String,
        #[serde(flatten)]
        shared: MergeShared,
    },
}

/// 一个成功写出的合并产物
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedFile {
    pub path: String,
    pub name: String,
    pub file_count: usize,
    pub char_count: usize,
    /// 参与文件名（按合并顺序）
    pub order: Vec<String>,
}

/// 一个被跳过的文件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSkip {
    pub path: String,
    pub reason: String,
}

/// 合并报告（F-07 §7.4：读取失败跳过 + 报告）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub outputs: Vec<MergedFile>,
    pub skipped: Vec<MergeSkip>,
    /// 自动合并扫描到的文件数（手工合并 = files.len()）
    pub scanned: usize,
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_owned())
}

/// 读一个源文件（编码自动探测）；失败转「跳过」记录
fn read_source(path: &str, skipped: &mut Vec<MergeSkip>) -> Option<MergeItem> {
    match encoding::read_file(path) {
        Ok(loaded) => Some(MergeItem {
            name: file_name(path),
            text: loaded.text,
        }),
        Err(e) => {
            skipped.push(MergeSkip {
                path: path.to_owned(),
                reason: e.to_string(),
            });
            None
        }
    }
}

/// 列出目录下的文件（不递归；自动合并按源正则过滤在规划器内做点名报告）
fn list_directory_files(directory: &str) -> AppResult<Vec<String>> {
    let dir = std::path::Path::new(directory);
    if !dir.is_dir() {
        return Err(AppError::Merge(format!("目录不存在：{directory}")));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|e| AppError::Merge(format!("读取目录失败：{e}")))?
        .flatten()
    {
        let path = entry.path();
        if path.is_file() {
            out.push(path.to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// 按源正则过滤文件名（自动合并：目录里的无关文件不参与合并）
fn filter_by_source(files: &[String], pattern: &str) -> AppResult<Vec<String>> {
    use regex::Regex;
    if pattern.is_empty() {
        return Err(AppError::Merge(
            "自动合并需要「源文件名正则」（含捕获组，如 (\\d+)_(\\d+)\\.txt）".into(),
        ));
    }
    let re = Regex::new(pattern).map_err(|e| AppError::Merge(format!("源正则错误：{e}")))?;
    Ok(files
        .iter()
        .filter(|path| re.is_match(&file_name(path)))
        .cloned()
        .collect())
}

fn write_output(
    path: &std::path::Path,
    output: &merge::MergedOutput,
    overwrite: bool,
    skipped: &mut Vec<MergeSkip>,
) -> Option<MergedFile> {
    if path.exists() && !overwrite {
        skipped.push(MergeSkip {
            path: path.to_string_lossy().to_string(),
            reason: "输出文件已存在（未勾选覆盖）".into(),
        });
        return None;
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    match std::fs::write(path, &output.text) {
        Ok(()) => Some(MergedFile {
            path: path.to_string_lossy().to_string(),
            name: output.name.clone(),
            file_count: output.order.len(),
            char_count: output.text.chars().count(),
            order: output.order.clone(),
        }),
        Err(e) => {
            skipped.push(MergeSkip {
                path: path.to_string_lossy().to_string(),
                reason: format!("写出失败：{e}"),
            });
            None
        }
    }
}

/// 执行合并（F-07 §7.3）
#[tauri::command]
pub async fn merge_files(req: MergeRequest) -> Result<MergeReport, String> {
    tauri::async_runtime::spawn_blocking(move || run_merge(req))
        .await
        .map_err(|e| format!("合并任务异常：{e}"))?
        .map_err(|e: AppError| e.to_string())
}

fn run_merge(req: MergeRequest) -> AppResult<MergeReport> {
    let mut skipped: Vec<MergeSkip> = Vec::new();

    match req {
        MergeRequest::Manual { files, shared } => {
            let plan_opts = MergePlanOptions {
                strategy: shared.strategy,
                source_pattern: shared.source_pattern.clone(),
                output_pattern: shared.output_pattern.clone(),
                sort_key: shared.sort_key.clone(),
            };
            let output_path = shared.output_path.clone().ok_or_else(|| {
                AppError::Merge("手工合并需要先选择输出文件（另存为对话框）".into())
            })?;
            if files.is_empty() {
                return Err(AppError::Merge("请先添加要合并的源文件".into()));
            }
            let scanned = files.len();
            let mut items = Vec::with_capacity(files.len());
            for path in &files {
                if let Some(item) = read_source(path, &mut skipped) {
                    items.push(item);
                }
            }
            if items.is_empty() {
                return Err(AppError::Merge("没有任何源文件读取成功，合并中止".into()));
            }
            let mut outputs = merge::plan_merge(&items, &plan_opts)?;
            // 手工合并只有一个产物：名字以输出路径为准
            if let Some(first) = outputs.first_mut() {
                first.name = file_name(&output_path);
            }
            let written = write_output(
                std::path::Path::new(&output_path),
                outputs
                    .first()
                    .ok_or_else(|| AppError::Merge("规划结果为空".into()))?,
                shared.overwrite,
                &mut skipped,
            );
            Ok(MergeReport {
                outputs: written.into_iter().collect(),
                skipped,
                scanned,
            })
        }
        MergeRequest::Auto { directory, shared } => {
            let plan_opts = MergePlanOptions {
                strategy: shared.strategy,
                source_pattern: shared.source_pattern.clone(),
                output_pattern: shared.output_pattern.clone(),
                sort_key: shared.sort_key.clone(),
            };
            let files = list_directory_files(&directory)?;
            let scanned = files.len();
            if scanned == 0 {
                return Err(AppError::Merge("目录里没有文件".into()));
            }
            let files = filter_by_source(&files, shared.source_pattern.as_deref().unwrap_or(""))?;
            if files.is_empty() {
                return Err(AppError::Merge("没有文件名匹配源正则的文件".into()));
            }
            let mut items = Vec::with_capacity(files.len());
            for path in &files {
                if let Some(item) = read_source(path, &mut skipped) {
                    items.push(item);
                }
            }
            if items.is_empty() {
                return Err(AppError::Merge("没有任何源文件读取成功，合并中止".into()));
            }
            let outputs = merge::plan_merge(&items, &plan_opts)?;
            // 输出落在源文件目录；输出名由模板渲染（如 \1.txt）
            let base = std::path::Path::new(&directory);
            let mut written = Vec::with_capacity(outputs.len());
            for output in &outputs {
                if let Some(report) = write_output(
                    &base.join(&output.name),
                    output,
                    shared.overwrite,
                    &mut skipped,
                ) {
                    written.push(report);
                }
            }
            Ok(MergeReport {
                outputs: written,
                skipped,
                scanned,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_extracts_base() {
        // 这条用例原本写死 `C:\dir\1_2.txt`：`Path::file_name()` 的分隔符是
        // **平台相关**的，Linux / macOS 不认 `\`，整个串会被当成文件名返回，
        // 于是 CI 上 macOS 的 Rust 单测一直是红的（Windows 恰好通过）。
        // 现在按当前平台的分隔符现场构造，跨平台都成立。
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(file_name(&format!("dir{sep}1_2.txt")), "1_2.txt");
        assert_eq!(file_name("/tmp/x/甲.txt"), "甲.txt");
        assert_eq!(file_name("plain.txt"), "plain.txt");
    }
}
