/**
 * 正文统计（视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数）
 *
 * 口径按需求写死在这里，便于单测锁定：
 *
 * - **按码点**计数：`Array.from(text)`，所以代理对（surrogate pair，如 `𩅯`）
 *   算 **1** 个字符，而不是 2（`.length` 会数成 2，这就是不直接用它的原因）。
 * - **不计空格**：空格、全角空格 `U+3000`、NBSP、制表符、换行在内的空白都不计。
 * - **不计控制符**：`\u0000–\u001F`、`\u007F–\u009F`（ Cc 类别）。
 * - **段落数 = 空行分隔的连续非空行块**，**非空行数 = trim 后非空的行数**，
 *   两者是**不同口径**（见 `paragraphs` 的注释），都要给是因为用户要并排看。
 */
export interface TextStats {
  /** 中文字数（汉字个数，含扩展区；々 / 〇 也算汉字） */
  chineseChars: number;
  /** 中文标点个数（、。，「」【】……—— 及全角形标点） */
  chinesePunct: number;
  /** 字母个数（含拉丁、希腊、西里尔、假名、谚文等所有 Unicode 字母） */
  letters: number;
  /** 单词个数（一串连续的字母/数字，可夹杂 ' 与 -，算一个词） */
  words: number;
  /** 英文标点个数（ASCII 标点） */
  englishPunct: number;
  /** 数字个数（十进制数字字符，含全角 ０-９） */
  digits: number;
  /** 数字组个数（连续数字算一组） */
  numberGroups: number;
  /** 字符数（不计空格与控制符，代理对算 1） */
  chars: number;
  /** 字符数（计入空格、不计控制符） */
  charsWithSpace: number;
  /** 字符数（含空格与控制符，即全部码点） */
  charsAll: number;
  /** 行数（含空行；空文档为 1 行） */
  lines: number;
  /** 非空行数（trim 后非空的行数） */
  nonEmptyLines: number;
  /** 段落数（空行分隔的连续非空行块） */
  paragraphs: number;
  /** UTF-8 字节数 */
  bytes: number;
}

/** 空白与控制符都不计"字数" */
function isIgnored(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  if (control) return true;
  return ch === ' ' || ch === '\u3000' || ch === '\u00a0';
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\u3000';
}

/** 汉字区（含扩展 A/B…、兼容表意文字；`々` 与 `〇` 也算） */
function isHan(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2ebef) ||
    code === 0x3005 ||
    code === 0x3007
  );
}

/** 中文 / 全角标点：不含 `U+3000`（那是全角空格，归到"空格"里） */
function isChinesePunct(code: number): boolean {
  return (
    (code >= 0x3001 && code <= 0x303f) ||
    (code >= 0xff01 && code <= 0xff0f) ||
    (code >= 0xff1a && code <= 0xff20) ||
    (code >= 0xff3b && code <= 0xff40) ||
    (code >= 0xff5b && code <= 0xff65) ||
    code === 0x2018 ||
    code === 0x2019 ||
    code === 0x201c ||
    code === 0x201d ||
    code === 0x2014 ||
    code === 0x2026
  );
}

const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{Nd}/u;
const ASCII_PUNCT = new Set([...`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`]);

function isLetter(ch: string): boolean {
  return LETTER_RE.test(ch);
}

function isDigit(ch: string): boolean {
  return DIGIT_RE.test(ch);
}

/**
 * 单词内的字符：字母与数字，`'` `-` 允许出现在一串里（can't / well-known 算一个词）。
 *
 * **汉字不算词**——`\p{L}` 会把汉字也当成字母，若不排除，`汉字，abc` 会被数成
 * 2 个词；中文的问题由 `chineseChars`（字数）回答，这里只数西文单词。
 */
function isWordChar(ch: string): boolean {
  if (isHan(ch.codePointAt(0) ?? 0)) return false;
  return isLetter(ch) || isDigit(ch) || ch === "'" || ch === '-';
}

/** 按「连续字符成串」数出组数：`countRuns('2024年12月', isDigit)` → 2 */
function countRuns(chars: string[], pick: (ch: string) => boolean): number {
  let groups = 0;
  let inRun = false;
  for (const ch of chars) {
    const hit = pick(ch);
    if (hit && !inRun) {
      groups += 1;
      inRun = true;
    } else if (!hit) {
      inRun = false;
    }
  }
  return groups;
}

export function countTextStats(text: string): TextStats {
  const chars = Array.from(text);
  let counted = 0;
  let withSpace = 0;
  let chineseChars = 0;
  let chinesePunct = 0;
  let letters = 0;
  let englishPunct = 0;
  let digits = 0;
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    if (isHan(code)) chineseChars += 1;
    else if (isChinesePunct(code)) chinesePunct += 1;
    else if (isLetter(ch)) letters += 1;
    else if (isDigit(ch)) digits += 1;
    else if (ASCII_PUNCT.has(ch)) englishPunct += 1;

    if (isIgnored(ch)) {
      // 「含空格」那一栏要把空格补回来；换行 / 制表符等控制符两边都不算
      if (isSpace(ch)) withSpace += 1;
      continue;
    }
    counted += 1;
    withSpace += 1;
  }
  const lineArray = text.split(/\r\n|\r|\n/);
  const nonEmptyLines = lineArray.filter((line) => line.trim() !== '').length;
  // 段落 = 被空行隔开的连续非空行块（区别于上面的 nonEmptyLines：
  // 「甲\n乙」是 2 个非空行、但只算 1 段）
  let paragraphs = 0;
  let inParagraph = false;
  for (const line of lineArray) {
    const blank = line.trim() === '';
    if (!blank && !inParagraph) {
      paragraphs += 1;
      inParagraph = true;
    } else if (blank) {
      inParagraph = false;
    }
  }
  return {
    chineseChars,
    chinesePunct,
    letters,
    words: countRuns(chars, isWordChar),
    englishPunct,
    digits,
    numberGroups: countRuns(chars, isDigit),
    chars: counted,
    // 上面的循环里 `withSpace` 已经把「非忽略字符」和「空格」都算进去了
    charsWithSpace: withSpace,
    charsAll: chars.length,
    lines: text.length === 0 ? 1 : lineArray.length,
    nonEmptyLines,
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
