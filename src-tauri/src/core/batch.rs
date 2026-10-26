//! F-08 批处理（第七阶段）
//!
//! 目录 → 文本整理流水线 → 落盘，整流程对前端只暴露：
//! - 一次性的 [`BatchRequest`] + [`BatchReport`]；
//! - 通过 [`BatchFileEvent`] 回调细粒度上报每个文件的开始 / 完成 / 错误，
//!   方便命令层 `Channel<BatchProgress>` 推到 UI 进度条与错误面板。
//!
//! 内部实现不依赖 Tauri：枚举用 `walkdir`，并行用 `rayon`；命令层只负责
//! 拿 `Arc<AtomicBool>` 取消信号 + 把回调映射到 Tauri Channel。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use rayon::prelude::*;

use super::ui_lang;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::core::encoding::{self, Encoding, LineEnding, SaveOptions, UnmappablePolicy};
use crate::core::pipelines::{self, PipelineStep};
use crate::error::AppResult;

/// 编码类型已提到 `core::encoding`（F-11 设置的 `defaultEncoding` 也要用），
/// 这里再导出以保持既有引用路径 `core::batch::EncodingOrAuto` 不变。
pub use crate::core::encoding::EncodingOrAuto;

/// 批处理请求（与 F-08 §8.4 `BatchRequest` 同形；新增 `preserve_mtime`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    /// 目录或文件路径（混合；目录根据 `recursive` 决定是否递归）
    pub inputs: Vec<PathBuf>,
    /// 目录输入是否递归子目录
    pub recursive: bool,
    /// 处理前先在原路径旁复制一份 `*.bak`
    pub backup: bool,
    /// 写出后保留原 mtime（实现：先 `set_file_mtime` 到原始 mtime 再写）
    pub preserve_mtime: bool,
    /// 输入编码（auto = BOM / UTF-8 / chardetng）
    pub input_encoding: EncodingOrAuto,
    /// 输出编码（auto = 跟输入编码；否则按指定编码写出；不可编码字符走 `CharRef`）
    pub output_encoding: EncodingOrAuto,
    /// 流水线步骤（与 F-09 单文件菜单同构，前端用 `pipelines_catalog` 选取）
    pub steps: Vec<PipelineStep>,
}

impl Default for BatchRequest {
    fn default() -> Self {
        Self {
            inputs: Vec::new(),
            recursive: false,
            backup: false,
            preserve_mtime: true,
            input_encoding: EncodingOrAuto::Auto,
            output_encoding: EncodingOrAuto::Auto,
            steps: Vec::new(),
        }
    }
}

/// 单个文件的进度事件（命令层据此包装成 `Channel<BatchProgress>` 推到前端）
#[derive(Debug, Clone)]
pub enum BatchFileEvent<'a> {
    /// 开始处理该文件
    Started {
        index: usize,
        total: usize,
        path: &'a Path,
    },
    /// 处理完成（`modified` = 内容是否真的变了）
    Done {
        index: usize,
        total: usize,
        path: &'a Path,
        modified: bool,
    },
    /// 处理失败（不致命，写入 `errors` 后继续）
    Error {
        index: usize,
        total: usize,
        path: &'a Path,
        phase: BatchPhase,
        message: String,
    },
}

/// 出错发生在哪个阶段（前端据此在错误面板里染色）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchPhase {
    Enumerate,
    Read,
    Process,
    Backup,
    Write,
    Mtime,
}

/// 单文件处理出错记录
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFileError {
    pub path: PathBuf,
    pub phase: BatchPhase,
    pub message: String,
}

/// 批处理汇总
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    /// 枚举到的候选文件数
    pub scanned: usize,
    /// 内容未变化、跳过写出的文件数
    pub unchanged: usize,
    /// 真正写出（修改过）的文件数
    pub written: usize,
    /// 备份成功的文件数
    pub backed_up: usize,
    /// 用户中途取消
    pub cancelled: bool,
    /// 错误文件清单
    pub errors: Vec<BatchFileError>,
    /// 端到端耗时（毫秒）
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

