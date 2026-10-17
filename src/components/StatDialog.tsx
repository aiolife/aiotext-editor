/**
 * 通用「统计 / 信息」对话框（视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数）
 *
 * 三个菜单项要展示的是一组**多行**结果，塞进状态栏的一行提示会挤成一团，
 * 所以统一走这个对话框：`rows` 由调用方按各自的口径算好，这里只负责排版。
 */
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
  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog dialog-wide" role="dialog" aria-label={title}>
        <h2 className="dialog-title">{title}</h2>
        {subtitle ? <p className="dialog-text">{subtitle}</p> : null}
        <dl className={columns === 2 ? 'doc-stats doc-stats-2col' : 'doc-stats'}>
          {rows.map((row) => (
            <div className="doc-stats-row" key={row.label}>
              <dt>
                {row.label}
                {row.hint ? <span className="doc-stats-hint">{row.hint}</span> : null}
              </dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {note ? <p className="dialog-text doc-stats-note">{note}</p> : null}
        <div className="dialog-actions">
          <button onClick={onClose} autoFocus>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
