/**
 * 正文统计（视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数；状态栏计数）
 *
 * 口径按需求写死在这里，便于单测锁定：
 *
 * - **按码点**计数：代理对（surrogate pair，如 `𩅯`）算 **1** 个字符而不是 2
 *   （`.length` 会数成 2，这就是不直接用它的原因）。
 * - **不计空格**：半角空格、全角空格 `U+3000`、NBSP、制表符、换行在内的空白都不计。
 * - **不计控制符**：`\u0000–\u001F`、`\u007F–\u009F`。
 * - **段落数 = 空行分隔的连续非空行块**，**非空行数 = trim 后非空的行数**，
 *   两者是**不同口径**（见 `paragraphs` 的注释），都要给是因为用户要并排看。
 *
 * ## 为什么这么写（性能）
 *
 * 这个函数不只是「点菜单时算一次」——状态栏每改一次文档就要重算，是**热路径**，
 * 1 MB 的文档按朴素写法（`Array.from` + 逐字符 `\p{L}` 正则）要 250 ms，
 * 打字会肉眼可见地卡。所以这里：
 *
 * 1. **一次扫描，零分配**：不用 `Array.from(text)`（那会先复制出几百万个元素的数组），
 *    而是直接扫 UTF-16 code unit、遇到代理对就地合成码点；UTF-8 字节数按码点宽度累加，
 *    不必真的 `TextEncoder.encode` 一遍（那要再分配一份完整 buffer）。
 * 2. **分类先查表再兜底**：ASCII 走快路径；汉字 / 中文标点 / 常见字母区（`isLetterRange`）
 *    用码点范围判断；只有表外的陌生字符才调用 `\p{L}` 正则。
 *
 * 实测 1 MB 混合文本：朴素写法 256 ms → 现在约 20 ms（见 CHANGELOG v0.7）。
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

/**
 * 常见「纯字母」区间：这些区间里**每个码位都是字母**（刻意绕开了各区块里混着的
 * 符号与组合记号），命中即可直接计字母，省掉一次 `\p{L}` 正则调用——中文/日文/韩文
 * 混排时，逐字符正则调用是全文扫描最贵的一环。表外字符仍走正则兜底，口径不退化。
 */
function isLetterRange(code: number): boolean {
  return (
    (code >= 0x0100 && code <= 0x024f) || // Latin Extended-A / B
    (code >= 0x0400 && code <= 0x0481) || // 西里尔
    (code >= 0x048a && code <= 0x052f) || // 西里尔补充
    (code >= 0x1e00 && code <= 0x1eff) || // Latin Extended Additional
    (code >= 0x2c60 && code <= 0x2c7f) || // Latin Extended-C
    (code >= 0x3041 && code <= 0x3096) || // 平假名
    (code >= 0x309d && code <= 0x309f) || // 平假名iteration marks
    (code >= 0x30a1 && code <= 0x30fa) || // 片假名（0x30FB 是 `・`，不算字母）
    (code >= 0x30fd && code <= 0x30ff) ||
    (code >= 0xa000 && code <= 0xa48c) || // 彝文音节
    (code >= 0xac00 && code <= 0xd7a3) // 谚文音节
  );
}

const LETTER_RE = /\p{L}/u;
const SPACE_RE = /\s/u;
/** ASCII 标点（不含空格——空格单算） */
const ASCII_PUNCT_CODES = new Set(
  [...`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`].map((c) => c.charCodeAt(0)),
);

const SPACE = 0x20;
const TAB = 0x09;
const NBSP = 0xa0;
const IDEOGRAPHIC_SPACE = 0x3000;
const CR = 0x0d;
const LF = 0x0a;

