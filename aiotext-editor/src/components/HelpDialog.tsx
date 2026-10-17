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
    <div className="dialog-overlay" role="dialog" aria-label="帮助与快捷键">
      <div className="dialog help-dialog">
        <h2 className="dialog-title">帮助与快捷键</h2>

        <div className="dialog-body help-body">
          {groups.map(([name, rows]) => (
            <section key={name} className="help-group">
              <div className="menu-group-title">{name}</div>
              <ul className="help-list">
                {rows.map((row) => (
                  <li key={row.id}>
                    <span className="help-label">{row.label}</span>
                    <span className="help-keys">
                      {row.binding?.key ? (
                        <kbd>{formatKey(row.binding.key, mac)}</kbd>
                      ) : (
                        <span className="help-unbound">未绑定</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="help-group">
            <div className="menu-group-title">使用提示</div>
            <ul className="help-tips">
              <li>
                「整理」菜单里带「…」的工具可调选项并实时预览；有选区时只整理选区，否则整理整篇，
                全部可以用 <kbd>{undoKey}</kbd> 撤销。
              </li>
              <li>关闭有未保存修改的标签时会先询问；下次启动会自动恢复上次的标签与未保存内容。</li>
              <li>设置改动立即生效并自动保存，没有「确定 / 取消」；误改可在「设置」菜单里恢复默认。</li>
              <li>
                快捷键可随时改绑：「设置 → 自定义快捷键…」。与系统冲突的组合会被拒绝，应用内重复会标红提示。
              </li>
            </ul>
          </section>

          <section className="help-group">
            <div className="menu-group-title">关于</div>
            <ul className="help-tips">
              <li>AioTextEditor {version ? `v${version}` : ''} —— 中文文本处理专用编辑器。</li>
              <li>完全离线：不发起任何网络请求，不检查更新，不自动更新版本。</li>
              <li>
                设置与恢复数据保存在用户数据目录下的 <code>AioTextEditor/settings.json</code> 与{' '}
                <code>session.json</code>。
              </li>
            </ul>
          </section>
        </div>

        <div className="dialog-actions">
          <span className="dialog-hint">按 Esc 关闭</span>
          <button type="button" className="dialog-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
