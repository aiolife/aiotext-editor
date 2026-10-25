/**
 * 替换表管理对话框（F-04 §4.9）
 *
 * 左侧表清单（用户表 / 内置示例表）+ 右侧源文本编辑器：
 * - 编辑即实时校验（后端解析，**错误行标红**，问题列表可点击跳转）
 * - 保存前若仍有错误则被后端阻止（F-04 §4.8）
 * - 支持新建 / 导入 TextPro `.tab` / 另存副本 / 删除（内置表不可删）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NEW_TABLE_TEMPLATE,
  applyReplace,
  deleteReplaceTable,
  ensureReplaceTables,
  importTextproTab,
  listReplaceTables,
  parseReplaceTableText,
  pickTableFile,
  readReplaceTableSource,
  saveReplaceTableSource,
  type ParsedTable,
  type ReplaceRules,
  type ReplaceTable,
  type TableMeta,
} from '../platform/tauriApi';
import { TableSourceEditor } from './TableSourceEditor';
import { useI18n } from '../shared/i18n';
import { REPLACE_RULES, REPLACE_TABLE } from '../shared/i18n/replace';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

interface ReplaceTableDialogProps {
  onClose: () => void;
  /** 顶部提示条（保存成功等） */
  onNotice: (message: string) => void;
  /** 表集合变化（供转换对话框刷新「用户表」列表） */
  onTablesChanged: () => void;
  /** 当前标签正文（用于「应用到正文」；无标签时传 null） */
  activeContent: string | null;
  /** 独立替换结果写回正文（F-04 模式 A） */
  onApplyText: (text: string) => void;
}

