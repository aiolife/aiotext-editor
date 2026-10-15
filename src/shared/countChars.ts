/**
 * 字符统计（按 Unicode 码点，正确处理增补平面字符如 𩅯）
 *
 * 注意：绝不可按 UTF-16 码元切分——TextPro fc2 异体字组含扩展 B 区字符
 * （代理对），按码元切分会把一个字拆成两半（见 docs/06-data-dictionary.md §3.1）。
 */
export interface CharStats {
  /** Unicode 码点数（1 个增补平面字符计 1） */
  codePoints: number;
  /** UTF-16 码元数（length 属性口径） */
  utf16Units: number;
}

export function countChars(s: string): CharStats {
  let codePoints = 0;
  // 迭代器按码点推进，代理对自动合并
  for (const _ of s) codePoints += 1;
  return { codePoints, utf16Units: s.length };
}
