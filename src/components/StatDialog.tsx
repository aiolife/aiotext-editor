/**
 * 通用「统计 / 信息」对话框（视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数）
 *
 * 三个菜单项要展示的是一组**多行**结果，塞进状态栏的一行提示会挤成一团，
 * 所以统一走这个对话框：`rows` 由调用方按各自的口径算好，这里只负责排版。
 *
 * `title` / `subtitle` / `rows` 的文案由调用方（App）传给这里，故统一在这里过一遍
 * `t`；调用方只需给简体原文，不必自己翻译。
 */
import { useI18n } from '../shared/i18n';
import { COMMON } from '../shared/i18n/common';

interface StatRow {
  label: string;
  value: string | number;
  /** 口径说明（如「不计空格与控制符」），悬停或次要文字里出现 */
  hint?: string;
}

interface StatDialogProps {
  title: string;
  /** 标题下的补充（通常是作用范围：全文 / 选区 / 文件） */
  subtitle?: string;
  rows: StatRow[];
  /** 底部说明（如「已按代理对合并计数」） */
  note?: string;
  /** 行数多时两列排（`字数统计` 有十几项，一列会长到超出屏幕） */
  columns?: 1 | 2;
  onClose: () => void;
}

export function StatDialog({
  title,
  subtitle,
  rows,
  note,
  columns = 1,
  onClose,
}: StatDialogProps) {
  const { t } = useI18n();
  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog dialog-wide" role="dialog" aria-label={t(title)}>
        <h2 className="dialog-title">{t(title)}</h2>
        {subtitle ? <p className="dialog-text">{t(subtitle)}</p> : null}
        <dl className={columns === 2 ? 'doc-stats doc-stats-2col' : 'doc-stats'}>
          {rows.map((row) => (
            <div className="doc-stats-row" key={row.label}>
              <dt>
                {t(row.label)}
                {row.hint ? <span className="doc-stats-hint">{t(row.hint)}</span> : null}
              </dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {note ? <p className="dialog-text doc-stats-note">{t(note)}</p> : null}
        <div className="dialog-actions">
          <button onClick={onClose} autoFocus>
            {t(COMMON.close)}
          </button>
        </div>
      </div>
    </div>
  );
}