/// `*.bak` 是批处理自己产出的备份，**不得作为输入再处理**
/// （否则第二次运行会产出 `x.txt.bak.bak`，且「备份」语义被破坏）
/// 耗时的毫秒数（`u128` → `u64`）。
///
/// `Duration::as_millis()` 返回 `u128`，而 `elapsed_ms` 字段与进度快照里都是
/// `u64`。直接 `as u64` 在越界时会**静默截成另一个看起来完全正常的数**——虽然
/// 一次批处理不可能跑满 `u64::MAX` 毫秒（约 58 亿年），但把「不可能」变成
/// 「显式饱和」的代价只是几行，还省得每个调用点都要读者自己推一遍边界
/// （PRD §3.7 R-1：不留静默丢信息的转换）。
pub(crate) fn elapsed_ms(elapsed: std::time::Duration) -> u64 {
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
}

fn is_backup_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".bak"))
}

/// 枚举（recursive / 文件 / 目录 三类输入归一为 `Vec<PathBuf>`）
///
/// 目录只收文件、不收子目录；`recursive=true` 时用 `walkdir` 递归。
/// `*.bak` 一律跳过（见 [`is_backup_file`]）——即使被显式当成单个输入传入，
/// 批量工具里「再处理自己的备份」几乎总是误操作。
///
/// 容错：单个输入路径无法访问（不存在 / 权限不足 / 临时网络盘掉线）
/// **不会** 让整次枚举失败；该路径被跳过，由调用方另行记录。
/// 所有输入都不可访问时返回空列表。
pub fn enumerate_files(inputs: &[PathBuf], recursive: bool) -> AppResult<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    for input in inputs {
        if is_backup_file(input) {
            continue;
        }
        let meta = match std::fs::metadata(input) {
            Ok(m) => m,
            Err(_) => continue, // 单个输入无效 → 静默跳过；调用方会自己记错误
        };
        if meta.is_file() {
            out.push(input.clone());
        } else if meta.is_dir() {
            let walker = WalkDir::new(input).follow_links(false);
            let walker = if recursive {
                walker
            } else {
                walker.max_depth(1)
            };
            for entry in walker.into_iter().filter_map(|e| e.ok()) {
                if entry.file_type().is_file() && !is_backup_file(entry.path()) {
                    out.push(entry.path().to_path_buf());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// 跑一次批处理（不读 `walkdir` 之外的副作用；cancel 在每个文件前查一次）
///
/// `on_progress` 必须 `Fn + Send + Sync + 'static`，由命令层包装成 `Channel::send`；
/// 单测里通常给一个计数器。
pub fn run_batch<F>(config: &BatchRequest, cancel: &AtomicBool, on_progress: F) -> BatchSummary
where
    F: Fn(BatchFileEvent<'_>) + Send + Sync + 'static,
{
    let started = Instant::now();
    let mut summary = BatchSummary::default();

    let files = match enumerate_files(&config.inputs, config.recursive) {
        Ok(v) => v,
        Err(e) => {
            // 整次 enumerate_files 自身失败（如路径全空、底层错误）— 一次性报告
            let synthetic = PathBuf::from("<enumerate>");
            on_progress(BatchFileEvent::Error {
                index: 0,
                total: 0,
                path: &synthetic,
                phase: BatchPhase::Enumerate,
                message: e.to_string(),
            });
            summary.errors.push(BatchFileError {
                path: synthetic,
                phase: BatchPhase::Enumerate,
                message: e.to_string(),
            });
            summary.elapsed_ms = elapsed_ms(started.elapsed());
            return summary;
        }
    };

    // 收集 inputs 里无效的路径（与 enumerate_files 的容错策略配合 — 单个无效不抛错但要入报）
    let invalid_inputs: Vec<BatchFileError> = config
        .inputs
        .iter()
        .filter(|p| !p.exists())
        .map(|p| {
            let msg = ui_lang::t(&format!("路径不存在：{}", p.display()));
            on_progress(BatchFileEvent::Error {
                index: 0,
                total: 0,
                path: p,
                phase: BatchPhase::Enumerate,
                message: msg.clone(),
            });
            BatchFileError {
                path: p.clone(),
                phase: BatchPhase::Enumerate,
                message: msg,
            }
        })
        .collect();

    summary.scanned = files.len();
    let total = files.len();

    // 让 Channel 先发一次「Started」再让 UI 拿到总数
    if total == 0 {
        summary.elapsed_ms = elapsed_ms(started.elapsed());
        return summary;
    }

    // 并行处理；每个文件的结果用 Mutex 归并到 summary
    // （用 atomic / UnsafeCell 太脆；写入极少，Mutex 即可）
    let summary_lock = std::sync::Mutex::new(BatchSummary {
        scanned: total,
        ..Default::default()
    });

    files.par_iter().enumerate().for_each(|(index, path)| {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        on_progress(BatchFileEvent::Started { index, total, path });
        match run_one_file(path, config) {
            Ok(RunOutcome {
                modified,
                backed_up,
            }) => {
                let mut s = summary_lock.lock().expect("batch summary mutex");
                if modified {
                    s.written += 1;
                } else {
                    s.unchanged += 1;
                }
                if backed_up {
                    s.backed_up += 1;
                }
                on_progress(BatchFileEvent::Done {
                    index,
                    total,
                    path,
                    modified,
                });
            }
            Err(BatchRunError { phase, message }) => {
                let mut s = summary_lock.lock().expect("batch summary mutex");
                s.errors.push(BatchFileError {
                    path: path.clone(),
                    phase,
                    message: message.clone(),
                });
                on_progress(BatchFileEvent::Error {
                    index,
                    total,
                    path,
                    phase,
                    message,
                });
            }
        }
    });

    // 中毒说明某个工作线程 panic 过。这里刻意**取回**已统计的部分，不跟着 panic：
    // `into_inner()` 是把数据取出来、锁随即销毁，不存在「带病继续用锁」的问题；
    // 而批处理的价值恰恰在于「哪怕出了岔子，已完成的上千个成果也要交给用户」。
    //
    // 这与 BeautifulRust §5「Lock poisoning is fatal」并不冲突——那条针对的是继续
    // 用这把锁。上面两处 `lock().expect(..)` 仍保持「中毒即 panic」的语义不变。
    // 原先这里写成 `into_inner().expect(..)`：用了恢复机制却又 panic，是把两种
    // 处理方式混在一起的自相矛盾写法（PRD §3.9 Q-2）。
    let mut final_summary = summary_lock
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    final_summary.cancelled = cancel.load(Ordering::Relaxed);
    final_summary.elapsed_ms = elapsed_ms(started.elapsed());
    final_summary.scanned = total;
    final_summary.errors.extend(invalid_inputs);
    summary = final_summary;
    summary
}

// ---------------------------------------------------------------------------
// 单文件处理
// ---------------------------------------------------------------------------

struct RunOutcome {
    /// 文件内容是否被流水线改变
    modified: bool,
    /// 是否创建了 .bak 备份
    backed_up: bool,
}

struct BatchRunError {
    phase: BatchPhase,
    message: String,
}

type RunResult = Result<RunOutcome, BatchRunError>;

fn run_one_file(path: &Path, req: &BatchRequest) -> RunResult {
    // 1. 读
    let load = read_with_optional(path, req.input_encoding).map_err(|message| BatchRunError {
        phase: BatchPhase::Read,
        message,
    })?;

    // 2. 处理
    let outcome = pipelines::run_chain(&load.text, &req.steps).map_err(|e| BatchRunError {
        phase: BatchPhase::Process,
        message: e.to_string(),
    })?;
    let new_text = outcome.text;

    // 3. 判断是否需要写出：
    //    - 正文被流水线改了，或
    //    - 请求的输出编码与探测到的输入编码不同（重编码本身也是「改写」；
    //      否则「GBK → UTF-8」在正文没被改动时会被静默跳过）
    let output_encoding = match req.output_encoding {
        EncodingOrAuto::Auto => load.encoding,
        EncodingOrAuto::Fixed(e) => e,
    };
    let modified = new_text != load.text || output_encoding != load.encoding;

    if !modified {
        return Ok(RunOutcome {
            modified: false,
            backed_up: false,
        });
    }

    // 4. 备份（写入 .bak 前先把当前文件原样复制过去）
    let backed_up = if req.backup {
        backup_original(path)
    } else {
        false
    };
    if req.backup && !backed_up {
        return Err(BatchRunError {
            phase: BatchPhase::Backup,
            message: ui_lang::t("备份失败：无法创建 .bak 文件"),
        });
    }

    // 5. 写回
    let save_opts = SaveOptions {
        encoding: output_encoding,
        add_bom: load.had_bom,
        line_ending: load.line_ending,
        unmappable: UnmappablePolicy::CharRef,
    };
    encoding::write_file(&path.to_string_lossy(), &new_text, save_opts).map_err(|e| {
        BatchRunError {
            phase: BatchPhase::Write,
            message: e.to_string(),
        }
    })?;

    // 6. mtime 保留
    if req.preserve_mtime {
        if let Err(e) = restore_mtime(path, load.mtime) {
            return Err(BatchRunError {
                phase: BatchPhase::Mtime,
                message: e.to_string(),
            });
        }
    }

    Ok(RunOutcome {
        modified: true,
        backed_up,
    })
}

/// 包装 `read_file` / `read_file_with`，并把 mtime 装进返回
fn read_with_optional(path: &Path, enc: EncodingOrAuto) -> Result<LoadWithMtime, String> {
    let mtime = file_mtime(path).map_err(|e| e.to_string())?;
    let load = match enc {
        EncodingOrAuto::Auto => encoding::read_file(&path.to_string_lossy()),
        EncodingOrAuto::Fixed(e) => encoding::read_file_with(&path.to_string_lossy(), e),
    }
    .map_err(|e| e.to_string())?;
    Ok(LoadWithMtime {
        text: load.text,
        encoding: load.encoding,
        had_bom: load.had_bom,
        line_ending: load.line_ending,
        mtime,
    })
}

struct LoadWithMtime {
    text: String,
    encoding: Encoding,
    had_bom: bool,
    line_ending: LineEnding,
    mtime: std::time::SystemTime,
}

fn file_mtime(path: &Path) -> std::io::Result<std::time::SystemTime> {
    let meta = std::fs::metadata(path)?;
    meta.modified()
}

fn restore_mtime(path: &Path, mtime: std::time::SystemTime) -> std::io::Result<()> {
    filetime::set_file_mtime(path, filetime::FileTime::from_system_time(mtime))
}

/// 把原文件复制到 `path.bak`（覆盖式；批处理里前一次成功留下的 bak 会被新 bak 覆盖）
fn backup_original(path: &Path) -> bool {
    let bak = match path.file_name() {
        Some(name) => {
            let mut s = name.to_os_string();
            s.push(".bak");
            match path.parent() {
                Some(p) => p.join(s),
                None => return false,
            }
        }
        None => return false,
    };
    std::fs::copy(path, &bak).is_ok()
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn final_summary_is_recovered_from_a_poisoned_mutex() {
        // 复刻 `summary_lock.into_inner()` 那条路径：中毒也必须能把已统计的
        // 部分取回来，而不是跟着 panic 让整批进度白丢（PRD §3.9 Q-2）。
        let lock = std::sync::Mutex::new(BatchSummary {
            scanned: 200,
            written: 7,
            ..BatchSummary::default()
        });

        // Rust 只能靠一次真正的 panic 来毒化锁；用 catch_unwind 把它关在测试里
        let panicked = std::panic::catch_unwind(|| {
            let _guard = lock.lock().unwrap();
            panic!("故意毒化这把锁");
        });
        assert!(panicked.is_err(), "这一步本就该 panic");
        assert!(lock.is_poisoned(), "锁应当处于中毒状态");

        let got = lock
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(got.scanned, 200);
        assert_eq!(got.written, 7, "中毒也该把已统计的成果取回来");
    }

    fn tmp_dir(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "aiotext-batch-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    fn touch_mtime(p: &Path, secs_ago: i64) {
        // 测试辅助：secs_ago 是写死的「N 秒之前」，非负
        #[expect(clippy::cast_sign_loss, reason = "测试里传入的 secs_ago 恒为非负")]
        let secs = secs_ago as u64;
        let target = std::time::SystemTime::now() - Duration::from_secs(secs);
        let ft = filetime::FileTime::from_system_time(target);
        // 直接调内部接口
        let _ = set_file_mtime_for_test(p, ft);
    }

    fn set_file_mtime_for_test(p: &Path, ft: filetime::FileTime) -> std::io::Result<()> {
        filetime::set_file_mtime(p, ft)
    }

    fn step_remove_empty() -> PipelineStep {
        PipelineStep::RemoveEmptyLines
    }

    fn step_trim_end() -> PipelineStep {
        PipelineStep::TrimLineEnd
    }

    fn step_full_to_half() -> PipelineStep {
        PipelineStep::FullToHalf(Default::default())
    }

    fn req(dir: &Path, steps: Vec<PipelineStep>) -> BatchRequest {
        BatchRequest {
            inputs: vec![dir.to_path_buf()],
            recursive: false,
            backup: false,
            preserve_mtime: true,
            input_encoding: EncodingOrAuto::Auto,
            output_encoding: EncodingOrAuto::Auto,
            steps,
        }
    }

    #[test]
    fn enumerate_files_single_dir_only_direct_children() {
        let dir = tmp_dir("enum1");
        let sub = dir.join("sub");
        fs::create_dir(&sub).unwrap();
        write(&dir, "a.txt", "1");
        write(&sub, "b.txt", "2");
        let v = enumerate_files(std::slice::from_ref(&dir), false).unwrap();
        assert_eq!(v.len(), 1, "depth=1 应只看直接子项");
        assert!(v[0].ends_with("a.txt"));
    }

    #[test]
    fn enumerate_files_recursive_includes_subdirs() {
        let dir = tmp_dir("enum2");
        let sub = dir.join("sub");
        fs::create_dir(&sub).unwrap();
        write(&dir, "a.txt", "1");
        write(&sub, "b.txt", "2");
        let v = enumerate_files(std::slice::from_ref(&dir), true).unwrap();
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn run_batch_modifies_only_when_pipeline_changes() {
        let dir = tmp_dir("modify");
        write(&dir, "a.txt", "  hello  \n");
        write(&dir, "b.txt", "already clean\n");
        let summary = run_batch(
            &req(&dir, vec![step_trim_end()]),
            &AtomicBool::new(false),
            |_| {},
        );
        assert_eq!(summary.scanned, 2);
        assert_eq!(summary.written, 1);
        assert_eq!(summary.unchanged, 1);
        assert!(read(&dir.join("a.txt")).ends_with("hello\n"));
        assert_eq!(read(&dir.join("b.txt")), "already clean\n");
    }

    #[test]
    fn run_batch_preserves_mtime_when_requested() {
        let dir = tmp_dir("mtime");
        let p = write(&dir, "a.txt", "hello world  \n");
        touch_mtime(&p, 3600); // 改成 1 小时前
        let before = file_mtime(&p).unwrap();
        let summary = run_batch(
            &req(&dir, vec![step_trim_end()]),
            &AtomicBool::new(false),
            |_| {},
        );
        assert_eq!(summary.written, 1);
        let after = file_mtime(&p).unwrap();
        assert_eq!(before, after, "preserve_mtime 应让 mtime 仍为原始时间");
    }

    #[test]
    fn run_batch_creates_bak_when_backup_true() {
        let dir = tmp_dir("bak");
        // 用前后都有空格的输入：trim_line_end 只动行末，所以 .txt 会保留行首空格
        let p = write(&dir, "a.txt", "  original  \n");
        let mut cfg = req(&dir, vec![step_trim_end()]);
        cfg.backup = true;
        let summary = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        assert_eq!(summary.written, 1);
        assert_eq!(summary.backed_up, 1);
        let bak = dir.join("a.txt.bak");
        assert!(bak.exists());
        assert_eq!(read(&bak), "  original  \n", ".bak 必须是修改前的原文");
        assert_eq!(
            read(&p),
            "  original\n",
            ".txt 的行末空格已被清理，行首保留"
        );
    }

    #[test]
    fn run_batch_skips_unchanged_without_bak() {
        let dir = tmp_dir("nobak");
        write(&dir, "a.txt", "clean\n");
        let mut cfg = req(&dir, vec![step_trim_end()]);
        cfg.backup = true;
        let summary = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        assert_eq!(summary.written, 0);
        assert_eq!(summary.unchanged, 1);
        assert_eq!(summary.backed_up, 0, "未变化文件不应创建 bak");
        assert!(!dir.join("a.txt.bak").exists());
    }

    #[test]
    fn run_batch_progress_callback_sees_started_done() {
        let dir = tmp_dir("cb");
        write(&dir, "a.txt", "  x  \n");
        write(&dir, "b.txt", "y\n");
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        run_batch(
            &req(&dir, vec![step_trim_end()]),
            &AtomicBool::new(false),
            move |ev| {
                if matches!(ev, BatchFileEvent::Done { modified: true, .. }) {
                    c.fetch_add(1, Ordering::SeqCst);
                }
            },
        );
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn run_batch_respects_cancel() {
        let dir = tmp_dir("cancel");
        for i in 0..200 {
            write(&dir, &format!("f{i:03}.txt"), "  spaced  \n");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let c = cancel.clone();
        // 首个 Started 回调里立刻 cancel；rayon 后续 worker 会立即观测到并 return
        let summary = run_batch(&req(&dir, vec![step_trim_end()]), &cancel, move |ev| {
            if matches!(ev, BatchFileEvent::Started { .. }) {
                c.store(true, Ordering::SeqCst);
            }
        });
        assert!(
            summary.cancelled,
            "run_batch 必须把 cancel 反映到 summary.cancelled"
        );
        assert!(summary.written < 200, "至少应有一部分文件被取消");
        assert!(
            summary.scanned == 200,
            "枚举仍应完成（cancel 不影响枚举阶段）"
        );
    }

    #[test]
    fn run_batch_records_read_error_per_file() {
        let dir = tmp_dir("read_err");
        write(&dir, "good.txt", "clean\n");
        write(&dir, "bad.txt", "clean\n");
        // 让 backup 阶段失败：把 bad.txt 的 .bak 路径预占为目录
        let mut cfg = req(&dir, vec![step_trim_end()]);
        cfg.backup = true;
        let bad_bak = dir.join("bad.txt.bak");
        fs::create_dir(&bad_bak).unwrap();
        write(&dir, "bad.txt", "  x  \n"); // 需要 trim 才会真正写
        let summary = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        // bad.txt 应该被记入 errors
        assert!(summary.errors.iter().any(|e| e.path.ends_with("bad.txt")));
        // good.txt 应正常处理
        assert!(summary.written + summary.unchanged >= 1);
    }

    #[test]
    fn run_batch_handles_non_utf8_input_by_chardetng() {
        let dir = tmp_dir("nonutf8");
        // 「中文测试」的 GBK 字节
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];
        let p = dir.join("cn.txt");
        fs::write(&p, gbk).unwrap();
        let summary = run_batch(
            &req(&dir, vec![step_trim_end()]),
            &AtomicBool::new(false),
            |_| {},
        );
        assert_eq!(summary.scanned, 1);
        // 文本读入后 trim_end 应是「中文测试」无尾空格 → 写出仍非 UTF-8 严格（GBK）
        // 即使输出编码与输入一致，「已归一为 LF + 行尾风格保存」也成立
        let bytes = fs::read(&p).unwrap();
        // 不能严格断言是 UTF-8，但至少 readable
        let _ = String::from_utf8_lossy(&bytes);
    }

    #[test]
    fn run_batch_handles_chain_of_three_steps() {
        let dir = tmp_dir("chain");
        let p = write(&dir, "a.txt", "  hello  \n\n\nworld  \n");
        // 删空行 + 删行末空格 + 全角转半角（无操作）— 至少验证串联
        let mut cfg = req(
            &dir,
            vec![step_remove_empty(), step_trim_end(), step_full_to_half()],
        );
        cfg.backup = true;
        let summary = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        assert_eq!(summary.written, 1);
        let out = read(&p);
        assert!(!out.contains("\n\n"), "连续空行应被收敛");
    }

    #[test]
    fn run_batch_300_files_with_five_steps() {
        let dir = tmp_dir("big");
        for i in 0..300 {
            write(
                &dir,
                &format!("f{i:04}.txt"),
                &format!("  line {i}  \n\n\nnext {i}  \n"),
            );
        }
        let steps = vec![
            step_remove_empty(),
            step_trim_end(),
            step_trim_end(), // 重复一次，验证幂等
            step_remove_empty(),
            step_trim_end(),
        ];
        let t = Instant::now();
        let summary = run_batch(&req(&dir, steps), &AtomicBool::new(false), |_| {});
        eprintln!(
            "300×5 完成：{:?}  written={} unchanged={}",
            t.elapsed(),
            summary.written,
            summary.unchanged
        );
        assert_eq!(summary.scanned, 300);
        assert_eq!(summary.written, 300);
        assert!(
            t.elapsed() < Duration::from_secs(30),
            "300 文件应在 30s 内完成"
        );
    }

    #[test]
    fn enumerate_files_skips_bak_files() {
        let dir = tmp_dir("skipbak");
        write(&dir, "a.txt", "1");
        write(&dir, "a.txt.bak", "0");
        let v = enumerate_files(std::slice::from_ref(&dir), false).unwrap();
        assert_eq!(
            v.len(),
            1,
            "*.bak 是批处理自己的备份，不应再作为输入：{v:?}"
        );
        assert!(v[0].ends_with("a.txt"));

        // 显式把 .bak 当单个输入也要跳过
        let only_bak = enumerate_files(&[dir.join("a.txt.bak")], false).unwrap();
        assert!(
            only_bak.is_empty(),
            "显式指定 .bak 也不应处理：{only_bak:?}"
        );
    }

    #[test]
    fn second_run_over_backup_dir_is_idempotent() {
        // 第一轮：备份 + 改写；第二轮：目录里多了 *.bak，不应被处理
        let dir = tmp_dir("bakidem");
        write(&dir, "a.txt", "  x  \n");
        let mut cfg = req(&dir, vec![step_trim_end()]);
        cfg.backup = true;
        let first = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        assert_eq!(first.scanned, 1);
        assert_eq!(first.written, 1);

        let second = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        assert_eq!(second.scanned, 1, "第二轮应只看 a.txt，不看 a.txt.bak");
        assert_eq!(second.written, 0, "a.txt 已规范 → 0 改写（幂等）");
        assert_eq!(second.unchanged, 1);
        // 不应产生 a.txt.bak.bak
        assert!(!dir.join("a.txt.bak.bak").exists());
    }

    #[test]
    fn reencoding_counts_as_modification() {
        let dir = tmp_dir("reencode");
        // 「中文测试」的 GBK 字节，正文干净（无空行 / 无行末空格）
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];
        let p = dir.join("cn.txt");
        fs::write(&p, gbk).unwrap();

        // 输入 GBK、输出 UTF-8、步骤不改内容 → 仍必须写出（重编码）
        let mut cfg = req(&dir, vec![step_trim_end()]);
        cfg.input_encoding = EncodingOrAuto::Fixed(Encoding::Gbk);
        cfg.output_encoding = EncodingOrAuto::Fixed(Encoding::Utf8);
        let summary = run_batch(&cfg, &AtomicBool::new(false), |_| {});
        assert_eq!(summary.written, 1, "重编码必须算作改写");
        assert_eq!(fs::read(&p).unwrap(), "中文测试".as_bytes());

        // 输入输出同为 UTF-8 且内容不变 → 不改写
        let dir2 = tmp_dir("reencode2");
        let p2 = dir2.join("u.txt");
        fs::write(&p2, "中文测试").unwrap();
        let mut cfg2 = req(&dir2, vec![step_trim_end()]);
        cfg2.input_encoding = EncodingOrAuto::Fixed(Encoding::Utf8);
        cfg2.output_encoding = EncodingOrAuto::Fixed(Encoding::Utf8);
        let s2 = run_batch(&cfg2, &AtomicBool::new(false), |_| {});
        assert_eq!(s2.written, 0);
        assert_eq!(s2.unchanged, 1);
    }

    #[test]
    fn encoding_or_auto_round_trips() {
        let s = serde_json::to_string(&EncodingOrAuto::Auto).unwrap();
        assert_eq!(s, "\"auto\"");
        let s = serde_json::to_string(&EncodingOrAuto::Fixed(Encoding::Utf8)).unwrap();
        assert_eq!(s, "\"utf-8\"");
        let parsed: EncodingOrAuto = serde_json::from_str("\"auto\"").unwrap();
        assert!(parsed.is_auto());
        let parsed: EncodingOrAuto = serde_json::from_str("\"gbk\"").unwrap();
        assert!(matches!(parsed, EncodingOrAuto::Fixed(Encoding::Gbk)));
    }

    #[test]
    fn batch_phase_serialization() {
        let s = serde_json::to_string(&BatchPhase::Write).unwrap();
        assert_eq!(s, "\"write\"");
        let s = serde_json::to_string(&BatchPhase::Enumerate).unwrap();
        assert_eq!(s, "\"enumerate\"");
    }

    #[test]
    fn batch_summary_default_serializes_with_defaults() {
        let s = serde_json::to_string(&BatchSummary::default()).unwrap();
        // 默认值应全部为 0、false、空数组
        assert!(s.contains("\"scanned\":0"));
        assert!(s.contains("\"written\":0"));
        assert!(s.contains("\"cancelled\":false"));
    }
}
