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
import { useI18n } from '../shared/i18n';
import { MERGE } from '../shared/i18n/merge';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

interface MergeDialogProps {
  onDone: (message: string) => void;
  onCancel: () => void;
}

type Page = 'manual' | 'auto';

export function MergeDialog({ onDone, onCancel }: MergeDialogProps) {
  const { t } = useI18n();
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

  /** 报告里的文件名与路径是用户数据，只填充不翻译；`reason` 由后端按语言给出 */
  const formatReport = (report: MergeReport): string => {
    const parts = report.outputs.map((file) =>
      fill(t(MERGE.reportFile), {
        name: file.name,
        files: file.fileCount,
        chars: file.charCount,
      }),
    );
    const lines = [
      fill(t(MERGE.reportOutputs), { count: report.outputs.length, list: parts.join('、') }),
    ];
    if (report.skipped.length > 0) {
      lines.push(
        fill(t(MERGE.reportSkipped), {
          count: report.skipped.length,
          list: report.skipped
            .map((skip) => fill(t(MERGE.reportSkipItem), { path: skip.path, reason: skip.reason }))
            .join('；'),
        }),
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
      setError(page === 'manual' ? t(MERGE.errorManual) : t(MERGE.errorAuto));
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
        <h2 className="dialog-title">{t(MERGE.title)}</h2>
        <div className="merge-tabs">
          <button
            className={page === 'manual' ? 'merge-tab merge-tab-active' : 'merge-tab'}
            onClick={() => setPage('manual')}
          >
            {t(MERGE.tabManual)}
          </button>
          <button
            className={page === 'auto' ? 'merge-tab merge-tab-active' : 'merge-tab'}
            onClick={() => setPage('auto')}
          >
            {t(MERGE.tabAuto)}
          </button>
        </div>
        <div className="dialog-body merge-dialog">
          {page === 'manual' ? (
            <>
              <div className="dialog-field">
                <span>{t(MERGE.sourceFiles)}</span>
                <div className="merge-file-list">
                  {files.length === 0 ? (
                    <p className="merge-file-empty">{t(MERGE.noFile)}</p>
                  ) : (
                    // 路径是用户数据，原样显示
                    files.map((file) => (
                      <div key={file} className="merge-file-row">
                        <span className="merge-file-name">{file}</span>
                        <button
                          className="merge-file-remove"
                          onClick={() => setFiles(files.filter((f) => f !== file))}
                        >
                          {t(MERGE.remove)}
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <button className="merge-pick" onClick={addFiles}>
                  {t(MERGE.addFiles)}
                </button>
              </div>
              <label className="dialog-field">
                <span>{t(MERGE.sortKey)}</span>
                <input
                  type="text"
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value)}
                  placeholder={t(MERGE.sortKeyPlaceholder)}
                />
              </label>
              <div className="dialog-field">
                <span>{t(MERGE.outputFile)}</span>
                <div className="merge-output-row">
                  <input
                    type="text"
                    value={outputPath}
                    onChange={(e) => setOutputPath(e.target.value)}
                    placeholder={t(MERGE.outputPlaceholder)}
                  />
                  <button onClick={chooseOutput}>{t(MERGE.saveAs)}</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="dialog-field">
                <span>{t(MERGE.sourceDir)}</span>
                <div className="merge-output-row">
                  <input
                    type="text"
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                    placeholder={t(MERGE.dirPlaceholder)}
                  />
                  <button onClick={chooseDirectory}>{t(COMMON.browse)}</button>
                </div>
              </div>
              <label className="dialog-field">
                <span>{t(MERGE.sourcePattern)}</span>
                <input
                  type="text"
                  value={sourcePattern}
                  onChange={(e) => setSourcePattern(e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>{t(MERGE.outputPattern)}</span>
                <input
                  type="text"
                  value={outputPattern}
                  onChange={(e) => setOutputPattern(e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>{t(MERGE.autoSortKey)}</span>
                <input
                  type="text"
                  value={autoSortKey}
                  onChange={(e) => setAutoSortKey(e.target.value)}
                />
              </label>
              <p className="dialog-text">
                {fill(t(MERGE.example), {
                  source: DEFAULT_MERGE_PATTERNS.sourcePattern,
                  output: DEFAULT_MERGE_PATTERNS.outputPattern,
                  sort: DEFAULT_MERGE_PATTERNS.sortKey,
                })}
              </p>
            </>
          )}
          <label className="tool-field">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            {t(MERGE.overwrite)}
          </label>
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onCancel}>
            {t(COMMON.cancel)}
          </button>
          <button className="dialog-primary" disabled={busy} onClick={run}>
            {busy ? t(MERGE.merging) : t(MERGE.start)}
          </button>
        </div>
      </div>
    </div>
  );
}
