//! F-08 批处理命令（第七阶段）
//!
//! 把 `core::batch::run_batch` 包装成 Tauri 命令：
//! - 用 `tauri::ipc::Channel<BatchProgress>` 把进度推到前端；
//! - 全局 `BatchCancel` 状态是一个 `Arc<AtomicBool>`，由 `batch_cancel` 写入。
//!
//! ## 为什么进度必须「合并」
//!
//! 实测（VM 内的 WebView2）：`Channel::send` 单次约 30ms。若每个文件推两条
//! 事件，300 个文件就是 600 次 send ⇒ **20s 以上**，而 `core::batch` 真正
//! 的处理只需 0.12s。也就是说「进度上报」会彻底盖过「批处理本身」。
//!
//! 因此这里用 [`ProgressThrottle`] 把高频回调合并成低频快照：计数用原子量
//! 累加，至多每 [`FLUSH_MS`] 毫秒发一条 `BatchProgress::Progress`，收尾时
//! 再补一条 `Finished`（含完整报告与完整错误清单）。
//!
//! 重活走 `tauri::async_runtime::spawn_blocking`，避免阻塞 tokio 调度。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

use crate::core::batch::{
    self, elapsed_ms, BatchFileEvent, BatchPhase, BatchRequest, BatchSummary,
};
use crate::error::AppError;

/// 首次进度快照的延迟（毫秒）。
///
/// 这个值本身是个优化：短任务（几百个文件）在 core 层只要 ~0.1s 就跑完，
/// 完全没必要报中间进度——`Channel::send` 单次 35~100ms 的 IPC 往返反而会
/// 变成主要开销。延迟到 `FIRST_FLUSH_MS` 之后再开始报，短任务就只发收尾那一条。
const FIRST_FLUSH_MS: u64 = 300;

/// 进度快照最小间隔（毫秒）。
///
/// 500ms ≈ 2Hz，对进度条足够顺滑；再密也只是把时间花在 IPC 上
/// （`send` 的成本见上）。
const FLUSH_MS: u64 = 500;

/// 全局取消标志（前端触发 `batch_cancel` 时置位）
#[derive(Default)]
pub struct BatchCancel(pub Arc<AtomicBool>);

/// 单文件错误的 IPC 形态（`path` 为 `String`，phase 由枚举序列化为小写）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFileError {
    pub path: String,
    pub phase: BatchPhase,
    pub message: String,
}

/// 批处理汇总（前端直接消费）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub scanned: usize,
    pub unchanged: usize,
    pub written: usize,
    pub backed_up: usize,
    pub cancelled: bool,
    pub errors: Vec<BatchFileError>,
    pub elapsed_ms: u64,
}

impl From<BatchSummary> for BatchReport {
    fn from(s: BatchSummary) -> Self {
        Self {
            scanned: s.scanned,
            unchanged: s.unchanged,
            written: s.written,
            backed_up: s.backed_up,
            cancelled: s.cancelled,
            errors: s
                .errors
                .into_iter()
                .map(|e| BatchFileError {
                    path: e.path.to_string_lossy().into_owned(),
                    phase: e.phase,
                    message: e.message,
                })
                .collect(),
            elapsed_ms: s.elapsed_ms,
        }
    }
}

/// 推到前端的进度事件
///
/// 注意只保留「合并后的快照」而非每个文件一条：见模块头注释里
/// `Channel::send` 的成本实测。第一个快照会在首个文件事件时立即发出
/// （`last_flush_ms` 初值为 `u64::MAX`），故 UI 无需单独的「开始」事件。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchProgress {
    /// 合并后的进度快照（至多每 `FLUSH_MS` 一条）
    Progress {
        done: usize,
        total: usize,
        modified: usize,
        errors: usize,
        /// 最近处理的文件（供 UI 显示「正在处理 …」）
        current: Option<String>,
        /// 本次快照内新增的最后一条错误（无则 None）
        last_error: Option<BatchFileError>,
    },
    /// 用户中途取消
    Cancelled { processed: usize, total: usize },
    /// 处理结束（成功 / 取消 / 全失败都走这里；含完整错误清单）
    Finished { report: BatchReport },
}

/// 进度节流器（见模块头注释）
struct ProgressThrottle {
    chan: tauri::ipc::Channel<BatchProgress>,
    started_at: Instant,
    /// 已处理文件数
    done: AtomicUsize,
    /// 总文件数
    total: AtomicUsize,
    /// 内容被改写的文件数
    modified: AtomicUsize,
    /// 出错文件数
    errors: AtomicUsize,
    /// 上次发送时刻（相对 `started_at` 的毫秒）
    last_flush_ms: AtomicU64,
    /// 「正在处理的文件」+「本次快照内的最后一条错误」
    recent: Mutex<Recent>,
}

#[derive(Default)]
struct Recent {
    current: Option<String>,
    last_error: Option<BatchFileError>,
}

impl ProgressThrottle {
    fn new(chan: tauri::ipc::Channel<BatchProgress>) -> Self {
        Self {
            chan,
            started_at: Instant::now(),
            done: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            modified: AtomicUsize::new(0),
            errors: AtomicUsize::new(0),
            // 允许第一次回调立即发一条
            // 0 = 还没发过（首次的快照时机由 FIRST_FLUSH_MS 决定）
            last_flush_ms: AtomicU64::new(0),
            recent: Mutex::new(Recent::default()),
        }
    }

