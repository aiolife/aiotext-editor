//! 多编码 I/O 核心（F-02 完整版）
//!
//! 编码互转统一由 `encoding_rs`（WHATWG Encoding Standard 参考实现）承担，
//! 原生支持 UTF-8 / UTF-16 LE+BE / GBK / GB2312 / GB18030 / Big5 / ISO-8859-1 等。
//! 自动探测按 F-02 §2.2 顺序：BOM → UTF-8 严格 → `chardetng` 统计探测（中文优先）。
//! 不可编码字符保存时按 WHATWG 标准以数字字符引用 `&#xNNNN;` 写出，不丢字。

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// 支持的编码（与 docs/02-functional-spec.md F-02 §2.3 数据契约一致）
///
/// **serde 名必须与 `label()` 一致**（`"utf-8"` / `"utf-16le"` / `"iso-8859-1"` …）：
/// 前端 `ENCODING_OPTIONS` 用的就是 `label()` 这一套。原先这里靠
/// `#[serde(rename_all = "lowercase")]` 生成的是 `"utf8"` / `"utf16le"` / `"latin1"`，
/// 于是 `fs_write` 收到前端的 `"utf-8"` 在 serde 层就报
/// `unknown variant 'utf-8'` —— 保存必失败。老名字保留为 `alias`，兼容旧会话与旧请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    #[serde(rename = "utf-8", alias = "utf8")]
    Utf8,
    #[serde(rename = "utf-16le", alias = "utf16le", alias = "utf-16")]
    Utf16LE,
    #[serde(rename = "utf-16be", alias = "utf16be")]
    Utf16BE,
    /// WHATWG 将 GB2312 标签按 GBK 解析（超集兼容）
    #[serde(rename = "gb2312")]
    Gb2312,
    #[serde(rename = "gbk", alias = "cp936")]
    Gbk,
    /// 含 4 字节区，GB18030 ⊇ GBK ⊇ GB2312
    #[serde(rename = "gb18030")]
    Gb18030,
    #[serde(rename = "big5", alias = "cp950")]
    Big5,
    /// WHATWG 中 ISO-8859-1 标签 = windows-1252
    #[serde(rename = "iso-8859-1", alias = "latin1")]
    Latin1,
    /// DOS 码页 437（NFO / 建站老文件常用）。`encoding_rs` 是 WHATWG 子集、没有 437，
    /// 故本项由本文件的 `cp437` 表自行解码 / 编码。只用于「重新载入 / 打开时指定编码」。
    #[serde(rename = "cp437", alias = "437", alias = "ibm437", alias = "nfo")]
    Cp437,
}

impl Encoding {
    /// WHATWG 规范标签（用于 UI 显示与配置序列化）
    pub fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf-8",
            Encoding::Utf16LE => "utf-16le",
            Encoding::Utf16BE => "utf-16be",
            Encoding::Gb2312 => "gb2312",
            Encoding::Gbk => "gbk",
            Encoding::Gb18030 => "gb18030",
            Encoding::Big5 => "big5",
            Encoding::Latin1 => "iso-8859-1",
            Encoding::Cp437 => "cp437",
        }
    }

    /// UI 显示名（编码下拉框）
    pub fn display_name(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf16LE => "UTF-16 LE",
            Encoding::Utf16BE => "UTF-16 BE",
            Encoding::Gb2312 => "GB2312",
            Encoding::Gbk => "GBK",
            Encoding::Gb18030 => "GB18030",
            Encoding::Big5 => "Big5",
            Encoding::Latin1 => "ISO-8859-1 (windows-1252)",
            Encoding::Cp437 => "NFO (437)",
        }
    }

    /// 按 WHATWG 标签解析（含常用别名），用于「重新载入」手选编码等场景
    pub fn from_label(label: &str) -> Option<Encoding> {
        let normalized = label.trim().to_ascii_lowercase().replace(['-', '_'], "");
        match normalized.as_str() {
            "utf8" => Some(Encoding::Utf8),
            "utf16le" => Some(Encoding::Utf16LE),
            "utf16be" => Some(Encoding::Utf16BE),
            "utf16" => Some(Encoding::Utf16LE),
            "gb2312" => Some(Encoding::Gb2312),
            "gbk" | "cp936" => Some(Encoding::Gbk),
            "gb18030" => Some(Encoding::Gb18030),
            "big5" | "cp950" => Some(Encoding::Big5),
            "iso88591" | "latin1" | "windows1252" | "cp1252" => Some(Encoding::Latin1),
            "cp437" | "ibm437" | "437" | "nfo" => Some(Encoding::Cp437),
            _ => None,
        }
    }

    /// encoding_rs 解码器（GB2312 按 WHATWG 以 GBK 解析；Latin1 为 windows-1252）
    ///
    /// `None` 表示 `encoding_rs` 不管这种编码（目前只有 CP437），由本文件的
    /// `cp437` 表接管解码 / 编码。
    fn decoder(self) -> Option<&'static encoding_rs::Encoding> {
        Some(match self {
            Encoding::Utf8 => encoding_rs::UTF_8,
            Encoding::Utf16LE => encoding_rs::UTF_16LE,
            Encoding::Utf16BE => encoding_rs::UTF_16BE,
            Encoding::Gb2312 | Encoding::Gbk => encoding_rs::GBK,
            Encoding::Gb18030 => encoding_rs::GB18030,
            Encoding::Big5 => encoding_rs::BIG5,
            Encoding::Latin1 => encoding_rs::WINDOWS_1252,
            Encoding::Cp437 => return None,
        })
    }

    /// 该编码能否表示所有 Unicode 字符（UTF-8/UTF-16 恒真；Rust String 不含孤立代理）
    fn is_unicode(self) -> bool {
        matches!(self, Encoding::Utf8 | Encoding::Utf16LE | Encoding::Utf16BE)
    }
}

