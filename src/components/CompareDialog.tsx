/**
 * 文件比较选项对话框（F-06 §6.2 用户故事 2）
 *
 * 用户选择「与哪个标签对照」与忽略项，开始后进入双栏平铺比较模式
 * （当前激活标签 = A 窗，所选标签 = B 窗，只读）。
 */
import { useState } from 'react';
import type { EditorTab } from '../store/tabsStore';
import {
  DEFAULT_COMPARE_OPTIONS,
  VARIANT_STRICTNESS_OPTIONS,
  type CompareOptions,
  type VariantStrictness,
} from '../platform/tauriApi';
import { useI18n } from '../shared/i18n';
import { COMPARE } from '../shared/i18n/compare';
import { COMMON } from '../shared/i18n/common';
import { fill } from '../shared/i18n/status';

/** 平铺方向 */
export type CompareOrientation = 'horizontal' | 'vertical';

interface CompareDialogProps {
  /** 除当前激活标签外的可选标签 */
  tabs: EditorTab[];
  /** 当前激活标签名（对话框里说明谁是 A 窗） */
  activeName: string;
  onStart: (targetTabId: string, opts: CompareOptions, orientation: CompareOrientation) => void;
  onCancel: () => void;
}

export function CompareDialog({ tabs, activeName, onStart, onCancel }: CompareDialogProps) {
  const { t } = useI18n();
  const [targetTabId, setTargetTabId] = useState(tabs[0]?.id ?? '');
  const [opts, setOpts] = useState<CompareOptions>(DEFAULT_COMPARE_OPTIONS);
  const [orientation, setOrientation] = useState<CompareOrientation>('vertical');

  const disabled = tabs.length === 0 || targetTabId === '';

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <h2 className="dialog-title">{t(COMPARE.title)}</h2>
        {/* activeName 是文件名（用户数据），只填充不翻译 */}
        <p className="dialog-text">{fill(t(COMPARE.desc), { name: activeName })}</p>
        <div className="dialog-body compare-dialog">
          <label className="dialog-field">
            <span>{t(COMPARE.targetTab)}</span>
            <select
              value={targetTabId}
              onChange={(e) => setTargetTabId(e.target.value)}
              disabled={tabs.length === 0}
            >
              {tabs.length === 0 ? (
                <option value="">{t(COMPARE.noOtherTab)}</option>
              ) : null}
              {/* 标签名是文件名（用户数据），不翻译 */}
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.fileName || t(COMPARE.unnamed)}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="dialog-fieldset">
            <legend>{t(COMPARE.ignoreLegend)}</legend>
            <div className="tool-fields">
              {(
                [
                  ['ignoreNewlines', COMPARE.ignoreNewlines],
                  ['ignoreHalfSpace', COMPARE.ignoreHalfSpace],
                  ['ignoreFullPunct', COMPARE.ignoreFullPunct],
                  ['ignoreHalfPunct', COMPARE.ignoreHalfPunct],
                ] as [keyof CompareOptions, string][]
              ).map(([key, label]) => (
                <label key={key} className="tool-field">
                  <input
                    type="checkbox"
                    checked={opts[key] as boolean}
                    onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })}
                  />
                  {t(label)}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="dialog-field">
            <span>{t(COMPARE.variantTitle)}</span>
            <select
              value={opts.variantStrictness}
              onChange={(e) =>
                setOpts({ ...opts, variantStrictness: e.target.value as VariantStrictness })
              }
            >
              {VARIANT_STRICTNESS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="dialog-fieldset">
            <legend>{t(COMPARE.orientationLegend)}</legend>
            <div className="tool-fields">
              <label className="tool-field">
                <input
                  type="radio"
                  name="compare-orientation"
                  checked={orientation === 'vertical'}
                  onChange={() => setOrientation('vertical')}
                />
                {t(COMPARE.orientationVertical)}
              </label>
              <label className="tool-field">
                <input
                  type="radio"
                  name="compare-orientation"
                  checked={orientation === 'horizontal'}
                  onChange={() => setOrientation('horizontal')}
                />
                {t(COMPARE.orientationHorizontal)}
              </label>
            </div>
          </fieldset>
        </div>
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onCancel}>
            {t(COMMON.cancel)}
          </button>
          <button
            className="dialog-primary"
            disabled={disabled}
            onClick={() => onStart(targetTabId, opts, orientation)}
          >
            {t(COMPARE.start)}
          </button>
        </div>
      </div>
    </div>
  );
}
