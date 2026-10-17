/**
 * F-08 批处理对话框（第七阶段）
 *
 * 沿用 TextPro 的双栏模式：
 * - 左：可用的整理工具（来自 `pipelines_catalog`），勾选即加入右栏
 * - 右：已选步骤队列，上下移 / 移除
 *
 * 设置区：输入 / 输出编码（auto 默认）、递归、备份、保留 mtime；
 * 启动后切到运行态：进度条 + 错误面板 + 取消。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ENCODING_OR_AUTO_OPTIONS,
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

interface BatchDialogProps {
  onClose: () => void;
  onNotice: (msg: string) => void;
}

type Stage = 'config' | 'running' | 'done';

export function BatchDialog({ onClose, onNotice }: BatchDialogProps) {
  const [catalog, setCatalog] = useState<ToolMeta[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  /** 待加入的路径（可直接键入 / 粘贴，也可用「浏览…」填充） */
  const [pendingPath, setPendingPath] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [backup, setBackup] = useState(false);
  const [preserveMtime, setPreserveMtime] = useState(true);
  const [inputEnc, setInputEnc] = useState<EncodingOrAuto>('auto');
  const [outputEnc, setOutputEnc] = useState<EncodingOrAuto>('auto');
  const [queue, setQueue] = useState<PipelineStep[]>([]);
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

  /**
   * 输入就绪后自动预览「将处理 N 个文件」（防抖 350ms）。
   * 用户键入路径、切递归、增删输入都会触发；避免误把空目录 / 全无效路径送进批处理。
   *
   * 所有 setState 都在防抖回调里（effect 体内同步 setState 会被
   * `react-hooks/set-state-in-effect` 判为错误）。
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      if (inputs.length === 0) {
        setFileCount(null);
        return;
      }
      void batchPlan({
        inputs,
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
  }, [inputs, recursive, backup, preserveMtime, inputEnc, outputEnc, queue]);

  /** 工具按组聚合显示 */
  const grouped = useMemo(() => {
    const map = new Map<string, ToolMeta[]>();
    for (const t of catalog) {
      const g = t.group || '其他';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(t);
    }
    return [...map.entries()];
  }, [catalog]);

  /** 「浏览…」：把原生选择结果填进输入框（不直接入列，让用户确认） */
  const browseInputDir = async () => {
    const d = await pickDirectory();
    if (d) setPendingPath(d);
  };

  /** 「添加」：把输入框内容作为一条输入路径（去重） */
  const addInputPath = (raw?: string) => {
    const value = (raw ?? pendingPath).trim();
    if (!value) return;
    setInputs((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setPendingPath('');
    setFileCount(null);
  };

  const removeInput = (i: number) => {
    setInputs((prev) => prev.filter((_, idx) => idx !== i));
    setFileCount(null);
  };

  /** 输入路径变化时，之前算出的预览数已失效 */
  const onPendingChange = (v: string) => {
    setPendingPath(v);
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

  const removeStep = (i: number) => {
    setQueue((prev) => prev.filter((_, idx) => idx !== i));
  };

  /** 启动前做一次「计划预览」，避免把空目录 / 全是无效路径的请求送进批处理 */
  const previewPlan = async (): Promise<{ req: BatchRequest; count: number } | null> => {
    if (inputs.length === 0) {
      onNotice('请先添加要处理的目录');
      return null;
    }
    if (queue.length === 0) {
      onNotice('请至少选择一个处理步骤');
      return null;
    }
    const req: BatchRequest = {
      inputs,
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
        onNotice(`所选目录下没有可处理的文件（深度=${recursive ? '∞' : '1'}）`);
        return null;
      }
      return { req, count: plan.fileCount };
    } catch (e) {
      onNotice('预览失败：' + String(e));
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
            onNotice(`已取消：处理到 ${msg.processed}/${msg.total}`);
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
          ? `批处理已取消（已处理 ${report.written + report.unchanged}/${report.scanned}）`
          : `批处理完成：处理 ${report.scanned} 个文件，改写 ${report.written}，备份 ${report.backedUp}，错误 ${report.errors.length}，耗时 ${report.elapsedMs}ms`,
      );
    } catch (e) {
      onNotice('批处理失败：' + String(e));
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
    <div className="dialog-overlay" role="dialog" aria-label="批处理">
      <div className="dialog-body dialog-body-wide batch-dialog">
        <header className="dialog-header">
          <strong>批处理（F-08）</strong>
          {stage === 'config' ? (
            <span className="batch-hint">配置步骤与运行参数 → 预览计划 → 启动</span>
          ) : (
            <span className="batch-hint">
              {progress.done}/{progress.total}（已改 {progress.modified}）
            </span>
          )}
        </header>

        {stage === 'config' && (
          <>
            <section className="batch-section">
              <h4>输入</h4>
              <div className="batch-path-row">
                <input
                  type="text"
                  className="batch-path-input"
                  placeholder="目录或文件路径（可键入 / 粘贴）"
                  value={pendingPath}
                  onChange={(e) => onPendingChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addInputPath();
                  }}
                />
                <button onClick={browseInputDir}>浏览…</button>
                <button onClick={() => addInputPath()} disabled={pendingPath.trim().length === 0}>
                  添加
                </button>
              </div>
              <div className="batch-input-row">
                <label>
                  <input
                    type="checkbox"
                    checked={recursive}
                    onChange={(e) => {
                      setRecursive(e.target.checked);
                      setFileCount(null);
                    }}
                  />{' '}
                  递归子目录
                </label>
              </div>
              {inputs.length > 0 && (
                <ul className="batch-input-list">
                  {inputs.map((p, i) => (
                    <li key={i}>
                      <span className="path">{p}</span>
                      <button onClick={() => removeInput(i)}>移除</button>
                    </li>
                  ))}
                </ul>
              )}
              {fileCount !== null && (
                <p className="batch-plan-hint">
                  预览：将处理 {fileCount} 个文件（深度={recursive ? '∞' : '1'}）
                </p>
              )}
            </section>

            <section className="batch-section">
              <h4>步骤</h4>
              <div className="batch-split">
                <div className="batch-lib">
                  <div className="batch-lib-title">工具库</div>
                  {grouped.map(([group, tools]) => (
                    <div key={group} className="batch-lib-group">
                      <div className="batch-lib-group-title">{group}</div>
                      {tools.map((t) => (
                        <button
                          key={t.id}
                          className="batch-lib-item"
                          onClick={() => addStep(t)}
                          title={t.hint || t.label}
                        >
                          + {t.label}
                          {t.hasOptions ? <span className="ellipsis">…</span> : null}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>

                <div className="batch-queue">
                  <div className="batch-queue-title">
                    流水线（{queue.length} 步）
                  </div>
                  {queue.length === 0 ? (
                    <p className="batch-empty">从左侧添加步骤</p>
                  ) : (
                    <ol className="batch-queue-list">
                      {queue.map((step, i) => {
                        const meta = catalog.find((m) => m.id === (step as { kind: string }).kind);
                        return (
                          <li key={i} className="batch-queue-item">
                            <span className="seq">{i + 1}.</span>
                            <span className="name">{meta?.label ?? (step as { kind: string }).kind}</span>
                            <button onClick={() => moveUp(i)} disabled={i === 0} title="上移">↑</button>
                            <button onClick={() => moveDown(i)} disabled={i === queue.length - 1} title="下移">↓</button>
                            <button onClick={() => removeStep(i)} title="移除">×</button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </div>
            </section>

            <section className="batch-section">
              <h4>运行设置</h4>
              <div className="batch-settings">
                <label>
                  输入编码：
                  <select
                    value={inputEnc}
                    onChange={(e) => setInputEnc(e.target.value as EncodingOrAuto)}
                  >
                    {ENCODING_OR_AUTO_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  输出编码：
                  <select
                    value={outputEnc}
                    onChange={(e) => setOutputEnc(e.target.value as EncodingOrAuto)}
                  >
                    {ENCODING_OR_AUTO_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={backup}
                    onChange={(e) => setBackup(e.target.checked)}
                  />{' '}
                  备份（.bak）
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={preserveMtime}
                    onChange={(e) => setPreserveMtime(e.target.checked)}
                  />{' '}
                  保留 mtime
                </label>
              </div>
            </section>
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
              {progress.done}/{progress.total}（已改 {progress.modified}，错误 {errorCount}）
              {stage === 'running' && currentFile ? (
                <span className="batch-current"> · 正在处理 {currentFile}</span>
              ) : null}
            </div>
            {errorCount > 0 && (
              <details className="batch-errors" open>
                <summary>错误面板（{errorCount}）</summary>
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
                    <li>… 运行中已累计 {errorCount} 条，结束后显示完整清单</li>
                  )}
                </ul>
              </details>
            )}
            {finalReport && (
              <p className="batch-final">
                处理 {finalReport.scanned} 个文件 · 改写 {finalReport.written} · 未变{' '}
                {finalReport.unchanged} · 备份 {finalReport.backedUp} · 错误{' '}
                {finalReport.errors.length} · 耗时 {finalReport.elapsedMs}ms
                {finalReport.cancelled && ' · 已取消'}
              </p>
            )}
          </section>
        )}

        <footer className="dialog-footer">
          {stage === 'config' ? (
            <>
              <button className="dialog-cancel" onClick={onClose}>
                关闭
              </button>
              <button
                className="dialog-primary"
                onClick={handleStart}
                disabled={inputs.length === 0 || queue.length === 0}
              >
                开始处理
              </button>
            </>
          ) : stage === 'running' ? (
            <button className="dialog-cancel" onClick={handleCancel}>
              取消
            </button>
          ) : (
            <button className="dialog-primary" onClick={onClose}>
              完成
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