/// 输入 / 输出编码（前端：字符串 `"auto"` 或 `"utf-8"` / `"gbk"` …）
///
/// 用手写 Serialize/Deserialize 让前端发的是干净字符串：
/// - `"auto"`  → 自动探测（BOM → UTF-8 → chardetng）
/// - `"utf-8"` / `"gbk"` / `"big5"` / … → 按指定编码
///
/// 不派生 `Deserialize` 是因为 `#[serde(untagged)]` 下单元变体 `Auto` 会序列化成
/// `null` 而不是 `"auto"`（第七阶段踩过的坑），故手写。
///
/// 位置说明：本类型原在 `core::batch`，第七阶段结束后提到 `encoding`（它是通用的
/// 编码概念，并被 F-11 设置的 `defaultEncoding` 复用）；`core::batch` 仍再导出，
/// 既有引用路径不变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EncodingOrAuto {
    #[default]
    Auto,
    Fixed(Encoding),
}

impl EncodingOrAuto {
    pub fn is_auto(self) -> bool {
        matches!(self, EncodingOrAuto::Auto)
    }
}

impl Serialize for EncodingOrAuto {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        match self {
            EncodingOrAuto::Auto => ser.serialize_str("auto"),
            EncodingOrAuto::Fixed(e) => ser.serialize_str(e.label()),
        }
    }
}

impl<'de> Deserialize<'de> for EncodingOrAuto {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let s = String::deserialize(de)?;
        if s == "auto" {
            Ok(EncodingOrAuto::Auto)
        } else {
            let enc = Encoding::from_label(&s)
                .ok_or_else(|| Error::custom(format!("未知编码或保留字：{s}")))?;
            Ok(EncodingOrAuto::Fixed(enc))
        }
    }
}

/// 行尾风格
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Cr,
    CrLf,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "LF",
            LineEnding::Cr => "CR",
            LineEnding::CrLf => "CRLF",
        }
    }

    pub fn from_label(label: &str) -> Option<LineEnding> {
        match label.trim().to_ascii_lowercase().as_str() {
            "lf" => Some(LineEnding::Lf),
            "cr" => Some(LineEnding::Cr),
            "crlf" => Some(LineEnding::CrLf),
            _ => None,
        }
    }
}

/// 打开文件的解码结果（F-02 §2.3 `LoadResult`）
///
/// `text` 为行尾已归一为 LF 的内部表示（CRLF / CR 在读入时统一），
/// 原始行尾风格记录在 `line_ending`，保存时据此默认还原。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub text: String,
    pub encoding: Encoding,
    pub had_bom: bool,
    pub line_ending: LineEnding,
}

/// 不可编码字符策略（保存为非 Unicode 编码时）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnmappablePolicy {
    /// 弹窗询问（交互保存默认）。后端若在 `fs_write` 收到该值且确有不可编码字符，
    /// 返回错误交由前端预检弹窗，用户决策后再以 CharRef / ToUtf8 重调。
    Ask,
    /// 写成 `&#xNNNN;` 数字字符引用（WHATWG 标准行为，批处理默认）
    CharRef,
    /// 自动改存 UTF-8（带 BOM 由 addBom 决定）
    ToUtf8,
}

/// 保存选项（F-02 §2.3 `SaveOptions`）
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOptions {
    pub encoding: Encoding,
    pub add_bom: bool,
    pub line_ending: LineEnding,
    pub unmappable: UnmappablePolicy,
}

/// 保存结果（F-02 §2.3 `SaveReport`）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub written_path: String,
    pub bytes_written: u64,
    /// 实际写出的编码（ToUtf8 策略回落时与请求不同）
    pub actual_encoding: Encoding,
    /// 以 `&#xNNNN;` 数字字符引用写出的字符数
    pub char_refs_written: usize,
}

/// 不可编码字符（保存前预检，F-02 §2.4 `fs_check_mappable`）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmappableChar {
    /// 字符在文本中的字节偏移（UTF-8 字节位置）
    pub position: usize,
    pub character: char,
}

