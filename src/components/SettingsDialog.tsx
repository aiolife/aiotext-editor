/**
 * F-11 偏好设置对话框（第八阶段）
 *
 * 多页签：外观 / 编辑器 / 转换 / 比较 / 快捷键。
 *
 * ## 没有「确定 / 取消」
 *
 * 改动**立即生效、立即落盘**（store 内防抖 300ms），与 VS Code 一致。
 * 于是不存在「对话框里的草稿值 vs 已生效值」两套状态，也不会出现「改完忘了保存」。
 * 代价是误改无法用「取消」回退，故提供两级「恢复默认」：
 * 单个快捷键行的「默认」按钮，以及页脚的「恢复全部默认」。
 *
 * ## 快捷键录制
 *
 * 点「录制」后进入捕获态，用**捕获阶段**的 `keydown` 监听抢在全局命令分发器
 * 之前拿到按键并 `stopPropagation`——否则按下 `Ctrl+S` 会先触发保存再被录成键位。
 * `Esc` 取消录制，纯修饰键（只按下 Ctrl）继续等待。
 *
 * 冲突分两类，处理方式不同：
 * - **系统保留键**（`Alt+F4`、macOS 的 `⌘Q`…）：在到达 WebView 前就被系统吃掉，
 *   绑了也不会触发，故**拒绝分配**并说明原因。
 * - **应用内重复**：允许保存但给出提示（列表里两行同时标红），因为用户可能
 *   正在把旧命令腾出来，先绑后解是正常操作顺序。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ENCODING_OR_AUTO_OPTIONS,
  FONT_SIZE_RANGE,
  LINE_ENDING_OPTIONS,
  TAB_WIDTH_RANGE,
  THEME_OPTIONS,
  VARIANT_STRICTNESS_OPTIONS,
} from '../platform/tauriApi';
import { useSettingsStore } from '../store/settingsStore';
import {
  COMMANDS,
  conflictsWith,
  findConflicts,
  formatKey,
  isMacPlatform,
  keyFromEvent,
  reservedReason,
  resolveBindings,
} from '../shared/shortcuts';
import { useI18n, LANG_OPTIONS } from '../shared/i18n';
import {
  SETTINGS_APPEARANCE,
  SETTINGS_COMPARE,
  SETTINGS_CONVERSION,
  SETTINGS_EDITOR,
  SETTINGS_FOOTER,
  SETTINGS_SHORTCUTS,
  SETTINGS_TABS,
} from '../shared/i18n/settings';
import { fill } from '../shared/i18n/status';

export type SettingsTab = 'appearance' | 'editor' | 'conversion' | 'compare' | 'shortcuts';

/** tab 名：key 与 `SettingsTab` 一致，渲染时过一遍 `t` */
const TABS: { id: SettingsTab; key: keyof typeof SETTINGS_TABS }[] = [
  { id: 'appearance', key: 'appearance' },
  { id: 'editor', key: 'editor' },
  { id: 'conversion', key: 'conversion' },
  { id: 'compare', key: 'compare' },
  { id: 'shortcuts', key: 'shortcuts' },
];

interface SettingsDialogProps {
  onClose: () => void;
  onNotice: (msg: string) => void;
  /** 初始页签（「自定义快捷键…」直接开到快捷键页） */
  initialTab?: SettingsTab;
}