export function countTextStats(text: string): TextStats {
  let chineseChars = 0;
  let chinesePunct = 0;
  let letters = 0;
  let words = 0;
  let englishPunct = 0;
  let digits = 0;
  let numberGroups = 0;
  let counted = 0;
  let withSpace = 0;
  let charsAll = 0;
  let bytes = 0;
  let lines = 1;
  let nonEmptyLines = 0;
  let paragraphs = 0;
  // 扫描状态
  let inWord = false;
  let inDigitRun = false;
  let inParagraph = false;
  let lineHasContent = false;
  let prevWasCr = false;

  const len = text.length;
  for (let i = 0; i < len; ) {
    const unit = text.charCodeAt(i);
    let code = unit;
    let width = 1;
    // 代理对：就地合成一个码点（`𩅯` 因此算 1 个字符而不是 2）
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < len) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + (unit - 0xd800) * 0x400 + (low - 0xdc00);
        width = 2;
      }
    }
    charsAll += 1;
    i += width;

    // UTF-8 字节数：按码点宽度累加，不必真的 encode 出一份 buffer
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;

    // ---- 换行：`\r\n` 只算一次；顺带结算上一行 ----
    if (code === LF || code === CR) {
      const isNewLine = !(code === LF && prevWasCr);
      prevWasCr = code === CR;
      if (isNewLine) {
        lines += 1;
        if (lineHasContent) {
          nonEmptyLines += 1;
          if (!inParagraph) {
            paragraphs += 1;
            inParagraph = true;
          }
        } else {
          inParagraph = false;
        }
        lineHasContent = false;
      }
      inWord = false;
      inDigitRun = false;
      continue;
    }
    prevWasCr = false;

    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const isSpaceCode =
      code === SPACE || code === TAB || code === NBSP || code === IDEOGRAPHIC_SPACE;

    // ---- 字符归类（顺序有讲究，见各分支注释） ----
    let isLetterCh = false;
    let isDigitCh = false;
    let isHanCh = false;
    let recognized = true; // 是否被下面的分支认领过（认不出的走 \s 兜底）
    if (code < 0x80) {
      if ((unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a)) {
        letters += 1;
        isLetterCh = true;
      } else if (unit >= 0x30 && unit <= 0x39) {
        digits += 1;
        isDigitCh = true;
      } else if (ASCII_PUNCT_CODES.has(unit)) {
        englishPunct += 1;
      }
    } else if (isHan(code)) {
      chineseChars += 1;
      isHanCh = true;
    } else if (isChinesePunct(code)) {
      chinesePunct += 1;
    } else if (code >= 0xff10 && code <= 0xff19) {
      // 全角数字 ０-９（在全角标点范围之外，先拦下来）
      digits += 1;
      isDigitCh = true;
    } else if ((code >= 0xff21 && code <= 0xff3a) || (code >= 0xff41 && code <= 0xff5a)) {
      // 全角字母 Ａ-Ｚ / ａ-ｚ
      letters += 1;
      isLetterCh = true;
    } else if (isLetterRange(code)) {
      letters += 1;
      isLetterCh = true;
    } else if (LETTER_RE.test(String.fromCodePoint(code))) {
      letters += 1;
      isLetterCh = true;
    } else {
      recognized = false;
    }

    // ---- 单词 / 数字组（连续成串，遇其它字符断开） ----
    // 汉字不算词：`\p{L}` 会把汉字判成字母，若不排除，`汉字，abc` 会被数成 2 个词
    if (isHanCh) {
      inWord = false;
    } else {
      const isWordCh =
        isLetterCh || isDigitCh || code === 0x27 /* ' */ || code === 0x2d /* - */;
      if (isWordCh) {
        if (!inWord) {
          words += 1;
          inWord = true;
        }
      } else {
        inWord = false;
      }
    }
    if (isDigitCh) {
      if (!inDigitRun) {
        numberGroups += 1;
        inDigitRun = true;
      }
    } else {
      inDigitRun = false;
    }

    // ---- 字数三口径 ----
    if (!control && !isSpaceCode) {
      counted += 1;
      withSpace += 1;
    } else if (code === SPACE || code === IDEOGRAPHIC_SPACE) {
      // 「含空格」那一栏要把空格补回来；制表符 / NBSP / 控制符两边都不计
      withSpace += 1;
    }

    // ---- 这一行是不是空行（`trim` 连 NBSP 也去掉，所以 NBSP 在这里算空白） ----
    if (!control && !isSpaceCode) {
      if (recognized || code <= 0x7f) lineHasContent = true;
      // 表外陌生字符（如 U+2002）：交给 \s 判一下，日常文本极少走到这里
      else if (!SPACE_RE.test(String.fromCodePoint(code))) lineHasContent = true;
    }
  }

  // 结算最后一行（文末没有换行符）
  if (lineHasContent) {
    nonEmptyLines += 1;
    if (!inParagraph) paragraphs += 1;
  }

  return {
    chineseChars,
    chinesePunct,
    letters,
    words,
    englishPunct,
    digits,
    numberGroups,
    chars: counted,
    charsWithSpace: withSpace,
    charsAll,
    lines,
    nonEmptyLines,
    paragraphs,
    bytes,
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