/** 结构化表 → 源文本（仅用于把「导入」结果放进编辑器；保存走源文本） */
function renderTableText(table: ReplaceTable): string {
  const lines = ['# AioTextEditor 自定义替换表（TextPro 风格：A/B=目标）'];
  if (table.name) lines.push(`#name: ${table.name}`);
  if (table.description) lines.push(`#desc: ${table.description}`);
  const rules = table.rules;
  lines.push(
    `#rules: escape=${rules.escape ? 1 : 0},wholeWord=${rules.wholeWord ? 1 : 0},` +
      `caseSensitive=${rules.caseSensitive ? 1 : 0},useRegex=${rules.useRegex ? 1 : 0}`,
  );
  for (const entry of table.entries) {
    const left = entry.pattern || entry.candidates.join('/');
    if (!left || !entry.replacement) continue;
    lines.push(`${left}=${entry.replacement}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 覆写/插入 `#rules:` 行（规则开关落在表内，随文件持久化） */
function upsertRulesLine(text: string, rules: ReplaceRules): string {
  const line =
    `#rules: escape=${rules.escape ? 1 : 0},wholeWord=${rules.wholeWord ? 1 : 0},` +
    `caseSensitive=${rules.caseSensitive ? 1 : 0},useRegex=${rules.useRegex ? 1 : 0}`;
  const lines = text.split('\n');
  const index = lines.findIndex((l) => l.trim().toLowerCase().startsWith('#rules:'));
  if (index >= 0) {
    lines[index] = line;
  } else {
    let insertAt = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#')) insertAt = i + 1;
      else if (trimmed !== '') break;
    }
    lines.splice(insertAt, 0, line);
  }
  return lines.join('\n');
}

export function ReplaceTableDialog({
  onClose,
  onNotice,
  onTablesChanged,
  activeContent,
  onApplyText,
}: ReplaceTableDialogProps) {
  const { t } = useI18n();
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [selected, setSelected] = useState<TableMeta | null>(null);
  const [text, setText] = useState(NEW_TABLE_TEMPLATE);
  const [parsed, setParsed] = useState<ParsedTable | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // 内置示例表是**按需**落盘的（见 lib.rs setup 的说明）：启动时不再后台复制，
    // 改在打开本对话框时兜一次 —— 幂等，只补缺失的文件，不会把用户改名/删掉的
    // 内置表覆盖回来。失败也不阻塞，列表照拉（大不了内置表暂时不显示）。
    await ensureReplaceTables().catch(() => {});
    const list = await listReplaceTables();
    setTables(list);
    onTablesChanged();
    return list;
  }, [onTablesChanged]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  // 实时校验（防抖 250ms）
  useEffect(() => {
    const handle = window.setTimeout(() => {
      parseReplaceTableText(text, selected?.name ?? t(REPLACE_TABLE.newTableName))
        .then(setParsed)
        .catch((e) => setError(String(e)));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [text, selected, t]);

  const openTable = useCallback(
    async (meta: TableMeta) => {
      setBusy(true);
      setError(null);
      try {
        const source = await readReplaceTableSource(meta.name);
        setSelected(meta);
        setText(source);
        setDirty(false);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleNew = useCallback(() => {
    setSelected(null);
    setText(NEW_TABLE_TEMPLATE);
    setDirty(false);
    setError(null);
  }, []);

  const handleImport = useCallback(async () => {
    const path = await pickTableFile();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importTextproTab(path, null);
      setSelected(null);
      setText(renderTableText(imported));
      setDirty(true);
      onNotice(fill(t(REPLACE_TABLE.imported), { count: imported.entries.length }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onNotice, t]);

  const handleSave = useCallback(
    async (asCopy: boolean) => {
      const current = parsed?.table.name ?? selected?.name ?? t(REPLACE_TABLE.newTableName);
      let name = current;
      let nextText = text;
      if (asCopy) {
        const input = window.prompt(
          t(REPLACE_TABLE.promptName),
          fill(t(REPLACE_TABLE.copySuffix), { name: current }),
        );
        if (!input) return;
        name = input.trim();
        // 改写 `#name:`（没有该行则插到最前），保证文件名与显示名一致
        const lines = nextText.split('\n');
        const index = lines.findIndex((l) => l.trim().toLowerCase().startsWith('#name:'));
        if (index >= 0) {
          lines[index] = `#name: ${name}`;
        } else {
          lines.unshift(`#name: ${name}`);
        }
        nextText = lines.join('\n');
      }
      setBusy(true);
      setError(null);
      try {
        const meta = await saveReplaceTableSource(name, nextText, asCopy ? null : (selected?.path ?? null));
        setText(nextText);
        setDirty(false);
        await refresh();
        setSelected(meta);
        onNotice(fill(t(REPLACE_TABLE.saved), { name: meta.name, count: meta.entryCount }));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [onNotice, parsed, refresh, selected, t, text],
  );

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(fill(t(REPLACE_TABLE.confirmDelete), { name: selected.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteReplaceTable(selected.name);
      await refresh();
      setSelected(null);
      setText(NEW_TABLE_TEMPLATE);
      setDirty(false);
      onNotice(fill(t(REPLACE_TABLE.deleted), { name: selected.name }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onNotice, refresh, selected, t]);

  /** F-04 模式 A：用独立引擎（Aho-Corasick）把当前表应用到正文 */
  const handleApplyToDocument = useCallback(async () => {
    if (activeContent == null || !parsed) return;
    setBusy(true);
    setError(null);
    try {
      const report = await applyReplace(activeContent, parsed.table, { mode: 'standalone' });
      if (report.changedCount === 0) {
        onNotice(fill(t(REPLACE_TABLE.noHit), { name: parsed.table.name }));
        return;
      }
      onApplyText(report.text);
      // 词条原文是用户数据，只拼接不翻译
      const top = Object.entries(report.perEntryCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([word, count]) => `${word}×${count}`)
        .join('、');
      onNotice(
        fill(t(REPLACE_TABLE.applied), {
          name: parsed.table.name,
          count: report.changedCount,
          top,
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [activeContent, onApplyText, onNotice, parsed, t]);

  const errorLines = useMemo(
    () =>
      (parsed?.report.issues ?? [])
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.line)
        .filter((line) => line > 0),
    [parsed],
  );

  const userTables = tables.filter((t) => !t.builtin);
  const builtinTables = tables.filter((t) => t.builtin);
  const rules = parsed?.table.rules;

  const toggleRule = (key: keyof ReplaceRules) => {
    if (!rules) return;
    setText((prev) => upsertRulesLine(prev, { ...rules, [key]: !rules[key] }));
    setDirty(true);
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-table" role="dialog" aria-modal="true">
        <h3 className="dialog-title">{t(REPLACE_TABLE.title)}</h3>

        <div className="table-dialog-body">
          <aside className="table-list">
            <div className="menu-group-title">
              {fill(t(REPLACE_TABLE.userTables), { count: userTables.length })}
            </div>
            {userTables.map((meta) => (
              <button
                key={meta.path}
                type="button"
                className={`table-item${selected?.path === meta.path ? ' table-item-active' : ''}`}
                onClick={() => void openTable(meta)}
              >
                <span className="table-item-name">{meta.name}</span>
                <span className="table-item-count">
                  {fill(t(REPLACE_TABLE.entryCount), { count: meta.entryCount })}
                </span>
              </button>
            ))}
            {userTables.length === 0 && (
              <div className="dialog-hint">{t(REPLACE_TABLE.noUserTable)}</div>
            )}

            <div className="menu-group-title">
              {fill(t(REPLACE_TABLE.builtinTables), { count: builtinTables.length })}
            </div>
            {builtinTables.map((meta) => (
              <button
                key={meta.path}
                type="button"
                className={`table-item${selected?.path === meta.path ? ' table-item-active' : ''}`}
                onClick={() => void openTable(meta)}
              >
                <span className="table-item-name">
                  {meta.name}
                  <span className="table-badge">{t(REPLACE_TABLE.builtin)}</span>
                </span>
                <span className="table-item-count">
                  {fill(t(REPLACE_TABLE.entryCount), { count: meta.entryCount })}
                </span>
              </button>
            ))}

            <div className="table-list-actions">
              <button type="button" onClick={handleNew} disabled={busy}>
                {t(REPLACE_TABLE.new)}
              </button>
              <button type="button" onClick={() => void handleImport()} disabled={busy}>
                {t(REPLACE_TABLE.import)}
              </button>
              <button type="button" onClick={() => void handleDelete()} disabled={busy || !selected}>
                {t(REPLACE_TABLE.delete)}
              </button>
            </div>
          </aside>

          <section className="table-editor">
            <div className="table-editor-head">
              {/* 路径是用户数据，只填充不翻译 */}
              <span className="dialog-hint">
                {selected
                  ? fill(t(REPLACE_TABLE.sourceFile), { path: selected.path })
                  : t(REPLACE_TABLE.newTableHint)}
              </span>
              <span className={`table-state${dirty ? ' table-state-dirty' : ''}`}>
                {dirty ? t(REPLACE_TABLE.dirty) : t(REPLACE_TABLE.clean)}
              </span>
            </div>

            <TableSourceEditor
              value={text}
              errorLines={errorLines}
              onChange={(next) => {
                setText(next);
                setDirty(true);
              }}
            />

            <div className="table-rules">
              <span className="dialog-hint">{t(REPLACE_TABLE.rulesLabel)}</span>
              {(
                [
                  ['wholeWord', REPLACE_RULES.wholeWord],
                  ['caseSensitive', REPLACE_RULES.caseSensitive],
                  ['escape', REPLACE_RULES.escape],
                  ['useRegex', REPLACE_RULES.useRegex],
                ] as [keyof ReplaceRules, string][]
              ).map(([key, label]) => (
                <label key={key} className="search-option">
                  <input
                    type="checkbox"
                    checked={rules?.[key] ?? false}
                    disabled={!rules}
                    onChange={() => toggleRule(key)}
                  />
                  {t(label)}
                </label>
              ))}
            </div>

            <div className="table-report">
              {parsed ? (
                <>
                  <span className={parsed.report.ok ? 'table-ok' : 'table-bad'}>
                    {parsed.report.ok
                      ? fill(t(REPLACE_TABLE.validOk), { count: parsed.report.entryCount })
                      : fill(t(REPLACE_TABLE.hasErrors), { count: parsed.report.errors })}
                    {parsed.report.warnings > 0 &&
                      fill(t(REPLACE_TABLE.warningsSuffix), {
                        count: parsed.report.warnings,
                      })}
                  </span>
                  {parsed.report.issues.length > 0 && (
                    <ul className="issue-list">
                      {parsed.report.issues.slice(0, 40).map((issue, index) => (
                        <li
                          key={`${issue.line}-${index}`}
                          className={issue.severity === 'error' ? 'issue-error' : 'issue-warning'}
                        >
                          {issue.line > 0 && (
                            <span className="issue-line">
                              {fill(t(REPLACE_TABLE.lineAt), { line: issue.line })}
                            </span>
                          )}
                          {/* issue.message 由后端按语言给出（PRD L-5） */}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <span className="dialog-hint">{t(REPLACE_TABLE.validating)}</span>
              )}
            </div>
          </section>
        </div>

        {error && <div className="dialog-error">{error}</div>}

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-primary"
            onClick={() => void handleSave(false)}
            disabled={busy || !parsed || !parsed.report.ok}
            title={
              parsed && !parsed.report.ok
                ? t(REPLACE_TABLE.saveBlocked)
                : t(REPLACE_TABLE.saveHint)
            }
          >
            {t(REPLACE_TABLE.save)}
          </button>
          <button
            type="button"
            onClick={() => void handleSave(true)}
            disabled={busy || !parsed || !parsed.report.ok}
          >
            {t(REPLACE_TABLE.saveAsCopy)}
          </button>
          <button
            type="button"
            onClick={() => void handleApplyToDocument()}
            disabled={busy || !parsed || !parsed.report.ok || activeContent == null}
            title={
              activeContent == null
                ? t(REPLACE_TABLE.applyBlocked)
                : t(REPLACE_TABLE.applyHint)
            }
          >
            {t(REPLACE_TABLE.applyToDoc)}
          </button>
          <button type="button" className="dialog-cancel" onClick={onClose} disabled={busy}>
            {t(COMMON.close)}
          </button>
        </div>
      </div>
    </div>
  );
}
