/**
 * 界面多语言运行时（PRD §3.6）
 *
 * ## 为什么「简体原文即 key」
 *
 * 繁體不是人工翻译的，是拿简体原文跑 OpenCC `s2twp` 生成的（PRD §3.6 目标形态）。
 * 既然译文机器生成，就没有「同一个 key 对应两套人工译文」这回事——给每条文案
 * 再起一个英文 key 只是多一层无用间接。所以这里 **`t()` 的入参就是简体原文**，
 * 运行时查「原文 → 当前语言文本」的映射。
 *
 * 带来的好处：后端 `catalog()` 的工具名、前端 `COMMANDS` 的命令名这类**动态文本**
 * 天然能走同一条路，不用给它们也编一套 key。
 *
 * ## 文案去哪了
 *
 * 组件里不再写中文字面量，一律 `t(MENU.file)` —— 文案本体在本目录下的领域表里
 * （`menu.ts` / `status.ts` / `settings.ts` / `common.ts`）。这既是 PRD L-1
 * 「组件内不残留硬编码中文」的要求，也是批量转换的输入源：转换时把表里所有 value
 * 一次性送后端转繁體，组件那边什么都不用管。
 *
 * ## 两套 `t`
 *
 * - `useI18n().t`：**组件用**。走 Context，切语言时会触发重渲染。
 * - 直接导出的 `t()`：**非组件代码用**（常量数组、工具函数）。它不触发重渲染，
 *   所以只应该在渲染期之外、或者调用方自己已经是响应式的情况下用。
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';

/** 支持的语言。繁體 id 用 `zh-Hant` 而非 `zh-TW`：它是「繁體中文」而不是「台湾」 */
export type Lang = 'zh' | 'zh-Hant';

export const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' },
];

/** 原文 → 繁體。null 表示还没从后端取回来（此时 `t()` 一律回退简体原文） */
export type TraditionalMap = ReadonlyMap<string, string>;

interface I18nValue {
  lang: Lang;
  map: TraditionalMap | null;
}

const I18nContext = createContext<I18nValue>({ lang: 'zh', map: null });

/**
 * 非组件代码用的 `t`。
 *
 * 模块级单例，不触发重渲染——调用方若需要在切语言时跟着变，请用 `useI18n().t`。
 */
let moduleState: I18nValue = { lang: 'zh', map: null };

export function t(text: string): string {
  if (moduleState.lang !== 'zh-Hant') return text;
  return moduleState.map?.get(text) ?? text;
}

/** 供 Provider 在切语言时同步给模块级单例 */
function syncModuleState(value: I18nValue): void {
  moduleState = value;
}

interface LanguageProviderProps {
  lang: Lang;
  map: TraditionalMap | null;
  children: ReactNode;
}

/**
 * 把当前语言与繁體映射注入子树。
 *
 * `lang` / `map` 都由外层（App）持有并持久化——本模块只负责「给定语言怎么取文本」，
 * 不自己存设置，避免和 `settingsStore` 出现第二份真相。
 */
export function LanguageProvider({ lang, map, children }: LanguageProviderProps) {
  const value = useMemo<I18nValue>(() => ({ lang, map }), [lang, map]);
  syncModuleState(value);
  return createElement(I18nContext.Provider, { value }, children);
}

/** 组件用：拿到绑定了当前语言的 `t`，切语言时会重渲染 */
export function useI18n(): { lang: Lang; t: (text: string) => string } {
  const { lang, map } = useContext(I18nContext);
  const translate = useCallback(
    (text: string) => (lang === 'zh-Hant' && map ? map.get(text) ?? text : text),
    [lang, map],
  );
  return { lang, t: translate };
}