/// 编码自动探测（F-02 §2.2）
///
/// 顺序：BOM → UTF-8 严格校验 → `chardetng` 统计探测。
/// 本产品定位中文文本编辑器：统计探测结果若为产品未支持的编码
/// （日/韩/俄文等），回落 GB18030（与 F-02 §2.2 检测顺序一致）。
pub fn detect(bytes: &[u8]) -> (Encoding, bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (Encoding::Utf8, true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return (Encoding::Utf16LE, true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return (Encoding::Utf16BE, true);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return (Encoding::Utf8, false);
    }

    // 统计探测（中文 TLD 无域名可用 → None；UTF-8 严格已失败故不再猜 UTF-8）
    //
    // **只喂前一段**：编码是整份文件的属性，采样一小段就足够判定；而
    // chardetng 的 n-gram 统计是 O(n) 且常数不小 —— 实测 4 MB 的 GBK 文件，
    // 光探测就要 1.1 秒，等于为「猜编码」白付了一遍全文扫描。
    //
    // 采样量不是越大越准（实测反直觉）：同一份 GBK 文件，采样 1KB 能猜对，
    // 喂到 8KB~256KB 反而被文中的 ASCII（数字、标点、换行）带偏成 latin1。
    // 所以这里取 1KB，并在下面对兜底答案回落全文。
    const DETECT_SAMPLE: usize = 1024;
    let sample = &bytes[..bytes.len().min(DETECT_SAMPLE)];
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, true);
    let mut guessed = detector.guess(None, false);
    // `windows-1252` 是 chardetng 的兜底答案（等于「没认出来」）。中文文本被猜
    // 成它，多半只是采样这段没抓到中文特征 —— 这不算数，拿全文再猜一次。
    if guessed.name() == "windows-1252" && bytes.len() > DETECT_SAMPLE {
        let mut d = chardetng::EncodingDetector::new();
        d.feed(bytes, true);
        guessed = d.guess(None, false);
    }
    let encoding = match guessed.name() {
        "GBK" => Encoding::Gbk,
        "gb18030" => Encoding::Gb18030,
        "Big5" => Encoding::Big5,
        "UTF-16LE" => Encoding::Utf16LE,
        "UTF-16BE" => Encoding::Utf16BE,
        "windows-1252" => Encoding::Latin1,
        _ => Encoding::Gb18030,
    };
    (encoding, false)
}

/// 解码（BOM 由调用方剥离后传入）
pub fn decode(bytes: &[u8], encoding: Encoding) -> String {
    match encoding.decoder() {
        Some(decoder) => {
            let (cow, _used_encoding, _had_errors) = decoder.decode(bytes);
            cow.into_owned()
        }
        // 只有 CP437 没有 encoding_rs 解码器
        None => cp437::decode(bytes),
    }
}

/// 编码（WHATWG 行为：不可编码字符产出数字字符引用 `&#xNNNN;`；
/// 返回字节串与「是否发生了不可编码替换」标记）
///
/// 注意：`encoding_rs` 的 UTF-16 系 encoder 不产出 UTF-16 字节（实测），
/// 故 UTF-16 LE/BE 在此手工转换；Rust `String` 不含孤立代理，恒无 errors。
pub fn encode(text: &str, encoding: Encoding) -> (Vec<u8>, bool) {
    match encoding {
        Encoding::Utf16LE | Encoding::Utf16BE => {
            let mut units: Vec<u16> = text.encode_utf16().collect();
            let mut bytes = Vec::with_capacity(units.len() * 2);
            if encoding == Encoding::Utf16LE {
                for u in units.drain(..) {
                    bytes.extend_from_slice(&u.to_le_bytes());
                }
            } else {
                for u in units.drain(..) {
                    bytes.extend_from_slice(&u.to_be_bytes());
                }
            }
            (bytes, false)
        }
        Encoding::Cp437 => cp437::encode(text),
        _ => {
            let decoder = encoding
                .decoder()
                .expect("除 CP437 外都有 encoding_rs 解码器");
            let (cow, _used_encoding, had_errors) = decoder.encode(text);
            (cow.into_owned(), had_errors)
        }
    }
}

/// 保存前预检：定位目标编码不可表示的字符（F-02 §2.4）
///
/// UTF-8 / UTF-16 可表示一切合法 Unicode 字符，恒为空表；
/// 其余编码仅在整体编码报告 `had_errors` 时逐字符精确定位，避免常态开销。
pub fn check_mappable(text: &str, encoding: Encoding) -> Vec<UnmappableChar> {
    if encoding.is_unicode() {
        return Vec::new();
    }
    let (_, had_errors) = encode(text, encoding);
    if !had_errors {
        return Vec::new();
    }
    text.char_indices()
        .filter(|&(_, ch)| encode(&ch.to_string(), encoding).1)
        .map(|(position, character)| UnmappableChar {
            position,
            character,
        })
        .collect()
}

