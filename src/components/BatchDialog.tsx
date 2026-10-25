/**
 * F-08 批处理对话框（第七阶段；v0.5 按 TextPro 的布局重排）
 *
 * 布局照 `TextPro → 批处理操作`：
 *
 * ```text
 *  需处理文件                      [x] 建立后备文件
 *  ┌ 文件名 │ 路径 ─────────┐   [文件(F)…]
 *  │ …                     │   [全选(A)]
 *  │ …                     │   [全不选(A)]
 *  └───────────────────────┘   [选择(S)] [不选(X)] [清空(C)]
 *  可选择的处理        需进行的处理
 *  ┌──────────┐  >>  ┌──────────┐
 *  │ …        │  <<  │ ↑ ↓ ×    │
 *  └──────────┘      └──────────┘
 *  输入编码 [自动▾]   输出编码 [自动▾]
 *                         [取消] [处理]
 * ```
 *
 * 功能映射（我们的数据模型和 TextPro 不完全一样，逐个对上）：
 * - 「需处理文件」= 输入路径（目录或单文件）；勾选状态决定这次真正处理哪些
 *   （后端只认 `inputs` 列表，所以「不选」的项在启动前被过滤掉，不是假动作）。
 * - 「可选择的处理」= `pipelines_catalog`（只列会改写正文的工具，`inspectsOnly` 的无操作）。
 * - 「需进行的处理」= 步骤队列，`>>` 追加、`<<` 移除当前项，↑↓ 调顺序。
 * - 「建立后备文件」= 后端 `backup`（写 `.bak`）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ENCODING_OR_AUTO_OPTIONS,
  baseName,
  batchCancel,
  batchPlan,
  batchRun,
  pickDirectory,
  pipelinesCatalog,
  type BatchFileError,
  type BatchProgress,
  type BatchReport,
  type BatchRequest,
  type EncodingOrAuto,
  type PipelineStep,
  type ToolMeta,
} from '../platform/tauriApi';
import { useI18n } from '../shared/i18n';
import { BATCH } from '../shared/i18n/batch';
import { fill } from '../shared/i18n/status';

interface BatchDialogProps {
  onClose: () => void;
  onNotice: (msg: string) => void;
}

type Stage = 'config' | 'running' | 'done';

export function BatchDialog({ onClose, onNotice }: BatchDialogProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<ToolMeta[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  /** 勾选要参与本次处理的路径（默认全选；「不选」的项在启动前被过滤） */
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  /** 「选择 / 不选」作用的当前高亮行 */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  /** 待加入的路径（可直接键入 / 粘贴，也可用「文件(F)…」填充） */
  const [pendingPath, setPendingPath] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [backup, setBackup] = useState(false);
  const [preserveMtime, setPreserveMtime] = useState(true);
  const [inputEnc, setInputEnc] = useState<EncodingOrAuto>('auto');
  const [outputEnc, setOutputEnc] = useState<EncodingOrAuto>('auto');
  const [queue, setQueue] = useState<PipelineStep[]>([]);
  const [libFocus, setLibFocus] = useState<string | null>(null);
  const [queueFocus, setQueueFocus] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>('config');
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, modified: 0 });
  const [errors, setErrors] = useState<BatchFileError[]>([]);
  /**
   * 错误**总数**。不能拿 `errors.length` 顶替：后端为省 IPC 把进度合并上报
   * （见 `commands/batch.rs` 的 `ProgressThrottle`），每个快照只带「本次新增的
   * 最后一条错误」，所以 `errors` 列表在运行中只能反映最近若干条、会少算。
   * 准确计数走快照的 `errors` 字段，列表只用于展示。
   */
  const [errorCount, setErrorCount] = useState(0);
  const [finalReport, setFinalReport] = useState<BatchReport | null>(null);
  /** 正在处理的文件名（由进度快照带出） */
  const [currentFile, setCurrentFile] = useState('');

  useEffect(() => {
    // 只看会改写正文的工具：`inspectsOnly`（匹配括号）在批处理里是无操作
    void pipelinesCatalog().then((all) => setCatalog(all.filter((t) => !t.inspectsOnly)));
  }, []);

  /** 真正会被处理的路径（勾选过的） */
  const activeInputs = useMemo(
    () => inputs.filter((path) => selectedPaths.includes(path)),
    [inputs, selectedPaths],
  );
  /** 勾选集变化用字符串做依赖，避免数组 identity 每次都触发预览请求 */
  const activeKey = activeInputs.join('\n');

  /**
   * 输入就绪后自动预览「将处理 N 个文件」（防抖 350ms）。
   * 用户键入路径、切递归、勾选变化都会触发；避免误把空目录 / 全无效路径送进批处理。
   *
   * 所有 setState 都在防抖回调里（effect 体内同步 setState 会被
   * `react-hooks/set-state-in-effect` 判为错误）。
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const list = activeKey === '' ? [] : activeKey.split('\n');
      if (list.length === 0) {
        setFileCount(null);
        return;
      }
      void batchPlan({
        inputs: list,
        recursive,
        backup,
        preserveMtime,
        inputEncoding: inputEnc,
        outputEncoding: outputEnc,
        steps: queue,
      })
        .then((plan) => setFileCount(plan.fileCount))
        .catch(() => setFileCount(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [activeKey, recursive, backup, preserveMtime, inputEnc, outputEnc, queue]);

  /** 工具按组聚合显示（「可选择的处理」按后端目录分组） */
  const grouped = useMemo(() => {
    const map = new Map<string, ToolMeta[]>();
    for (const t of catalog) {
      const g = t.group || BATCH.otherGroup;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(t);
    }
    return [...map.entries()];
  }, [catalog]);

  const addInputPath = (raw?: string) => {
    const value = (raw ?? pendingPath).trim();
    if (!value) return;
    setInputs((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setSelectedPaths((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setPendingPath('');
    setFileCount(null);
  };

  /** 「文件(F)…」：选一个目录加进列表（单文件可直接输入路径回车） */
  const browseInputDir = async () => {
    const dir = await pickDirectory();
    if (dir) addInputPath(dir);
  };

  const removeInput = (index: number) => {
    const path = inputs[index];
    setInputs((prev) => prev.filter((_, idx) => idx !== index));
    setSelectedPaths((prev) => prev.filter((p) => p !== path));
    setFocusIndex(null);
    setFileCount(null);
  };

  const toggleInput = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
    setFileCount(null);
  };

  const selectAll = () => {
    setSelectedPaths(inputs);
    setFileCount(null);
  };

  const selectNone = () => {
    setSelectedPaths([]);
    setFileCount(null);
  };

  /** 「选择 / 不选」：只作用于当前高亮行（与 TextPro 的行操作一致） */
  const setFocusSelected = (value: boolean) => {
    const path = focusIndex === null ? null : inputs[focusIndex];
    if (!path) return;
    setSelectedPaths((prev) =>
      value
        ? prev.includes(path)
          ? prev
          : [...prev, path]
        : prev.filter((p) => p !== path),
    );
    setFileCount(null);
  };

  const clearAll = () => {
    setInputs([]);
    setSelectedPaths([]);
    setFocusIndex(null);
    setFileCount(null);
  };

  const addStep = (tool: ToolMeta) => {
    // 默认步骤仅带 kind（其余选项由 Rust 端 #[serde(default)] 补齐）
    setQueue((prev) => [...prev, { kind: tool.id } as unknown as PipelineStep]);
  };

  const moveUp = (i: number) => {
    setQueue((prev) => {
      if (i <= 0) return prev;
      const next = prev.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  };

  const moveDown = (i: number) => {
    setQueue((prev) => {
      if (i >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[i + 1], next[i]] = [next[i], next[i + 1]];
      return next;
    });
  };

  /** 移除步骤：`index` 缺省时移除当前高亮项（`<<` 用） */
  const removeStep = (index?: number) => {
    const target = index ?? queueFocus;
    if (target === null) return;
    setQueue((prev) => prev.filter((_, idx) => idx !== target));
    setQueueFocus(null);
  };

  /** 启动前做一次「计划预览」，避免把空目录 / 全是无效路径的请求送进批处理 */
  const previewPlan = async (): Promise<{ req: BatchRequest; count: number } | null> => {
    if (activeInputs.length === 0) {
      onNotice(t(BATCH.needFiles));
      return null;
    }
    if (queue.length === 0) {
      onNotice(t(BATCH.needSteps));
      return null;
    }
    const req: BatchRequest = {
      inputs: activeInputs,
      recursive,
      backup,
      preserveMtime,
      inputEncoding: inputEnc,
      outputEncoding: outputEnc,
      steps: queue,
    };
    try {
      const plan = await batchPlan(req);
      setFileCount(plan.fileCount);
      if (plan.fileCount === 0) {
        onNotice(fill(t(BATCH.noFilesInDir), { depth: recursive ? '∞' : '1' }));
        return null;
      }
      return { req, count: plan.fileCount };
    } catch (e) {
      onNotice(fill(t(BATCH.previewFailed), { error: String(e) }));
      return null;
    }
  };

  const handleStart = async () => {
    const result = await previewPlan();
    if (!result) return;
    const { req } = result;
    setStage('running');
    setProgress({ done: 0, total: result.count, modified: 0 });
    setCurrentFile('');
    setErrors([]);
    setErrorCount(0);
    setFinalReport(null);
    /** 把终态报告写进各项 state（`finished` 事件与命令返回值共用） */
    const applyReport = (r: BatchReport) => {
      setFinalReport(r);
      setErrors(r.errors.slice());
      setErrorCount(r.errors.length);
      setCurrentFile('');
      setProgress({
        done: r.written + r.unchanged + r.errors.length,
        total: r.scanned,
        modified: r.written,
      });
      setStage('done');
    };
    // 实时错误列表（只保留最近若干条，完整清单以 Finished 的 report.errors 为准）
    const liveErrors: BatchFileError[] = [];
    // 用局部标志判断「是否已由事件收尾」。不能拿 `finalReport` state 去判断：
    // 那是本函数闭包里的快照值，事件里的 setState 不会回写它，判断会恒为真。
    let sawFinished = false;
    try {
      const report = await batchRun(req, (msg: BatchProgress) => {
        switch (msg.kind) {
          case 'progress':
            setProgress({ done: msg.done, total: msg.total, modified: msg.modified });
            setCurrentFile(msg.current ?? '');
            setErrorCount(msg.errors);
            if (msg.lastError) {
              liveErrors.push(msg.lastError);
              setErrors(liveErrors.slice());
            }
            break;
          case 'cancelled':
            onNotice(fill(t(BATCH.cancelledAt), { done: msg.processed, total: msg.total }));
            break;
          case 'finished':
            sawFinished = true;
            applyReport(msg.report);
            break;
        }
      });
      // 兜底：finished 事件没走到（如 Channel 发送失败）时，以命令返回值收尾
      if (!sawFinished) applyReport(report);
      onNotice(
        report.cancelled
          ? fill(t(BATCH.doneCancelled), {
              done: report.written + report.unchanged,
              total: report.scanned,
            })
          : fill(t(BATCH.done), {
              scanned: report.scanned,
              written: report.written,
              backedUp: report.backedUp,
              errors: report.errors.length,
              elapsed: report.elapsedMs,
            }),
      );
    } catch (e) {
      onNotice(fill(t(BATCH.failed), { error: String(e) }));
      setStage('config');
    }
  };

  const handleCancel = async () => {
    try {
      await batchCancel();
    } catch {
      // 取消是幂等的，无视错误
    }
  };

  return (
    <div className="dialog-overlay" role="dialog" aria-label={t(BATCH.a11y)}>
      <div className="dialog-body batch-dialog batch-dialog-textpro">
        <header className="dialog-header">
          <strong>{t(BATCH.title)}</strong>
          {stage === 'config' ? (
            <span className="batch-hint">{t(BATCH.hintConfig)}</span>
          ) : (
            <span className="batch-hint">
              {fill(t(BATCH.progress), {
                done: progress.done,
                total: progress.total,
                modified: progress.modified,
              })}
            </span>
          )}
        </header>

        {stage === 'config' && (
          <>
            {/* ---------- 需处理文件 ---------- */}
            <div className="batch-files-head">
              <span>{t(BATCH.filesHead)}</span>
              <label className="batch-inline-check">
                <input
                  type="checkbox"
                  checked={backup}
                  onChange={(e) => setBackup(e.target.checked)}
                />
                {t(BATCH.backup)}
              </label>
            </div>

            <div className="batch-files">
              <div className="batch-file-table">
                <div className="batch-file-head">
                  <span />
                  <span>{t(BATCH.fileName)}</span>
                  <span>{t(BATCH.filePath)}</span>
                </div>
                <div className="batch-file-body">
                  {inputs.length === 0 ? (
                    <p className="batch-empty">{t(BATCH.emptyFiles)}</p>
                  ) : (
                    inputs.map((path, index) => (
                      <div
                        key={path}
                        className={
                          focusIndex === index ? 'batch-file-row batch-file-row-focus' : 'batch-file-row'
                        }
                        onClick={() => setFocusIndex(index)}
                        onDoubleClick={() => removeInput(index)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedPaths.includes(path)}
                          onChange={() => toggleInput(path)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="batch-file-name" title={path}>
                          {baseName(path)}
                        </span>
                        <span className="batch-file-path" title={path}>
                          {path}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="batch-file-actions">
                <button type="button" onClick={() => void browseInputDir()}>
                  {t(BATCH.browseFile)}
                </button>
                <button type="button" onClick={selectAll} disabled={inputs.length === 0}>
                  {t(BATCH.selectAll)}
                </button>
                <button type="button" onClick={selectNone} disabled={inputs.length === 0}>
                  {t(BATCH.selectNone)}
                </button>
                <button
                  type="button"
                  onClick={() => setFocusSelected(true)}
                  disabled={focusIndex === null}
                >
                  {t(BATCH.selectOne)}
                </button>
                <button
                  type="button"
                  onClick={() => setFocusSelected(false)}
                  disabled={focusIndex === null}
                >
                  {t(BATCH.deselectOne)}
                </button>
                <button type="button" onClick={clearAll} disabled={inputs.length === 0}>
                  {t(BATCH.clear)}
                </button>
              </div>
            </div>

            <div className="batch-path-row">
              <input
                type="text"
                className="batch-path-input"
                placeholder={t(BATCH.pathPlaceholder)}
                value={pendingPath}
                onChange={(e) => {
                  setPendingPath(e.target.value);
                  setFileCount(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addInputPath();
                }}
              />
              <button type="button" onClick={() => addInputPath()} disabled={!pendingPath.trim()}>
                {t(BATCH.add)}
              </button>
              <label className="batch-inline-check">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => {
                    setRecursive(e.target.checked);
                    setFileCount(null);
                  }}
                />
                {t(BATCH.recursive)}
              </label>
              {fileCount !== null && (
                <span className="batch-plan-hint">
                  {fill(t(BATCH.planHint), { count: fileCount })}
                </span>
              )}
            </div>

            {/* ---------- 可选择的处理 / 需进行的处理 ---------- */}
            <div className="batch-tools">
              <div className="batch-tool-col">
                <div className="batch-col-title">{t(BATCH.availableTools)}</div>
                <div className="batch-list">
                  {grouped.map(([group, tools]) => (
                    <div key={group}>
                      <div className="batch-list-group">{t(group)}</div>
                      {tools.map((tool) => (
                        <button
                          key={tool.id}
                          type="button"
                          className={
                            libFocus === tool.id
                              ? 'batch-list-item batch-list-item-focus'
                              : 'batch-list-item'
                          }
                          title={t(tool.hint || tool.label)}
                          onClick={() => setLibFocus(tool.id)}
                          onDoubleClick={() => addStep(tool)}
                        >
                          {t(tool.label)}
                          {tool.hasOptions ? <span className="ellipsis">…</span> : null}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              <div className="batch-move">
                <button
                  type="button"
                  disabled={libFocus === null}
                  title={t(BATCH.addStepTitle)}
                  onClick={() => {
                    const tool = catalog.find((t) => t.id === libFocus);
                    if (tool) addStep(tool);
                  }}
                >
                  &gt;&gt;
                </button>
                <button
                  type="button"
                  disabled={queueFocus === null}
                  title={t(BATCH.removeStepTitle)}
                  onClick={() => removeStep()}
                >
                  &lt;&lt;
                </button>
              </div>

              <div className="batch-tool-col">
                <div className="batch-col-title">{t(BATCH.queue)}</div>
                <div className="batch-list batch-list-queue">
                  {queue.length === 0 ? (
                    <p className="batch-empty">{t(BATCH.queueEmpty)}</p>
                  ) : (
                    queue.map((step, index) => {
                      const meta = catalog.find((m) => m.id === (step as { kind: string }).kind);
                      return (
                        <div
                          key={index}
                          className={
                            queueFocus === index
                              ? 'batch-queue-row batch-queue-row-focus'
                              : 'batch-queue-row'
                          }
                          onClick={() => setQueueFocus(index)}
                        >
                          <span className="seq">{index + 1}.</span>
                          <span className="batch-queue-name">
                            {meta?.label ? t(meta.label) : (step as { kind: string }).kind}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              moveUp(index);
                            }}
                            disabled={index === 0}
                            title={t(BATCH.moveUp)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              moveDown(index);
                            }}
                            disabled={index === queue.length - 1}
                            title={t(BATCH.moveDown)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeStep(index);
                            }}
                            title={t(BATCH.remove)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* ---------- 编码 ---------- */}
            <div className="batch-io">
              <label>
                {t(BATCH.inputEncoding)}
                <select
                  value={inputEnc}
                  onChange={(e) => setInputEnc(e.target.value as EncodingOrAuto)}
                >
                  {ENCODING_OR_AUTO_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t(BATCH.outputEncoding)}
                <select
                  value={outputEnc}
                  onChange={(e) => setOutputEnc(e.target.value as EncodingOrAuto)}
                >
                  {ENCODING_OR_AUTO_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="batch-inline-check">
                <input
                  type="checkbox"
                  checked={preserveMtime}
                  onChange={(e) => setPreserveMtime(e.target.checked)}
                />
                {t(BATCH.preserveMtime)}
              </label>
            </div>
          </>
        )}

        {stage !== 'config' && (
          <section className="batch-section">
            <div className="batch-progress">
              <div
                className="batch-progress-bar"
                style={{
                  width:
                    progress.total > 0
                      ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`
                      : '0%',
                }}
              />
            </div>
            <div className="batch-progress-stats">
              {fill(t(BATCH.progressStats), {
                done: progress.done,
                total: progress.total,
                modified: progress.modified,
                errors: errorCount,
              })}
              {stage === 'running' && currentFile ? (
                <span className="batch-current">
                  {fill(t(BATCH.currentFile), { name: currentFile })}
                </span>
              ) : null}
            </div>
            {errorCount > 0 && (
              <details className="batch-errors" open>
                <summary>{fill(t(BATCH.errorPanel), { count: errorCount })}</summary>
                <ul>
                  {errors.slice(-20).map((e, i) => (
                    <li key={i}>
                      <span className={`phase-tag phase-${e.phase}`}>{e.phase}</span>
                      <span className="path">{e.path}</span>
                      <span className="msg">{e.message}</span>
                    </li>
                  ))}
                  {/* 运行中列表是合并上报的最近若干条，条数少于总数时说明一下 */}
                  {errorCount > errors.length && (
                    <li>{fill(t(BATCH.errorTruncated), { count: errorCount })}</li>
                  )}
                </ul>
              </details>
            )}
            {finalReport && (
              <p className="batch-final">
                {fill(t(BATCH.finalReport), {
                  scanned: finalReport.scanned,
                  written: finalReport.written,
                  unchanged: finalReport.unchanged,
                  backedUp: finalReport.backedUp,
                  errors: finalReport.errors.length,
                  elapsed: finalReport.elapsedMs,
                })}
                {finalReport.cancelled && t(BATCH.cancelled)}
              </p>
            )}
          </section>
        )}

        <footer className="dialog-footer">
          {stage === 'config' ? (
            <>
              <button className="dialog-cancel" onClick={onClose}>
                {t(BATCH.exit)}
              </button>
              <button
                className="dialog-primary"
                onClick={handleStart}
                disabled={activeInputs.length === 0 || queue.length === 0}
              >
                {t(BATCH.start)}
              </button>
            </>
          ) : stage === 'running' ? (
            <button className="dialog-cancel" onClick={handleCancel}>
              {t(BATCH.cancel)}
            </button>
          ) : (
            <button className="dialog-primary" onClick={onClose}>
              {t(BATCH.finish)}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