    /// 消费一条 core 事件：累加计数，必要时发一条合并快照
    fn on_event(&self, ev: BatchFileEvent<'_>) {
        match ev {
            BatchFileEvent::Started { total, path, .. } => {
                self.total.store(total, Ordering::Relaxed);
                let mut recent = self.recent.lock().expect("batch recent mutex");
                recent.current = Some(path.to_string_lossy().into_owned());
            }
            BatchFileEvent::Done {
                total, modified, ..
            } => {
                self.total.store(total, Ordering::Relaxed);
                self.done.fetch_add(1, Ordering::Relaxed);
                if modified {
                    self.modified.fetch_add(1, Ordering::Relaxed);
                }
            }
            BatchFileEvent::Error {
                total,
                path,
                phase,
                message,
                ..
            } => {
                self.total.store(total, Ordering::Relaxed);
                self.done.fetch_add(1, Ordering::Relaxed);
                self.errors.fetch_add(1, Ordering::Relaxed);
                let mut recent = self.recent.lock().expect("batch recent mutex");
                recent.last_error = Some(BatchFileError {
                    path: path.to_string_lossy().into_owned(),
                    phase,
                    message,
                });
            }
        }
        self.maybe_flush();
    }

    /// 到达间隔则发一条快照；用 CAS 抢占，保证并发调用下至多一条
    fn maybe_flush(&self) {
        let now = elapsed_ms(self.started_at.elapsed());
        let last = self.last_flush_ms.load(Ordering::Relaxed);
        let due = if last == 0 {
            // 还没发过：短任务直接不发中间进度（收尾的 flush_now 会补上）
            now >= FIRST_FLUSH_MS
        } else {
            now >= last.saturating_add(FLUSH_MS)
        };
        if !due {
            return;
        }
        if self
            .last_flush_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return; // 另一个 worker 抢先发了
        }
        self.send_snapshot();
    }

    /// 强制发一条快照（收尾用）
    fn flush_now(&self) {
        self.last_flush_ms
            .store(elapsed_ms(self.started_at.elapsed()), Ordering::Relaxed);
        self.send_snapshot();
    }

    fn send_snapshot(&self) {
        let recent = {
            let mut guard = self.recent.lock().expect("batch recent mutex");
            // last_error 是「本次快照内新增的」，取走即清
            Recent {
                current: guard.current.clone(),
                last_error: guard.last_error.take(),
            }
        };
        let _ = self.chan.send(BatchProgress::Progress {
            done: self.done.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            modified: self.modified.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            current: recent.current,
            last_error: recent.last_error,
        });
    }
}

/// 跑批处理；进度通过 `progress` 通道**合并后**实时推到前端，
/// 最终返回汇总（即使中途取消也会返回当前进度）。
#[tauri::command]
pub async fn batch_run(
    req: BatchRequest,
    progress: tauri::ipc::Channel<BatchProgress>,
    cancel: tauri::State<'_, BatchCancel>,
) -> Result<BatchReport, String> {
    // 1. 复位取消标志（新一次批处理开始）
    cancel.0.store(false, Ordering::SeqCst);

    // 2. 克隆取消标志给闭包
    let cancel_flag = cancel.inner().0.clone();

    // 3. 把 core 调用扔到 blocking 线程（CPU/IO 密集）
    let req_clone = req.clone();
    let throttle = Arc::new(ProgressThrottle::new(progress.clone()));
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let t = Arc::clone(&throttle);
        let summary = batch::run_batch(&req_clone, &cancel_flag, move |ev| t.on_event(ev));
        // 收尾：补发最后一条快照，让 UI 的计数与终态一致
        throttle.flush_now();
        summary
    })
    .await
    .map_err(|e| AppError::Batch(format!("批处理任务异常：{e}")).to_string())?;

    // 4. 终态事件
    let report: BatchReport = summary.into();
    // 批处理只留一条汇总日志（逐文件日志见 encoding.rs 的 DEBUG 说明）
    tracing::info!(
        scanned = report.scanned,
        written = report.written,
        unchanged = report.unchanged,
        backed_up = report.backed_up,
        errors = report.errors.len(),
        cancelled = report.cancelled,
        elapsed_ms = report.elapsed_ms,
        "批处理结束"
    );
    if report.cancelled {
        let _ = progress.send(BatchProgress::Cancelled {
            processed: report.written + report.unchanged + report.errors.len(),
            total: report.scanned,
        });
    }
    let _ = progress.send(BatchProgress::Finished {
        report: report.clone(),
    });
    Ok(report)
}

/// 触发取消（前端点「取消」时调用）
#[tauri::command]
pub fn batch_cancel(cancel: tauri::State<'_, BatchCancel>) -> Result<(), String> {
    cancel.0.store(true, Ordering::SeqCst);
    Ok(())
}

/// 计划预览：把 inputs 展开为文件清单，UI 提示「将处理 N 个文件」
#[tauri::command]
pub async fn batch_plan(req: BatchRequest) -> Result<BatchPlan, String> {
    let inputs: Vec<PathBuf> = req.inputs.clone();
    let files = tauri::async_runtime::spawn_blocking(move || {
        batch::enumerate_files(&inputs, req.recursive)
    })
    .await
    .map_err(|e| format!("枚举任务异常：{e}"))?
    .map_err(|e: AppError| e.to_string())?;
    Ok(BatchPlan {
        file_count: files.len(),
        sample: files
            .into_iter()
            .take(8)
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    pub file_count: usize,
    /// 前 8 个文件路径（UI 预览给用户看「将处理这些文件」）
    pub sample: Vec<String>,
}