/// 把不可编码字符替换为数字字符引用（`&#xNNNN;`，十六进制大写），
/// 返回替换后文本与替换个数（CharRef 策略的写出准备）
fn apply_char_refs(text: &str, encoding: Encoding) -> (String, usize) {
    let mut result = String::with_capacity(text.len());
    let mut count = 0;
    for ch in text.chars() {
        if !encoding.is_unicode() && encode(&ch.to_string(), encoding).1 {
            result.push_str(&format!("&#x{:X};", ch as u32));
            count += 1;
        } else {
            result.push(ch);
        }
    }
    (result, count)
}

/// 剥离 BOM，返回剩余字节切片
fn strip_bom(bytes: &[u8], encoding: Encoding) -> (&[u8], bool) {
    match encoding {
        Encoding::Utf8 if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) => (&bytes[3..], true),
        Encoding::Utf16LE if bytes.starts_with(&[0xFF, 0xFE]) => (&bytes[2..], true),
        Encoding::Utf16BE if bytes.starts_with(&[0xFE, 0xFF]) => (&bytes[2..], true),
        _ => (bytes, false),
    }
}

// ---------------------------------------------------------------------------
// CP437（NFO / DOS 码页）
// ---------------------------------------------------------------------------

/// `encoding_rs` 只实现 WHATWG 编码表，里面没有 CP437，故自带一张 256 项表：
/// `0x00..=0x7F` 与 ASCII 一一对应，`0x80..=0xFF` 查 [`HIGH`]。
///
/// 只用于「重新载入 / 打开时指定编码」——编码器把不可表示的字符写成 `?`
/// （`had_errors = true`，保存前的不可映射预检照样能拦下来）。
mod cp437 {
    use std::collections::HashMap;
    use std::sync::LazyLock;

    /// CP437 高半区（`0x80..=0xFF`）的 Unicode 字符
    const HIGH: [char; 128] = [
        'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ',
        'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú',
        'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡',
        '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟',
        '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘',
        '┌', '█', '▄', '▌', '▐', '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ',
        '∞', 'φ', 'ε', '∩', '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²',
        '■', '\u{00A0}',
    ];

    /// 字符 → 字节（懒构建，避免每字符线性扫表）
    fn reverse() -> &'static HashMap<char, u8> {
        static MAP: LazyLock<HashMap<char, u8>> = LazyLock::new(|| {
            HIGH.iter()
                .enumerate()
                .map(|(index, &ch)| (ch, index as u8 + 0x80))
                .collect()
        });
        &MAP
    }

    pub(super) fn decode(bytes: &[u8]) -> String {
        bytes
            .iter()
            .map(|&byte| {
                if byte < 0x80 {
                    byte as char
                } else {
                    HIGH[(byte - 0x80) as usize]
                }
            })
            .collect()
    }

    pub(super) fn encode(text: &str) -> (Vec<u8>, bool) {
        let mut out = Vec::with_capacity(text.len());
        let mut had_errors = false;
        for ch in text.chars() {
            let code = ch as u32;
            if code < 0x80 {
                out.push(code as u8);
                continue;
            }
            match reverse().get(&ch) {
                Some(&byte) => out.push(byte),
                None => {
                    out.push(b'?');
                    had_errors = true;
                }
            }
        }
        (out, had_errors)
    }
}

/// 行尾风格统计（以出现次数最多者为准）
///
/// 原先是三趟 `matches()`（CRLF / CR / LF 各扫一遍全文）；合成一趟 ——
/// 大文件上这是「三次全量扫描」与「一次」的区别。
fn detect_line_ending(text: &str) -> LineEnding {
    let bytes = text.as_bytes();
    // 快速路径：绝大多数文件行尾**统一**，碰到第一个行尾就能定风格，直接返回。
    // 原先为了统计「多数派」必须扫完整篇；大文件上这一趟并不便宜。
    // 只有真的出现了另一种行尾（混用）时才退回全量统计 —— 那时才需要多数派。
    let mut i = 0;
    let mut first: Option<LineEnding> = None;
    while i < bytes.len() {
        let hit = match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => Some(LineEnding::CrLf),
            b'\r' => Some(LineEnding::Cr),
            b'\n' => Some(LineEnding::Lf),
            _ => None,
        };
        match hit {
            None => i += 1,
            Some(style) => {
                match first {
                    None => first = Some(style),
                    Some(prev) if prev == style => {}
                    Some(_) => return majority_line_ending(bytes), // 混用 → 全量统计
                }
                i += if style == LineEnding::CrLf { 2 } else { 1 };
            }
        }
    }
    first.unwrap_or(LineEnding::Lf) // 无换行按 LF
}

/// 行尾风格的多数派统计（**只有**检测到混用行尾时才需要走这条路）
fn majority_line_ending(bytes: &[u8]) -> LineEnding {
    let (mut crlf, mut cr_only, mut lf_only) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                crlf += 1;
                i += 2;
            }
            b'\r' => {
                cr_only += 1;
                i += 1;
            }
            b'\n' => {
                lf_only += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }

    match (crlf, cr_only, lf_only) {
        (0, 0, 0) => LineEnding::Lf,
        (0, 0, _) => LineEnding::Lf,
        (0, _, 0) => LineEnding::Cr,
        (_, 0, 0) => LineEnding::CrLf,
        // 混合行尾按多数派
        (a, b, c) if a >= b && a >= c => LineEnding::CrLf,
        (a, b, c) if b > a && b >= c => LineEnding::Cr,
        _ => LineEnding::Lf,
    }
}