/** 一行设置：左标签、右控件、下方可选说明 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsDialog({ onClose, onNotice, initialTab = 'appearance' }: SettingsDialogProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const settings = useSettingsStore((s) => s.settings);
  const saving = useSettingsStore((s) => s.saving);
  const saveError = useSettingsStore((s) => s.saveError);
  const update = useSettingsStore((s) => s.update);
  const reset = useSettingsStore((s) => s.reset);
  const flush = useSettingsStore((s) => s.flush);

  const mac = useMemo(() => isMacPlatform(), []);
  /** 正在录制的命令 ID（null = 未录制） */
  const [capturing, setCapturing] = useState<string | null>(null);
  /** 录制时的即时提示（系统保留键被拒 / 与谁冲突） */
  const [captureHint, setCaptureHint] = useState<string | null>(null);

  const bindings = useMemo(() => resolveBindings(settings.shortcuts), [settings.shortcuts]);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
  /** 命令 → 它参与的冲突键位（列表里打红标） */
  const conflictByCommand = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conflicts) {
      for (const cmd of c.commands) {
        map.set(cmd, map.has(cmd) ? `${map.get(cmd)}、${c.key}` : c.key);
      }
    }
    return map;
  }, [conflicts]);

  /** 关闭前立即落盘（防抖计时器可能还没到） */
  const close = () => {
    void flush();
    onClose();
  };

  /**
   * 捕获阶段抢按键。`capture: true` 是关键：全局分发器挂在冒泡阶段，
   * 这里先一步 `stopPropagation` 就能避免「录制 Ctrl+S 顺手把文件存了」。
   */
  useEffect(() => {
    if (capturing === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        setCaptureHint(null);
        return;
      }
      const key = keyFromEvent(e);
      if (key === null) return; // 纯修饰键：等主键
      const command = capturing;
      setCapturing(null);
      const reason = reservedReason(key);
      if (reason !== null) {
        setCaptureHint(`${formatKey(key, mac)} 已被系统占用（${reason}），无法分配`);
        onNotice(`${formatKey(key, mac)} 不可分配：${reason}`);
        return;
      }
      const others = conflictsWith(bindings, command, key);
      update({ shortcuts: { ...settings.shortcuts, [command]: key } });
      setCaptureHint(
        others.length > 0
          ? `已绑定 ${formatKey(key, mac)}，但它同时还属于：${others.join('、')}`
          : null,
      );
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, bindings, settings.shortcuts, update, onNotice, mac]);

  /** 解绑（空串 = 显式解绑，见 `shortcuts.ts` 的三态约定） */
  const unbind = (command: string) => {
    update({ shortcuts: { ...settings.shortcuts, [command]: '' } });
    setCaptureHint(null);
  };

  /** 恢复单个命令的默认键位（删掉覆盖项） */
  const restoreDefault = (command: string) => {
    const next = { ...settings.shortcuts };
    delete next[command];
    update({ shortcuts: next });
    setCaptureHint(null);
  };

  /** 按分组渲染命令（分组顺序沿用注册表出现顺序） */
  const groups = useMemo(() => {
    const out = new Map<string, typeof COMMANDS>();
    for (const cmd of COMMANDS) {
      const list = out.get(cmd.group);
      if (list) (list as (typeof COMMANDS)[number][]).push(cmd);
      else out.set(cmd.group, [cmd]);
    }
    return [...out.entries()];
  }, []);

  return (
    <div className="dialog-overlay" role="dialog" aria-label="选项">
      <div className="dialog settings-dialog">
        <h2 className="dialog-title">选项</h2>

        <div className="settings-tabs" role="tablist">
          {/* 形参叫 `tb` 不叫 `t`：后者是翻译函数，遮蔽了会让整段文案静默退回简体 */}
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={tab === tb.id}
              className={tab === tb.id ? 'settings-tab is-active' : 'settings-tab'}
              onClick={() => setTab(tb.id)}
            >
              {t(SETTINGS_TABS[tb.key])}
            </button>
          ))}
        </div>

        <div className="dialog-body settings-body">
          {tab === 'appearance' ? (
            <>
              <Row label={t(SETTINGS_APPEARANCE.bodyFont)} hint={t(SETTINGS_APPEARANCE.bodyFontHint)}>
                <input
                  type="text"
                  className="settings-input-wide"
                  value={settings.appearance.fontFamily}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, fontFamily: e.target.value },
                    })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_APPEARANCE.fontSize)}
                hint={fill(t(SETTINGS_APPEARANCE.fontSizeHint), {
                  min: FONT_SIZE_RANGE.min,
                  max: FONT_SIZE_RANGE.max,
                })}
              >
                <input
                  type="range"
                  min={FONT_SIZE_RANGE.min}
                  max={FONT_SIZE_RANGE.max}
                  value={settings.appearance.fontSize}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, fontSize: Number(e.target.value) },
                    })
                  }
                />
                <input
                  type="number"
                  className="settings-number"
                  min={FONT_SIZE_RANGE.min}
                  max={FONT_SIZE_RANGE.max}
                  value={settings.appearance.fontSize}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, fontSize: Number(e.target.value) },
                    })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_APPEARANCE.theme)} hint={t(SETTINGS_APPEARANCE.themeHint)}>
                <select
                  value={settings.appearance.theme}
                  onChange={(e) =>
                    update({
                      appearance: {
                        ...settings.appearance,
                        theme: e.target.value as typeof settings.appearance.theme,
                      },
                    })
                  }
                >
                  {THEME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </Row>
              {/* 多语言（PRD §3.6）：与主题、字体同在「外观」tab，不新增 tab */}
              <Row
                label={t(SETTINGS_APPEARANCE.language)}
                hint={t(SETTINGS_APPEARANCE.languageHint)}
              >
                <select
                  value={settings.language}
                  onChange={(e) => update({ language: e.target.value as typeof settings.language })}
                >
                  {LANG_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t(SETTINGS_APPEARANCE.showLineNumber)}>
                <input
                  type="checkbox"
                  checked={settings.appearance.showLineNumber}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, showLineNumber: e.target.checked },
                    })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_APPEARANCE.showMenubar)}>
                <input
                  type="checkbox"
                  checked={settings.appearance.showToolbar}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, showToolbar: e.target.checked },
                    })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_APPEARANCE.showStatusBar)}>
                <input
                  type="checkbox"
                  checked={settings.appearance.showStatusBar}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, showStatusBar: e.target.checked },
                    })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_APPEARANCE.hideOnClose)}
                hint={t(SETTINGS_APPEARANCE.hideOnCloseHint)}
              >
                <input
                  type="checkbox"
                  checked={settings.hideOnClose}
                  onChange={(e) => update({ hideOnClose: e.target.checked })}
                />
              </Row>
            </>
          ) : null}

          {tab === 'editor' ? (
            <>
              <Row
                label={t(SETTINGS_EDITOR.tabWidth)}
                hint={fill(t(SETTINGS_EDITOR.tabWidthHint), {
                  min: TAB_WIDTH_RANGE.min,
                  max: TAB_WIDTH_RANGE.max,
                })}
              >
                <input
                  type="number"
                  className="settings-number"
                  min={TAB_WIDTH_RANGE.min}
                  max={TAB_WIDTH_RANGE.max}
                  value={settings.editor.tabWidth}
                  onChange={(e) =>
                    update({ editor: { ...settings.editor, tabWidth: Number(e.target.value) } })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_EDITOR.insertSpaces)}
                hint={t(SETTINGS_EDITOR.insertSpacesHint)}
              >
                <input
                  type="checkbox"
                  checked={settings.editor.insertSpaces}
                  onChange={(e) =>
                    update({ editor: { ...settings.editor, insertSpaces: e.target.checked } })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_EDITOR.wrap)}>
                <input
                  type="checkbox"
                  checked={settings.editor.wrap}
                  onChange={(e) => update({ editor: { ...settings.editor, wrap: e.target.checked } })}
                />
              </Row>
              {/* 不可见字符：校对用。画出来的是 decoration（提示符号），不进文档 */}
              <Row label={t(SETTINGS_EDITOR.showSpaces)} hint={t(SETTINGS_EDITOR.showSpacesHint)}>
                <input
                  type="checkbox"
                  checked={settings.appearance.showSpaces}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, showSpaces: e.target.checked },
                    })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_EDITOR.showLineEnds)}
                hint={t(SETTINGS_EDITOR.showLineEndsHint)}
              >
                <input
                  type="checkbox"
                  checked={settings.appearance.showLineEnds}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, showLineEnds: e.target.checked },
                    })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_EDITOR.showParagraphMarks)}
                hint={t(SETTINGS_EDITOR.showParagraphMarksHint)}
              >
                <input
                  type="checkbox"
                  checked={settings.appearance.showParagraphMarks}
                  onChange={(e) =>
                    update({
                      appearance: { ...settings.appearance, showParagraphMarks: e.target.checked },
                    })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_EDITOR.defaultEncoding)}
                hint={t(SETTINGS_EDITOR.defaultEncodingHint)}
              >
                <select
                  value={settings.editor.defaultEncoding}
                  onChange={(e) =>
                    update({
                      editor: { ...settings.editor, defaultEncoding: e.target.value },
                    })
                  }
                >
                  {ENCODING_OR_AUTO_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t(SETTINGS_EDITOR.defaultLineEnding)}>
                <select
                  value={settings.editor.defaultLineEnding}
                  onChange={(e) =>
                    update({
                      editor: {
                        ...settings.editor,
                        defaultLineEnding: e.target.value as typeof settings.editor.defaultLineEnding,
                      },
                    })
                  }
                >
                  {LINE_ENDING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          ) : null}

          {tab === 'conversion' ? (
            <>
              <Row
                label={t(SETTINGS_CONVERSION.bracketSkip)}
                hint={t(SETTINGS_CONVERSION.bracketSkipHint)}
              >
                <input
                  type="text"
                  className="settings-input-wide"
                  value={settings.conversion.bracketSkip}
                  onChange={(e) =>
                    update({
                      conversion: { ...settings.conversion, bracketSkip: e.target.value },
                    })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_CONVERSION.preserveConverted)}
                hint={t(SETTINGS_CONVERSION.preserveConvertedHint)}
              >
                <input
                  type="checkbox"
                  checked={settings.conversion.preserveConverted}
                  onChange={(e) =>
                    update({
                      conversion: { ...settings.conversion, preserveConverted: e.target.checked },
                    })
                  }
                />
              </Row>
            </>
          ) : null}

          {tab === 'compare' ? (
            <>
              <Row label={t(SETTINGS_COMPARE.ignoreNewlines)}>
                <input
                  type="checkbox"
                  checked={settings.compare.ignoreNewlines}
                  onChange={(e) =>
                    update({ compare: { ...settings.compare, ignoreNewlines: e.target.checked } })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_COMPARE.ignoreHalfSpace)}>
                <input
                  type="checkbox"
                  checked={settings.compare.ignoreHalfSpace}
                  onChange={(e) =>
                    update({ compare: { ...settings.compare, ignoreHalfSpace: e.target.checked } })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_COMPARE.ignoreFullPunct)}>
                <input
                  type="checkbox"
                  checked={settings.compare.ignoreFullPunct}
                  onChange={(e) =>
                    update({ compare: { ...settings.compare, ignoreFullPunct: e.target.checked } })
                  }
                />
              </Row>
              <Row label={t(SETTINGS_COMPARE.ignoreHalfPunct)}>
                <input
                  type="checkbox"
                  checked={settings.compare.ignoreHalfPunct}
                  onChange={(e) =>
                    update({ compare: { ...settings.compare, ignoreHalfPunct: e.target.checked } })
                  }
                />
              </Row>
              <Row
                label={t(SETTINGS_COMPARE.variantStrictness)}
                hint={t(SETTINGS_COMPARE.variantStrictnessHint)}
              >
                <select
                  value={settings.compare.variantStrictness}
                  onChange={(e) =>
                    update({
                      compare: {
                        ...settings.compare,
                        variantStrictness: e.target.value as typeof settings.compare.variantStrictness,
                      },
                    })
                  }
                >
                  {VARIANT_STRICTNESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          ) : null}

          {tab === 'shortcuts' ? (
            <div className="settings-shortcuts">
              <p className="dialog-hint">{t(SETTINGS_SHORTCUTS.hint)}</p>
              {captureHint ? <p className="settings-warn">{captureHint}</p> : null}
              {conflicts.length > 0 ? (
                <p className="settings-warn">
                  {fill(t(SETTINGS_SHORTCUTS.conflicts), { count: conflicts.length })}
                  {conflicts.map((c) => `${formatKey(c.key, mac)}（${c.commands.join('、')}）`).join('；')}
                </p>
              ) : null}
              {groups.map(([group, commands]) => (
                <section key={group} className="settings-shortcut-group">
                  <h3>{group}</h3>
                  {commands.map((cmd) => {
                    const binding = bindings.get(cmd.id);
                    const key = binding?.key ?? null;
                    const clashing = conflictByCommand.get(cmd.id);
                    const isCapturing = capturing === cmd.id;
                    return (
                      <div
                        key={cmd.id}
                        className={clashing ? 'settings-shortcut-row is-clashing' : 'settings-shortcut-row'}
                        data-command={cmd.id}
                      >
                        <span className="settings-shortcut-label">{t(cmd.label)}</span>
                        <span className="settings-shortcut-key">
                          {isCapturing ? (
                            <em className="settings-capturing">{t(SETTINGS_SHORTCUTS.capturing)}</em>
                          ) : key ? (
                            formatKey(key, mac)
                          ) : (
                            <em className="settings-unbound">{t(SETTINGS_SHORTCUTS.unbound)}</em>
                          )}
                          {binding?.source === 'custom' ? (
                            <small className="settings-custom-badge">
                              {t(SETTINGS_SHORTCUTS.customBadge)}
                            </small>
                          ) : null}
                        </span>
                        <span className="settings-shortcut-actions">
                          <button
                            type="button"
                            className="settings-mini"
                            onClick={() => {
                              setCaptureHint(null);
                              setCapturing(isCapturing ? null : cmd.id);
                            }}
                          >
                            {isCapturing ? t(SETTINGS_SHORTCUTS.cancel) : t(SETTINGS_SHORTCUTS.record)}
                          </button>
                          <button
                            type="button"
                            className="settings-mini"
                            disabled={key === null && binding?.source === 'unbound'}
                            onClick={() => unbind(cmd.id)}
                          >
                            {t(SETTINGS_SHORTCUTS.clear)}
                          </button>
                          <button
                            type="button"
                            className="settings-mini"
                            disabled={binding?.source === 'default'}
                            onClick={() => restoreDefault(cmd.id)}
                          >
                            {t(SETTINGS_SHORTCUTS.restoreDefault)}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          ) : null}
        </div>

        <div className="settings-footer">
          <span className="dialog-hint">
            {saveError ? (
              <span className="dialog-error">{saveError}</span>
            ) : saving ? (
              t(SETTINGS_FOOTER.saving)
            ) : (
              t(SETTINGS_FOOTER.autoSave)
            )}
          </span>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => {
                void reset();
                onNotice(t(SETTINGS_FOOTER.resetNotice));
              }}
            >
              {t(SETTINGS_FOOTER.resetAll)}
            </button>
            <button type="button" className="dialog-primary" onClick={close}>
              {t(SETTINGS_FOOTER.close)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
