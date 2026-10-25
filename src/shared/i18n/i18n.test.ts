/**
 * i18n 单测（PRD §3.6）
 *
 * GUI 端到端跑不起来的情况下，这里守住两件最容易悄悄坏掉的事：
 * ① 待转换文案**收集全了没有**（漏一条，那条在繁體下就还是简体）；
 * ② 带占位符的文案在插值和转繁體之后，占位符还在不在。
 */

import { describe, expect, it } from 'vitest';
import { LANG_OPTIONS } from './index';
import { MESSAGE_GROUPS, allSimplifiedTexts, commandTexts } from './messages';
import { STATUS, fill } from './status';
import { COMMANDS } from '../shortcuts';

describe('allSimplifiedTexts — 待转换文案收集', () => {
  const texts = allSimplifiedTexts();

  it('每条都非空、且已去重', () => {
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.trim()).not.toBe('');
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('★ 各领域表里的文案都被收集到', () => {
    for (const [name, group] of Object.entries(MESSAGE_GROUPS)) {
      for (const [key, value] of Object.entries(group)) {
        expect(texts, `${name}.${key}`).toContain(value);
      }
    }
  });

  it('★ COMMANDS 的命令名与分组名都被收集到', () => {
    const fromCommands = commandTexts();
    expect(fromCommands.length).toBeGreaterThan(0);
    for (const text of fromCommands) {
      expect(texts, `COMMANDS 里的「${text}」`).toContain(text);
    }
    // 抽查一条确实来自 COMMANDS 的
    const first = COMMANDS[0];
    expect(texts).toContain(first.label);
  });

  it('语言选项自身也在转换批次里（繁體下要显示「簡體中文」）', () => {
    for (const option of LANG_OPTIONS) expect(texts).toContain(option.label);
  });

  it('状态栏带占位符的整条被收集，而不是被拆开', () => {
    expect(texts).toContain(STATUS.rowCol);
    expect(texts).toContain(STATUS.columnSize);
  });
});

describe('fill — 占位符替换', () => {
  it('替换全部占位符', () => {
    expect(fill(STATUS.rowCol, { line: 3, col: 12 })).toBe('行 3，列 12');
    expect(fill(STATUS.columnSize, { rows: 4, cols: 2 })).toBe('垂直选择 4 行 × 2 列');
  });

  it('多个相同占位符会一并替换', () => {
    expect(fill('{a} / {a} / {b}', { a: 'X', b: 'Y' })).toBe('X / X / Y');
  });

  it('缺失的占位符原样留下（不吞字、不抛错）', () => {
    expect(fill('行 {line}，列 {col}', { line: 1 })).toBe('行 1，列 {col}');
  });

  it('★ 转繁體后占位符仍在——翻译不能把 {xxx} 吃掉', () => {
    // 模拟 OpenCC 的输出：词变了、占位符必须原样
    const converted = STATUS.columnSize.replace('垂直选择', '垂直選擇').replace('行', '行');
    expect(fill(converted, { rows: 3, cols: 5 })).toBe('垂直選擇 3 行 × 5 列');
    expect(fill(STATUS.stats, { chinese: 10, words: 2, bytes: 30 })).toBe(
      '汉字 10 · 单词 2 · 30 字节',
    );
  });
});