/// 行尾归一为 LF（编辑器内部统一表示），**原地**改
///
/// 原先是 `text.replace("\r\n", "\n").replace('\r', "\n")`：两次 replace 会产生
/// 两份中间 String，各是一次全量拷贝；而绝大多数文件本来就是 LF，那两份拷贝
/// 完全是白做的。现在没有 CR 时一个字节都不动。
fn normalize_lf(text: &mut String) {
    if !text.as_bytes().contains(&b'\r') {
        return;
    }
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            out.push(b'\n');
            i += if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                2
            } else {
                1
            };
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    // 输入是合法 UTF-8，而 `\r` / `\n` 都是 ASCII，不会切坏任何多字节序列
    if let Ok(normalized) = String::from_utf8(out) {
        *text = normalized;
    }
}

/// 按目标行尾风格展开（输入为已归一 LF 的文本）
fn apply_line_ending(text: &str, line_ending: LineEnding) -> String {
    match line_ending {
        LineEnding::Lf => text.to_owned(),
        LineEnding::Cr => text.replace('\n', "\r"),
        LineEnding::CrLf => text.replace('\n', "\r\n"),
    }
}

/// BOM 前缀字节
fn bom_prefix(encoding: Encoding) -> &'static [u8] {
    match encoding {
        Encoding::Utf8 => &[0xEF, 0xBB, 0xBF],
        Encoding::Utf16LE => &[0xFF, 0xFE],
        Encoding::Utf16BE => &[0xFE, 0xFF],
        // 其它编码无 BOM 惯例
        _ => &[],
    }
}

/// 读取并解码文件（自动探测编码，F-02 §2.4 `fs_read`）
pub fn read_file(path: &str) -> AppResult<LoadResult> {
    let mut bytes = std::fs::read(path)?;
    let (encoding, had_bom) = detect(&bytes);
    // UTF-8 是最常见的一档，而 `decode` 会**再分配一份** String；这里直接把
    // 字节块转成 String —— 50 MB 的文件上，省掉的就是一次全量分配与拷贝。
    // （`detect` 已做过严格校验，正常走不到 Err 那一支）
    let mut text = if encoding == Encoding::Utf8 {
        bytes.drain(
            ..if had_bom {
                bom_prefix(encoding).len()
            } else {
                0
            },
        );
        match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(e) => decode(e.as_bytes(), encoding),
        }
    } else {
        let (body, _) = strip_bom(&bytes, encoding);
        decode(body, encoding)
    };
    let line_ending = detect_line_ending(&text);
    normalize_lf(&mut text);

    // 逐文件日志，降到 DEBUG：批处理上千文件时 INFO 会刷屏并拖慢（见
    // `lib.rs` 的日志初始化注释）。需要时 `RUST_LOG=debug` 打开。
    tracing::debug!(
        path,
        encoding = encoding.label(),
        bom = had_bom,
        "文件读取完成"
    );

    Ok(LoadResult {
        text,
        encoding,
        had_bom,
        line_ending,
    })
}

/// 按手选编码重新读取（「重新载入」，F-02 §2.2 手选编码）
pub fn read_file_with(path: &str, encoding: Encoding) -> AppResult<LoadResult> {
    let mut bytes = std::fs::read(path)?;
    let had_bom = strip_bom(&bytes, encoding).1;
    let mut text = if encoding == Encoding::Utf8 {
        bytes.drain(
            ..if had_bom {
                bom_prefix(encoding).len()
            } else {
                0
            },
        );
        match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(e) => decode(e.as_bytes(), encoding),
        }
    } else {
        decode(strip_bom(&bytes, encoding).0, encoding)
    };
    let line_ending = detect_line_ending(&text);
    normalize_lf(&mut text);

    tracing::info!(
        path,
        encoding = encoding.label(),
        bom = had_bom,
        "文件按指定编码重新读取"
    );

    Ok(LoadResult {
        text,
        encoding,
        had_bom,
        line_ending,
    })
}

