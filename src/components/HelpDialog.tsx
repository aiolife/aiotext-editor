/**
 * 帮助与快捷键（第九阶段）
 *
 * 内置帮助页：不联网、不打开外部浏览器，直接把用户最需要的东西摆出来。
 *
 * ## 为什么把快捷键一览做进帮助里
 *
 * 快捷键的**默认键位只有一份事实来源**（`shared/shortcuts.ts` 的 `COMMANDS`），
 * 用户改绑后设置里也只存覆盖项。所以帮助页不去抄一份写死的快捷键表——那样改了
 * 键位就会和帮助对不上。这里直接把 `COMMANDS` + 当前绑定渲染出来，**帮助页永远
 * 说的是实话**（包括「未绑定」）。
 *
 * 用 `Esc` 关闭；版本号来自后端 `app_version`（`Cargo.toml` 的 `version`），
 * 避免前端再维护第二个版本号。
 */
import { useEffect, useMemo, useState } from 'react';
import { appVersion } from '../platform/tauriApi';
import { useBindings } from '../store/settingsStore';
import { COMMANDS, formatKey, isMacPlatform, type ResolvedBinding } from '../shared/shortcuts';
import { useI18n } from '../shared/i18n';
import { HELP } from '../shared/i18n/help';
import { COMMON } from '../shared/i18n/common';

interface HelpDialogProps {
  onClose: () => void;
}

/** 一条命令 + 它当前生效的绑定 */
interface HelpRow {
  id: string;
  label: string;
  binding: ResolvedBinding | undefined;
}

export function HelpDialog({ onClose }: HelpDialogProps) {
  const { t } = useI18n();
  const mac = isMacPlatform();
  /** 撤销组合键（纯文案，按平台显示；命令注册表里没有 undo 命令） */
  const undoKey = mac ? '⌘Z' : 'Ctrl+Z';
  const bindings = useBindings();
  const [version, setVersion] = useState('');

  useEffect(() => {
    appVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  // Esc 关闭（捕获阶段：避免被输入框吃掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 按 `COMMANDS` 里的分组顺序分组（不排序，保持注册表的编排意图）
  const groups = useMemo(() => {
    const out = new Map<string, HelpRow[]>();
    for (const cmd of COMMANDS) {
      const list = out.get(cmd.group);
      const row: HelpRow = { id: cmd.id, label: cmd.label, binding: bindings.get(cmd.id) };
      if (list) list.push(row);
      else out.set(cmd.group, [row]);
    }
    return [...out.entries()];
  }, [bindings]);

  return (
    <div className="dialog-overlay" role="dialog" aria-label={t(HELP.title)}>
      <div className="dialog help-dialog">
        <h2 className="dialog-title">{t(HELP.title)}</h2>

        <div className="dialog-body help-body">
          {groups.map(([name, rows]) => (
            <section key={name} className="help-group">
              <div className="menu-group-title">{t(name)}</div>
              <ul className="help-list">
                {rows.map((row) => (
                  <li key={row.id}>
                    <span className="help-label">{t(row.label)}</span>
                    <span className="help-keys">
                      {row.binding?.key ? (
                        <kbd>{formatKey(row.binding.key, mac)}</kbd>
                      ) : (
                        <span className="help-unbound">{t(HELP.unbound)}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="help-group">
            <div className="menu-group-title">{t(HELP.tipsTitle)}</div>
            <ul className="help-tips">
              <li>
                {/* 夹 <kbd> 的长句拆成前后两截翻译，中间那个空格留在 JSX 里 */}
                {t(HELP.tip1Prefix)} <kbd>{undoKey}</kbd> {t(HELP.tip1Suffix)}
              </li>
              <li>{t(HELP.tip2)}</li>
              <li>{t(HELP.tip3)}</li>
              <li>{t(HELP.tip4)}</li>
            </ul>
          </section>

          <section className="help-group">
            <div className="menu-group-title">{t(HELP.aboutTitle)}</div>
            <ul className="help-tips">
              <li>
                {t(HELP.about1Prefix)} {version ? `v${version}` : ''} {t(HELP.about1Suffix)}
              </li>
              <li>{t(HELP.about2)}</li>
              <li>
                {t(HELP.about3Prefix)} <code>AioTextEditor/settings.json</code>{' '}
                {t(HELP.about3Mid)} <code>session.json</code>
                {t(HELP.about3Suffix)}
              </li>
            </ul>
          </section>
        </div>

        <div className="dialog-actions">
          <span className="dialog-hint">{t(HELP.escHint)}</span>
          <button type="button" className="dialog-primary" onClick={onClose}>
            {t(COMMON.close)}
          </button>
        </div>
      </div>
    </div>
  );
}
