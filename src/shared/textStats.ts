/**
 * 正文统计（视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数）
 *
 * 口径按需求写死在这里，便于单测锁定：
 *
 * - **按码点**计数：`Array.from(text)`，所以代理对（surrogate pair，如 `𩅯`）
 *   算 **1** 个字符，而不是 2（`.length` 会数成 2，这就是不直接用它的原因）。
 * - **不计空格**：空格、全角空格 `U+3000`、制表符、换行在内的所有空白都不计。
 * - **不计控制符**：`\u0000–\u001F`、`\u007F–\u009F`（ Cc 类别）。
 * - **段落数 = 非空行数**：与整理工具「段间空一行」的口径一致（那段
 *   `insert_blank_between` 也是按「每个非空行 = 一段」处理的），两处必须同口径，
 *   否则会出现「工具插了 9 个空行、这里说只有 3 段」的自相矛盾。
 */
export interface TextStats {
  /** 字符数（不计空格与控制符，代理对算 1） */
  chars: number;
  /** 字符数（计入空格、不计控制符，代理对算 1） */
  charsWithSpace: number;
  /** 字符数（含空格与控制符，即全部码点） */
  charsAll: number;
  /** 行数（含空行；空文档为 1 行） */
  lines: number;
  /** 段落数（非空行数） */
  paragraphs: number;
  /** UTF-8 字节数 */
  bytes: number;
}

/** 空白（含全角空格）与控制符都「不算字数」 */
function isIgnored(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  if (control) return true;
  if (ch === ' ' || ch === '\u3000') return true;
  // 其余 Unicode 空白（\t \n \v \f \r NBSP 等）：\s 覆盖 ASCII 版，NBSP 需单独判
  return ch === '\u00a0';
}

export function countTextStats(text: string): TextStats {
  const chars = Array.from(text);
  let counted = 0;
  let withSpace = 0;
  for (const ch of chars) {
    const isSpace = ch === ' ' || ch === '\u3000';
    if (isIgnored(ch)) {
      // 「含空格」那一栏要把空格补回来；换行 / 制表符等控制符两边都不算
      if (isSpace) withSpace += 1;
      continue;
    }
    counted += 1;
    withSpace += 1;
  }
  const lines = text.length === 0 ? 1 : text.split(/\r\n|\r|\n/).length;
  const paragraphs = chars.length === 0 ? 0 : text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').length;
  return {
    chars: counted,
    // 上面的循环里 `withSpace` 已经把「非忽略字符」和「空格」都算进去了
    charsWithSpace: withSpace,
    charsAll: chars.length,
    lines,
    paragraphs,
    bytes: new TextEncoder().encode(text).length,
  };
}

/**
 * 统计 `needle` 在 `text` 中出现的次数（非重叠，从头往后数）。
 * 空串返回 0——否则「没选东西」会得到一个毫无意义的巨大数字。
 */
export function countOccurrences(text: string, needle: string): number {
  if (needle === '' || text === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const hit = text.indexOf(needle, from);
    if (hit < 0) return count;
    count += 1;
    from = hit + needle.length;
  }
}