/// 编码写出文件（F-02 §2.4 `fs_write`）
///
/// - `UnmappablePolicy::Ask` 且存在不可编码字符 → 返回错误，由前端预检弹窗决策
/// - `UnmappablePolicy::CharRef` → 不可编码字符按 `&#xNNNN;` 写出并计数
/// - `UnmappablePolicy::ToUtf8` → 无视请求编码直接写 UTF-8
pub fn write_file(path: &str, text: &str, opts: SaveOptions) -> AppResult<SaveReport> {
    let mut actual_encoding = opts.encoding;
    let mut char_refs_written = 0usize;

    let payload = if actual_encoding.is_unicode() {
        text.to_owned()
    } else {
        let unmappable = check_mappable(text, actual_encoding);
        match opts.unmappable {
            UnmappablePolicy::Ask if !unmappable.is_empty() => {
                return Err(crate::error::AppError::Unmappable {
                    encoding: actual_encoding.label().to_owned(),
                    count: unmappable.len(),
                });
            }
            UnmappablePolicy::CharRef => {
                let (replaced, count) = apply_char_refs(text, actual_encoding);
                char_refs_written = count;
                replaced
            }
            UnmappablePolicy::ToUtf8 => {
                actual_encoding = Encoding::Utf8;
                text.to_owned()
            }
            _ => text.to_owned(),
        }
    };

    let body = apply_line_ending(&payload, opts.line_ending);
    let (mut bytes, _had_errors) = encode(&body, actual_encoding);
    if opts.add_bom {
        let bom = bom_prefix(actual_encoding);
        let mut with_bom = Vec::with_capacity(bom.len() + bytes.len());
        with_bom.extend_from_slice(bom);
        with_bom.append(&mut bytes);
        bytes = with_bom;
    }

    let bytes_written = bytes.len() as u64;
    std::fs::write(path, bytes)?;

    // 同上：逐文件日志降到 DEBUG
    tracing::debug!(
        path,
        encoding = actual_encoding.label(),
        bytes = bytes_written,
        char_refs = char_refs_written,
        "文件写出完成"
    );

    Ok(SaveReport {
        written_path: path.to_owned(),
        bytes_written,
        actual_encoding,
        char_refs_written,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_eq!(detect(&bytes), (Encoding::Utf8, true));
    }

    #[test]
    fn detect_utf8_plain() {
        assert_eq!(detect("中文".as_bytes()), (Encoding::Utf8, false));
    }

    #[test]
    fn detect_utf16le_bom() {
        let bytes = [0xFF, 0xFE, 0x2D, 0x4E];
        assert_eq!(detect(&bytes), (Encoding::Utf16LE, true));
    }

    #[test]
    fn detect_gbk_by_chardetng() {
        // 「中文编码测试」的 GBK 字节——非合法 UTF-8，统计探测应判 GBK
        let bytes = [
            0xD6, 0xD0, 0xCE, 0xC4, 0xB1, 0xE0, 0xC2, 0xEB, 0xB2, 0xE2, 0xCA, 0xD4,
        ];
        let (enc, bom) = detect(&bytes);
        assert!(!bom);
        assert!(matches!(enc, Encoding::Gbk | Encoding::Gb18030));
        assert_eq!(decode(&bytes, Encoding::Gbk), "中文编码测试");
    }

    #[test]
    fn detect_big5_by_chardetng() {
        // 用 Big5 编码器生成「中文編碼測試」的字节（先确认全部可编码），
        // 再喂给探测器：非合法 UTF-8，统计探测不应判回 UTF-8
        let (bytes, had_errors) = encode("中文編碼測試", Encoding::Big5);
        assert!(!had_errors);
        assert!(std::str::from_utf8(&bytes).is_err());
        let (enc, bom) = detect(&bytes);
        assert!(!bom);
        assert_eq!(enc, Encoding::Big5);
        assert_eq!(decode(&bytes, Encoding::Big5), "中文編碼測試");
    }

    #[test]
    fn detect_utf16be_bom() {
        let bytes = [0xFE, 0xFF, 0x4E, 0x2D];
        assert_eq!(detect(&bytes), (Encoding::Utf16BE, true));
        assert_eq!(decode(&bytes[2..], Encoding::Utf16BE), "中");
    }

    #[test]
    fn decode_big5() {
        let bytes = [0xA4, 0xA4];
        assert_eq!(decode(&bytes, Encoding::Big5), "中");
    }

    #[test]
    fn line_ending_crlf() {
        assert_eq!(detect_line_ending("a\r\nb\r\nc"), LineEnding::CrLf);
        assert_eq!(detect_line_ending("a\r\nb\nc"), LineEnding::CrLf);
        assert_eq!(detect_line_ending("a\nb\nc"), LineEnding::Lf);
        assert_eq!(detect_line_ending("a\rb\rc"), LineEnding::Cr);
        assert_eq!(detect_line_ending("no newline"), LineEnding::Lf);
    }

    #[test]
    fn encoding_labels() {
        assert_eq!(Encoding::Gb2312.label(), "gb2312");
        assert_eq!(Encoding::Latin1.label(), "iso-8859-1");
    }

    #[test]
    fn serde_uses_label_and_accepts_legacy_names() {
        // 前端 ENCODING_OPTIONS 用的就是 label() 这一套；fs_write 的 opts 走 serde，
        // 必须互通，否则保存会报 unknown variant 'utf-8'
        for enc in [
            Encoding::Utf8,
            Encoding::Utf16LE,
            Encoding::Utf16BE,
            Encoding::Gb2312,
            Encoding::Gbk,
            Encoding::Gb18030,
            Encoding::Big5,
            Encoding::Latin1,
            Encoding::Cp437,
        ] {
            let json = serde_json::to_string(&enc).unwrap();
            assert_eq!(json, format!("\"{}\"", enc.label()));
            let back: Encoding = serde_json::from_str(&json).unwrap();
            assert_eq!(back, enc);
        }
        // 旧名（rename_all 时代）仍可反序列化，旧会话文件不至于打不开
        assert_eq!(
            serde_json::from_str::<Encoding>("\"utf8\"").unwrap(),
            Encoding::Utf8
        );
        assert_eq!(
            serde_json::from_str::<Encoding>("\"latin1\"").unwrap(),
            Encoding::Latin1
        );
        assert_eq!(
            serde_json::from_str::<Encoding>("\"nfo\"").unwrap(),
            Encoding::Cp437
        );
    }

    #[test]
    fn save_options_deserialize_frontend_json() {
        // 前端 `fsWrite` 发的就是这个形状；截图里的报错正是这条路径：
        // `invalid args 'opts' for command 'fs_write': unknown variant 'utf-8'`
        let opts: SaveOptions = serde_json::from_value(serde_json::json!({
            "encoding": "utf-8",
            "addBom": false,
            "lineEnding": "lf",
            "unmappable": "ask"
        }))
        .expect("前端保存参数应可反序列化");
        assert_eq!(opts.encoding, Encoding::Utf8);
        assert_eq!(opts.line_ending, LineEnding::Lf);
        assert_eq!(opts.unmappable, UnmappablePolicy::Ask);

        // 非 UTF-8 的目标编码同样走这条路（编码转换）
        let big5: SaveOptions = serde_json::from_value(serde_json::json!({
            "encoding": "big5",
            "addBom": false,
            "lineEnding": "crlf",
            "unmappable": "charref"
        }))
        .expect("BIG5 保存参数应可反序列化");
        assert_eq!(big5.encoding, Encoding::Big5);
        assert_eq!(big5.line_ending, LineEnding::CrLf);
    }

    #[test]
    fn cp437_decode_and_encode() {
        // 0xB0 0xB1 0xB2 = ░▒▓（NFO 里最常见的方块字符）
        assert_eq!(decode(&[0xB0, 0xB1, 0xB2], Encoding::Cp437), "░▒▓");
        assert_eq!(encode("░▒▓", Encoding::Cp437).0, vec![0xB0, 0xB1, 0xB2]);
        // 中文字符 CP437 表示不了 → '?'，并报告 had_errors 让预检能拦
        let (bytes, had_errors) = encode("中", Encoding::Cp437);
        assert_eq!(bytes, vec![b'?']);
        assert!(had_errors);
        assert_eq!(check_mappable("中", Encoding::Cp437).len(), 1);
    }

    #[test]
    fn encoding_from_label_aliases() {
        assert_eq!(Encoding::from_label("UTF-8"), Some(Encoding::Utf8));
        assert_eq!(Encoding::from_label("gb_2312"), Some(Encoding::Gb2312));
        assert_eq!(Encoding::from_label("CP950"), Some(Encoding::Big5));
        assert_eq!(Encoding::from_label("windows-1252"), Some(Encoding::Latin1));
        assert_eq!(Encoding::from_label("nope"), None);
        assert_eq!(LineEnding::from_label("CRLF"), Some(LineEnding::CrLf));
    }

    #[test]
    fn encode_roundtrip_gbk() {
        let text = "中文abc";
        let (bytes, had_errors) = encode(text, Encoding::Gbk);
        assert!(!had_errors);
        assert_eq!(decode(&bytes, Encoding::Gbk), text);
    }

    #[test]
    fn encode_roundtrip_utf16le() {
        let text = "中文abc";
        let (bytes, had_errors) = encode(text, Encoding::Utf16LE);
        assert!(!had_errors);
        assert_eq!(decode(&bytes, Encoding::Utf16LE), text);
    }

    #[test]
    fn encode_utf8_bom_prefix() {
        assert_eq!(bom_prefix(Encoding::Utf8), &[0xEF, 0xBB, 0xBF]);
        assert_eq!(bom_prefix(Encoding::Utf16LE), &[0xFF, 0xFE]);
        assert_eq!(bom_prefix(Encoding::Utf16BE), &[0xFE, 0xFF]);
        assert!(bom_prefix(Encoding::Big5).is_empty());
    }

    #[test]
    fn check_mappable_unicode_always_empty() {
        let text = "𩅯𪚥 áé 中";
        assert!(check_mappable(text, Encoding::Utf8).is_empty());
        assert!(check_mappable(text, Encoding::Utf16LE).is_empty());
    }

    #[test]
    fn check_mappable_big5_unmappable() {
        // 「发」不在 Big5 常用字表中；「中」在
        let text = "中发";
        let unmappable = check_mappable(text, Encoding::Big5);
        assert_eq!(unmappable.len(), 1);
        assert_eq!(unmappable[0].character, '发');
        // position 为字节偏移：「中」占 3 字节
        assert_eq!(unmappable[0].position, 3);
    }

    #[test]
    fn check_mappable_gbk_tofu() {
        // U+1FA6C（符号类）不在 GBK；汉字「中」在
        let text = "中\u{1FA6C}";
        assert_eq!(check_mappable(text, Encoding::Gbk).len(), 1);
        assert!(check_mappable("中", Encoding::Gbk).is_empty());
    }

    #[test]
    fn apply_char_refs_replaces_and_counts() {
        let (replaced, count) = apply_char_refs("中发", Encoding::Big5);
        assert_eq!(replaced, "中&#x53D1;");
        assert_eq!(count, 1);
    }

    #[test]
    fn normalize_lf_all_styles() {
        let mut mixed = "a\r\nb\rc\nd".to_owned();
        normalize_lf(&mut mixed);
        assert_eq!(mixed, "a\nb\nc\nd");
        // 本来就是 LF：一个字节都不该动（也不该重新分配）
        let mut lf = "a\nb".to_owned();
        normalize_lf(&mut lf);
        assert_eq!(lf, "a\nb");
    }

    #[test]
    fn apply_line_ending_expansion() {
        assert_eq!(apply_line_ending("a\nb", LineEnding::Lf), "a\nb");
        assert_eq!(apply_line_ending("a\nb", LineEnding::Cr), "a\rb");
        assert_eq!(apply_line_ending("a\nb", LineEnding::CrLf), "a\r\nb");
    }

    #[test]
    fn write_and_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("aio-enc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // GBK 回环
        let gbk_path = dir.join("t-gbk.txt");
        let opts = SaveOptions {
            encoding: Encoding::Gbk,
            add_bom: false,
            line_ending: LineEnding::Lf,
            unmappable: UnmappablePolicy::CharRef,
        };
        let report = write_file(gbk_path.to_str().unwrap(), "中文测试\n", opts).unwrap();
        assert_eq!(report.actual_encoding, Encoding::Gbk);
        assert_eq!(report.char_refs_written, 0);
        let loaded = read_file(gbk_path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.text, "中文测试\n");
        assert_eq!(loaded.encoding, Encoding::Gbk);

        // UTF-8 BOM 回环 + CRLF 保持
        let utf8_path = dir.join("t-utf8bom.txt");
        let opts = SaveOptions {
            encoding: Encoding::Utf8,
            add_bom: true,
            line_ending: LineEnding::CrLf,
            unmappable: UnmappablePolicy::CharRef,
        };
        write_file(utf8_path.to_str().unwrap(), "甲\n乙\n", opts).unwrap();
        let bytes = std::fs::read(&utf8_path).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert!(bytes.ends_with(b"\r\n"));
        let loaded = read_file(utf8_path.to_str().unwrap()).unwrap();
        assert!(loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::CrLf);
        assert_eq!(loaded.text, "甲\n乙\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_ask_policy_errors_on_unmappable() {
        let dir = std::env::temp_dir().join(format!("aio-enc-ask-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t-ask.txt");
        let opts = SaveOptions {
            encoding: Encoding::Big5,
            add_bom: false,
            line_ending: LineEnding::Lf,
            unmappable: UnmappablePolicy::Ask,
        };
        let err = write_file(path.to_str().unwrap(), "简体字发", opts).unwrap_err();
        assert!(matches!(err, crate::error::AppError::Unmappable { .. }));

        // 无不可编码字符时 Ask 语义等同直接写出
        let opts_ok = SaveOptions {
            encoding: Encoding::Big5,
            add_bom: false,
            line_ending: LineEnding::Lf,
            unmappable: UnmappablePolicy::Ask,
        };
        let report = write_file(path.to_str().unwrap(), "繁體字", opts_ok).unwrap();
        assert_eq!(report.actual_encoding, Encoding::Big5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_char_ref_policy_writes_references() {
        let dir = std::env::temp_dir().join(format!("aio-enc-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t-ref.txt");
        let opts = SaveOptions {
            encoding: Encoding::Big5,
            add_bom: false,
            line_ending: LineEnding::Lf,
            unmappable: UnmappablePolicy::CharRef,
        };
        let report = write_file(path.to_str().unwrap(), "头发", opts).unwrap();
        // 「头」(U+5934) 与「发」(U+53D1) 均为简体字，Big5 不可编码 → 各写一处引用
        assert_eq!(report.char_refs_written, 2);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(decode(&bytes, Encoding::Big5), "&#x5934;&#x53D1;");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_toutf8_policy_falls_back() {
        let dir = std::env::temp_dir().join(format!("aio-enc-u8-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t-u8.txt");
        let opts = SaveOptions {
            encoding: Encoding::Big5,
            add_bom: false,
            line_ending: LineEnding::Lf,
            unmappable: UnmappablePolicy::ToUtf8,
        };
        let report = write_file(path.to_str().unwrap(), "头发", opts).unwrap();
        assert_eq!(report.actual_encoding, Encoding::Utf8);
        let loaded = read_file(path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.text, "头发");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
