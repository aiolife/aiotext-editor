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
  const [targetTabId, setTargetTabId] = useState(tabs[0]?.id ?? '');
  const [opts, setOpts] = useState<CompareOptions>(DEFAULT_COMPARE_OPTIONS);
  const [orientation, setOrientation] = useState<CompareOrientation>('vertical');

  const disabled = tabs.length === 0 || targetTabId === '';

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <h2 className="dialog-title">文件比较</h2>
        <p className="dialog-text">
          「{activeName}」为 A 窗，对照文本在 B 窗显示（只读）。开始后 F5 跳下一处差异，
          Shift+F5 从两个光标处重新比较。
        </p>
        <div className="dialog-body compare-dialog">
          <label className="dialog-field">
            <span>对照标签（B 窗）</span>
            <select
              value={targetTabId}
              onChange={(e) => setTargetTabId(e.target.value)}
              disabled={tabs.length === 0}
            >
              {tabs.length === 0 ? <option value="">（请先再打开一个文件）</option> : null}
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.fileName || '未命名'}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="dialog-fieldset">
            <legend>忽略项</legend>
            <div className="tool-fields">
              {(
                [
                  ['ignoreNewlines', '回车'],
                  ['ignoreHalfSpace', '半角空格'],
                  ['ignoreFullPunct', '全角标点'],
                  ['ignoreHalfPunct', '半角标点'],
                ] as [keyof CompareOptions, string][]
              ).map(([key, label]) => (
                <label key={key} className="tool-field">
                  <input
                    type="checkbox"
                    checked={opts[key] as boolean}
                    onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="dialog-field">
            <span>异体字策略</span>
            <select
              value={opts.variantStrictness}
              onChange={(e) =>
                setOpts({ ...opts, variantStrictness: e.target.value as VariantStrictness })
              }
            >
              {VARIANT_STRICTNESS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="dialog-fieldset">
            <legend>平铺方向</legend>
            <div className="tool-fields">
              <label className="tool-field">
                <input
                  type="radio"
                  name="compare-orientation"
                  checked={orientation === 'vertical'}
                  onChange={() => setOrientation('vertical')}
                />
                上下平铺
              </label>
              <label className="tool-field">
                <input
                  type="radio"
                  name="compare-orientation"
                  checked={orientation === 'horizontal'}
                  onChange={() => setOrientation('horizontal')}
                />
                左右平铺
              </label>
            </div>
          </fieldset>
        </div>
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onCancel}>
            取消
          </button>
          <button
            className="dialog-primary"
            disabled={disabled}
            onClick={() => onStart(targetTabId, opts, orientation)}
          >
            开始比较
          </button>
        </div>
      </div>
    </div>
  );
}
