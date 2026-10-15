/**
 * 文件合并对话框（F-07 §7.2）：手工合并 / 自动合并（正则）两个页签。
 *
 * - 手工：多选源文件 → 可选排序关键字（对文件名求值的正则）→ 另存为定输出 → 合并
 * - 自动：选目录 → 源文件名正则 / 输出模板 / 排序关键字（模板口径 `\2`）→ 按第 1
 *   捕获组分文件去重，每组输出一个文件，落在源目录
 *
 * 后端对读取失败的源文件「跳过并在报告里说明」，故合并完成后弹报告。
 */
import { useState } from 'react';
import {
  DEFAULT_MERGE_PATTERNS,
  mergeFiles,
  pickDirectory,
  pickOpenFiles,
  pickSaveFile,
  type MergeReport,
  type MergeRequest,
} from '../platform/tauriApi';

interface MergeDialogProps {
  onDone: (message: string) => void;
  onCancel: () => void;
}

type Page = 'manual' | 'auto';

export function MergeDialog({ onDone, onCancel }: MergeDialogProps) {
  const [page, setPage] = useState<Page>('manual');
  const [files, setFiles] = useState<string[]>([]);
  const [directory, setDirectory] = useState('');
  const [sortKey, setSortKey] = useState('');
  const [sourcePattern, setSourcePattern] = useState(DEFAULT_MERGE_PATTERNS.sourcePattern);
  const [outputPattern, setOutputPattern] = useState(DEFAULT_MERGE_PATTERNS.outputPattern);
  const [autoSortKey, setAutoSortKey] = useState(DEFAULT_MERGE_PATTERNS.sortKey);
  const [outputPath, setOutputPath] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addFiles = async () => {
    const picked = await pickOpenFiles();
    if (picked) {
      // 去重追加，保持挑选顺序
      setFiles((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))]);
    }
  };

  const chooseDirectory = async () => {
    const picked = await pickDirectory();
    if (picked) {
      setDirectory(picked);
    }
  };

  const chooseOutput = async () => {
    const picked = await pickSaveFile('merged.txt');
    if (picked) {
      setOutputPath(picked);
    }
  };

  const formatReport = (report: MergeReport): string => {
    const parts = report.outputs.map(
      (file) => `${file.name}（${file.fileCount} 个文件，${file.charCount} 字）`,
    );
    const lines = [`写出 ${report.outputs.length} 个合并文件：${parts.join('、')}`];
    if (report.skipped.length > 0) {
      lines.push(
        `跳过 ${report.skipped.length} 项：${report.skipped
          .map((skip) => `${skip.path}（${skip.reason}）`)
          .join('；')}`,
      );
    }
    return lines.join('；');
  };

  const run = async () => {
    setError('');
    const request: MergeRequest | null =
      page === 'manual'
        ? files.length === 0 || !outputPath
          ? null
          : {
              mode: 'manual',
              files,
              strategy: 'simple',
              sortKey: sortKey || null,
              outputPath,
              overwrite,
            }
        : !directory
          ? null
          : {
              mode: 'auto',
              directory,
              strategy: 'sameName',
              sourcePattern: sourcePattern || null,
              outputPattern: outputPattern || null,
              sortKey: autoSortKey || null,
              overwrite,
            };
    if (!request) {
      setError(page === 'manual' ? '请先添加源文件并选择输出文件' : '请先选择源目录');
      return;
    }
    setBusy(true);
    try {
      const report = await mergeFiles(request);
      onDone(formatReport(report));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-wide">
        <h2 className="dialog-title">文件合并</h2>
        <div className="merge-tabs">
          <button
            className={page === 'manual' ? 'merge-tab merge-tab-active' : 'merge-tab'}
            onClick={() => setPage('manual')}
          >
            手工合并
          </button>
          <button
            className={page === 'auto' ? 'merge-tab merge-tab-active' : 'merge-tab'}
            onClick={() => setPage('auto')}
          >
            自动合并（正则）
          </button>
        </div>
        <div className="dialog-body merge-dialog">
          {page === 'manual' ? (
            <>
              <div className="dialog-field">
                <span>源文件（按挑选顺序合并）</span>
                <div className="merge-file-list">
                  {files.length === 0 ? (
                    <p className="merge-file-empty">尚未选择文件</p>
                  ) : (
                    files.map((file) => (
                      <div key={file} className="merge-file-row">
                        <span className="merge-file-name">{file}</span>
                        <button
                          className="merge-file-remove"
                          onClick={() => setFiles(files.filter((f) => f !== file))}
                        >
                          移除
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <button className="merge-pick" onClick={addFiles}>
                  添加文件…
                </button>
              </div>
              <label className="dialog-field">
                <span>排序关键字（可选，对文件名求值的正则，如 序-(\d+)-）</span>
                <input
                  type="text"
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value)}
                  placeholder="留空保持挑选顺序"
                />
              </label>
              <div className="dialog-field">
                <span>输出文件</span>
                <div className="merge-output-row">
                  <input
                    type="text"
                    value={outputPath}
                    onChange={(e) => setOutputPath(e.target.value)}
                    placeholder="选择或输入输出文件路径"
                  />
                  <button onClick={chooseOutput}>另存为…</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="dialog-field">
                <span>源目录</span>
                <div className="merge-output-row">
                  <input
                    type="text"
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                    placeholder="选择源文件目录"
                  />
                  <button onClick={chooseDirectory}>浏览…</button>
                </div>
              </div>
              <label className="dialog-field">
                <span>源文件名正则（含捕获组）</span>
                <input
                  type="text"
                  value={sourcePattern}
                  onChange={(e) => setSourcePattern(e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>输出文件名模板（按第 1 捕获组分文件）</span>
                <input
                  type="text"
                  value={outputPattern}
                  onChange={(e) => setOutputPattern(e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>排序关键字（对捕获组求值的模板）</span>
                <input
                  type="text"
                  value={autoSortKey}
                  onChange={(e) => setAutoSortKey(e.target.value)}
                />
              </label>
              <p className="dialog-text">
                例：源正则 {DEFAULT_MERGE_PATTERNS.sourcePattern} + 模板{' '}
                {DEFAULT_MERGE_PATTERNS.outputPattern} + 关键字 {DEFAULT_MERGE_PATTERNS.sortKey}
                ，把 1_2.txt、1_10.txt 合成 1.txt（按第 2 段数字排序）。
              </p>
            </>
          )}
          <label className="tool-field">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            输出文件已存在时直接覆盖（默认跳过并在报告里说明）
          </label>
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onCancel}>
            取消
          </button>
          <button className="dialog-primary" disabled={busy} onClick={run}>
            {busy ? '合并中…' : '合并'}
          </button>
        </div>
      </div>
    </div>
  );
}
