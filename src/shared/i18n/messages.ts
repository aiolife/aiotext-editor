/**
 * 文案汇总 —— 批量转繁體的输入源（PRD §3.6）
 *
 * ## 为什么需要这份汇总
 *
 * 繁體是**启动时一次性**把全部简体文案送后端跑 OpenCC `s2twp` 得到的
 * （PRD §3.6 落地口径：不在每次渲染时转换）。所以必须有一个地方能把「所有需要
 * 转换的文本」完整列出来——漏一条，那条在繁體下就还是简体。
 *
 * ## 动态文本为什么在这里
 *
 * `COMMANDS` 的命令名与分组名不是硬编码在组件里的文案，而是 `shortcuts.ts`
 * 的数据。它们同样要转繁體，所以一并纳进转换批次。反过来，后端的 `catalog()`
 * 工具名由 Rust 侧自己转（PRD L-5：后端文本重启后生效），不在这里。
 */

import { COMMON } from './common';
import { MENU_A11Y, MENU_MISC, MENU_TOP } from './menu';
import { COMMANDS } from '../shortcuts';
import { LANG_OPTIONS } from './index';
import {
  ENCODING_OPTIONS,
  ENCODING_OR_AUTO_OPTIONS,
  LINE_ENDING_OPTIONS,
  THEME_OPTIONS,
  VARIANT_STRICTNESS_OPTIONS,
} from '../../platform/tauriApi';
import {
  SETTINGS_APPEARANCE,
  SETTINGS_COMPARE,
  SETTINGS_CONVERSION,
  SETTINGS_EDITOR,
  SETTINGS_FOOTER,
  SETTINGS_SHORTCUTS,
  SETTINGS_TABS,
} from './settings';
import { STATUS } from './status';

/** 各领域文案表。key 是领域名，value 是「语义 key → 简体原文」 */
export const MESSAGE_GROUPS = {
  COMMON,
  MENU_TOP,
  MENU_A11Y,
  MENU_MISC,
  STATUS,
  SETTINGS_TABS,
  SETTINGS_APPEARANCE,
  SETTINGS_EDITOR,
  SETTINGS_CONVERSION,
  SETTINGS_COMPARE,
  SETTINGS_SHORTCUTS,
  SETTINGS_FOOTER,
} as const;

/** `COMMANDS` 里的命令名与分组名（动态文本，同样参与转换） */
export function commandTexts(): string[] {
  const out = new Set<string>();
  for (const cmd of COMMANDS) {
    if (cmd.label) out.add(cmd.label);
    if (cmd.group) out.add(cmd.group);
  }
  return [...out];
}

/**
 * 下拉框 / 单选框的**选项文字**（PRD §3.6）
 *
 * 这些 label 住在 `tauriApi.ts` 的常量数组里（主题、编码、行尾、异体字强度、
 * 语言本身），同样是用户看得见的界面文案，一样要转。
 */
const OPTION_TEXTS = [
  LANG_OPTIONS,
  THEME_OPTIONS,
  ENCODING_OPTIONS,
  ENCODING_OR_AUTO_OPTIONS,
  LINE_ENDING_OPTIONS,
  VARIANT_STRICTNESS_OPTIONS,
];

/**
 * 全部待转换的简体文本（去重、保序）。
 *
 * 顺序无所谓——后端返回的是与入参一一对应的数组，前端按位置配对成 Map。
 */
export function allSimplifiedTexts(): string[] {
  const out = new Set<string>();
  for (const group of Object.values(MESSAGE_GROUPS)) {
    for (const value of Object.values(group)) {
      if (typeof value === 'string' && value) out.add(value);
    }
  }
  for (const text of commandTexts()) out.add(text);
  for (const options of OPTION_TEXTS) {
    for (const option of options) {
      if (option.label) out.add(option.label);
    }
  }
  return [...out];
}
