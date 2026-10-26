//! F-11 偏好设置核心（第八阶段）
//!
//! 纯 Rust：类型 + 默认值 + 校验 + 落盘，不依赖 Tauri，可独立单测。
//!
//! ## 三条设计原则
//!
//! 1. **永不因为设置文件坏掉而启动失败**。读取顺序：严格解析 → 失败则「逐字段尽力
//!    恢复」（类型不符的字段回落到默认值，其余字段保留）→ 仍失败则整体默认值；
//!    同时把坏文件留一份 `.bad` 备份。用户手改 `settings.json` 写错一个字段，
//!    不会把主题、字号、整套快捷键一起重置。
//! 2. **写盘原子化**：先写同目录临时文件再 `rename` 覆盖，避免写到一半断电留下
//!    半截 JSON（下次启动就变成「坏文件」）。
//! 3. **范围钳制在服务端**：`fontSize` 12–32、`tabWidth` 1–16、`fontFamily` 空白
//!    回落默认（规格 §五 / UI §六）。[`save`] 返回**实际落盘的值**，前端据此同步，
//!    避免前后端各钳一次、结果不一致。
//!
//! ## 快捷键的三态约定
//!
//! `shortcuts` 是 `键位 → 命令 ID` 的**覆盖表**，不是全量快照：
//!
//! | 值 | 含义 |
//! |----|------|
//! | 键不存在 | 用前端命令注册表里的默认键位 |
//! | `""`（空串） | 用户**显式解绑**该命令 |
//! | 非空 | 用户自定义覆盖 |
//!
//! 于是「恢复默认」只需删掉键，而不必把默认表复制一份到后端——默认键位只有
//! 一份事实来源（前端 `shared/shortcuts.ts`），不会两处漂移。
//! 键位的规范化（大小写、修饰键顺序）也归前端做，后端只 trim + 丢掉空键，
//! 避免同一套规则在两门语言里各写一遍。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::compare::CompareOptions;
use crate::core::encoding::{EncodingOrAuto, LineEnding};
use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// 钳制范围与默认值（规格 §五 / UI §六 的硬性区间）
// ---------------------------------------------------------------------------

/// 字号下限（UI §五「字号 12 – 32 可调」）
pub const FONT_SIZE_MIN: u32 = 12;
/// 字号上限
pub const FONT_SIZE_MAX: u32 = 32;
/// 缩进宽度下限
pub const TAB_WIDTH_MIN: u32 = 1;
/// 缩进宽度上限
pub const TAB_WIDTH_MAX: u32 = 16;
/// 默认正文字体（UI §六）
pub const DEFAULT_FONT_FAMILY: &str = "'Source Han Serif SC', 'Songti SC', '宋体', serif";
/// 设置文件名（`<app_data>/settings.json`）
pub const SETTINGS_FILE: &str = "settings.json";

// ---------------------------------------------------------------------------
// 类型（与 F-11 §11.1 的 `Settings` 同形）
// ---------------------------------------------------------------------------

/// 主题（跟随系统 / 浅 / 深）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    /// JSON / UI 取值
    pub fn label(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    /// 宽松解析（未知取值返回 `None`，调用方回落默认）
    pub fn from_label(label: &str) -> Option<Theme> {
        match label.trim().to_ascii_lowercase().as_str() {
            "system" => Some(Theme::System),
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }

    /// 循环切换（「视图 → 主题」用：跟随系统 → 浅 → 深 → 跟随系统）
    pub fn next(self) -> Theme {
        match self {
            Theme::System => Theme::Light,
            Theme::Light => Theme::Dark,
            Theme::Dark => Theme::System,
        }
    }
}

/// 外观
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "这些字段是彼此正交的独立开关（不是互斥的模式选择），且经 serde 具名序列化给前端，不存在位置难辨的问题"
)]
pub struct Appearance {
    /// 正文字体族（CSS `font-family` 值）
    pub font_family: String,
    /// 正文字号（px，钳制 12–32）
    pub font_size: u32,
    /// 编辑器显示行号
    pub show_line_number: bool,
    /// 显示工具栏
    pub show_toolbar: bool,
    /// 显示状态栏
    pub show_status_bar: bool,
    /// 显示不可见字符：空格（`·`）与制表符（`→`）
    pub show_spaces: bool,
    /// 显示行尾符（`¬`）
    pub show_line_ends: bool,
    /// 显示换段符（`¶`，只在段落的最后一行显示；开了它时该位置优先画 `¶` 而非行尾符）
    pub show_paragraph_marks: bool,
    /// 主题
    pub theme: Theme,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            font_family: DEFAULT_FONT_FAMILY.to_owned(),
            font_size: 14,
            show_line_number: true,
            show_toolbar: true,
            show_status_bar: true,
            // 需求（v0.6 #2）：不可见字符三开关默认**勾选**
            show_spaces: true,
            show_line_ends: true,
            show_paragraph_marks: true,
            theme: Theme::System,
        }
    }
}

/// 编辑器
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorPrefs {
    /// 一个 Tab 等于多少个空格（钳制 1–16）
    pub tab_width: u32,
    /// 按 Tab 插入空格（否则插入制表符）
    pub insert_spaces: bool,
    /// 自动换行
    pub wrap: bool,
    /// 新建 / 无 BOM 时的默认编码（`"auto"` = 探测）
    pub default_encoding: EncodingOrAuto,
    /// 新建文件的默认行尾
    pub default_line_ending: LineEnding,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            tab_width: 4,
            insert_spaces: true,
            wrap: false,
            default_encoding: EncodingOrAuto::Auto,
            default_line_ending: LineEnding::Lf,
        }
    }
}

/// 转换（简繁 / 括号）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConversionPrefs {
    /// 「匹配括号 / 括号嵌套转换」要跳过的括号对（规格 §11.1 例 `"[]"`）
    pub bracket_skip: String,
    /// 转换后保留原文以便对照（UI 层的默认勾选状态）
    pub preserve_converted: bool,
}

impl Default for ConversionPrefs {
    fn default() -> Self {
        Self {
            bracket_skip: "[]".to_owned(),
            preserve_converted: false,
        }
    }
}

/// 全部设置
///
/// `compare` 直接复用 F-06 的 [`CompareOptions`]（比较对话框的入参就是这个类型），
/// 于是「设默认值」与「对话框初值」天然同一份结构。**与 §11.1 的命名偏差**：
/// 规格里该字段叫 `defaultStrictness`，这里随 F-06 的既有契约用
/// `variantStrictness`——两处同名比多一个冗余类型更不容易出错。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub appearance: Appearance,
    pub editor: EditorPrefs,
    pub conversion: ConversionPrefs,
    pub compare: CompareOptions,
    /// 快捷键覆盖表（见模块头注释的「三态约定」）
    pub shortcuts: BTreeMap<String, String>,
    /// 关闭主窗口时**隐藏**而不是退出进程。
    ///
    /// 开启后进程常驻，再次启动走单实例的「聚焦已有窗口」，省掉重建 WebView2
    /// 的那几百毫秒（实测二次启动 748ms → 66~127ms）。
    ///
    /// 默认关闭：保持「关闭即退出」的既有行为，也就不必常驻那几百 MB 内存；
    /// 想要这个提速的用户自己在设置里打开。开启后由 `tray` 模块提供唤回与
    /// 真正退出的入口——没有那个入口，隐藏就等于把窗口弄丢了。
    pub hide_on_close: bool,
    /// 界面语言（PRD §3.6）。繁體文案不是人工翻译的，是本进程用 OpenCC
    /// `s2twp` 对简体文案现转的，所以这里只存「要不要转」。
    pub language: UiLang,
}

/// 界面语言（PRD §3.6）
///
/// 只有两种：简体（默认）与繁體。**不做英文界面**——专业术语翻译质量不可控，
/// 且英文译文普遍长于中文会撑破现有按钮与菜单布局（PRD §3.6 开头有完整理由）。
///
/// `Unknown` 是反序列化兜底：老版本 / 手改过的 `settings.json` 里若出现别的
/// 值，**不能让整个文件解析失败**（那会连累字体、快捷键等全部回到默认），
/// 而是落到这里、由 [`sanitize`] 修回 `Zh`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum UiLang {
    /// 简体中文（默认）
    #[default]
    #[serde(rename = "zh")]
    Zh,
    /// 繁體中文（`s2twp`，含台湾惯用词）
    #[serde(rename = "zh-Hant")]
    ZhHant,
    /// 未识别的值：解析不报错，交给 `sanitize` 纠正
    #[serde(other)]
    Unknown,
}

impl UiLang {
    /// 是否要输出繁體
    pub fn is_traditional(self) -> bool {
        matches!(self, UiLang::ZhHant)
    }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/// 把越界 / 空白值修成合法值（幂等）
pub fn sanitize(mut s: Settings) -> Settings {
    let a = &mut s.appearance;
    a.font_size = a.font_size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
    let family = a.font_family.trim();
    a.font_family = if family.is_empty() {
        DEFAULT_FONT_FAMILY.to_owned()
    } else {
        family.to_owned()
    };
    s.editor.tab_width = s.editor.tab_width.clamp(TAB_WIDTH_MIN, TAB_WIDTH_MAX);
    // 未识别的语言值退回简体，而不是让整份设置失效
    if s.language == UiLang::Unknown {
        s.language = UiLang::Zh;
    }
    s.shortcuts = clean_shortcuts(std::mem::take(&mut s.shortcuts));
    s
}

/// 去掉空键 / 修剪两端空白；**保留空值**（空值 = 显式解绑，见模块头注释）
fn clean_shortcuts(map: BTreeMap<String, String>) -> BTreeMap<String, String> {
    map.into_iter()
        .filter_map(|(k, v)| {
            let key = k.trim().to_owned();
            if key.is_empty() {
                None
            } else {
                Some((key, v.trim().to_owned()))
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 路径与读写
// ---------------------------------------------------------------------------

/// 设置文件路径：`<app_data>/settings.json`
pub fn settings_path() -> AppResult<PathBuf> {
    let base = crate::core::paths::app_data_dir()
        .ok_or_else(|| AppError::Settings("无法定位用户数据目录".into()))?;
    Ok(base.join(SETTINGS_FILE))
}

/// 进程内缓存（PRD §3.7 P-2）
///
/// 启动路径上 `settings.json` 会被读好几次——托盘建菜单时取语言、后端文案取语言、
/// `settings_get` 给前端、关闭窗口时再读一次——内容完全一样，却每次都走一遍磁盘。
/// 缓存起来让启动只读一次。
///
/// 之所以用 `Mutex<Option<..>>` 而不是 `OnceLock<Settings>`：`save` 之后缓存必须能
/// 更新，而 `OnceLock` 只能写一次。
static CACHE: OnceLock<Mutex<Option<Settings>>> = OnceLock::new();

fn cache_slot() -> &'static Mutex<Option<Settings>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

fn lock_cache() -> MutexGuard<'static, Option<Settings>> {
    cache_slot()
        .lock()
        .expect("缓存只在 clone / 赋值的瞬间持锁，中间不会 panic")
}

/// 读取设置（**永不失败**）：见模块头注释的「三条设计原则」第 1 条
///
/// 结果在进程内缓存，故磁盘只读一次（PRD §3.7 P-2）。要强制读盘请用 [`load_from`]。
pub fn load() -> Settings {
    let mut guard = lock_cache();
    if let Some(cached) = guard.as_ref() {
        return cached.clone();
    }
    let fresh = settings_path().map(|p| load_from(&p)).unwrap_or_default();
    *guard = Some(fresh.clone());
    fresh
}

/// 写入设置；返回**实际落盘**的值（已钳制 / 清洗）
pub fn save(settings: &Settings) -> AppResult<Settings> {
    let written = save_to(&settings_path()?, settings)?;
    // 缓存跟着更新，否则「改完设置立刻读」会拿到旧值
    *lock_cache() = Some(written.clone());
    Ok(written)
}

/// 恢复默认：删掉设置文件，返回默认值
///
/// 顺带清掉可能残留的 `.bad`（坏文件备份）与 `.tmp`（原子写的中间文件），
/// 否则「恢复默认」之后旧备份还躺在用户目录里，容易被误当成有效配置。
pub fn reset() -> AppResult<Settings> {
    let defaulted = reset_at(&settings_path()?);
    *lock_cache() = None;
    defaulted
}

/// 从指定路径恢复默认（测试入口）
pub fn reset_at(path: &Path) -> AppResult<Settings> {
    for p in [
        path.to_path_buf(),
        path.with_extension("json.bad"),
        path.with_extension("json.tmp"),
    ] {
        match fs::remove_file(&p) {
            Ok(()) => tracing::info!(path = %p.display(), "已删除设置文件"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Settings(format!("删除失败：{e}"))),
        }
    }
    Ok(Settings::default())
}

/// 从指定文件读取（测试入口）
///
/// **不走缓存**——测试要的就是「真的从这块磁盘内容解析出什么」；若走缓存，
/// 前一个用例写的值会串到后一个用例里。生产路径请用 [`load`]。
pub fn load_from(path: &Path) -> Settings {
    let Ok(raw) = fs::read_to_string(path) else {
        // 文件不存在 / 不可读 → 默认值（首次启动的正常路径，不打日志）
        return Settings::default();
    };

    // 快路径：严格解析
    if let Ok(s) = serde_json::from_str::<Settings>(&raw) {
        return sanitize(s);
    }

    tracing::warn!(path = %path.display(), "设置文件解析失败，尝试逐字段恢复");

    // 慢路径：逐小节 / 逐字段尽力恢复，坏字段回落默认、好字段全部保留
    let Ok(incoming) = serde_json::from_str::<Value>(&raw) else {
        return backup_and_default(path, "不是合法 JSON");
    };
    let recovered = Settings {
        appearance: recover_section::<Appearance>(incoming.get("appearance")),
        editor: recover_section::<EditorPrefs>(incoming.get("editor")),
        conversion: recover_section::<ConversionPrefs>(incoming.get("conversion")),
        compare: recover_section::<CompareOptions>(incoming.get("compare")),
        shortcuts: recover_shortcuts(incoming.get("shortcuts")),
        // 布尔量没有「越界」一说：不是布尔就回落默认（= 关闭，保持既有的退出行为）
        hide_on_close: incoming
            .get("hideOnClose")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or_default(),
        // 语言同理：认不出的值由 sanitize 兜回简体，不必在这里重复判断
        language: incoming
            .get("language")
            .and_then(|v| serde_json::from_value::<UiLang>(v.clone()).ok())
            .unwrap_or_default(),
    };
    tracing::warn!(
        path = %path.display(),
        "设置文件已逐字段恢复（坏字段回落默认，原文件另存为 .bad）"
    );
    backup(path);
    sanitize(recovered)
}

/// 写到指定文件（测试入口）；返回实际落盘的值
pub fn save_to(path: &Path, settings: &Settings) -> AppResult<Settings> {
    let clean = sanitize(settings.clone());
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(&clean)
        .map_err(|e| AppError::Settings(format!("设置序列化失败：{e}")))?;
    // 原子写：临时文件 + rename（Windows 上 `fs::rename` 也会覆盖已存在文件）
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes())?;
    fs::rename(&tmp, path)?;
    tracing::info!(path = %path.display(), "设置已保存");
    Ok(clean)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 把坏文件另存为 `<name>.bad`（保留现场供排查），返回默认值
fn backup_and_default(path: &Path, reason: &str) -> Settings {
    tracing::warn!(path = %path.display(), reason, "设置文件无法恢复，回落到默认值");
    backup(path);
    Settings::default()
}

fn backup(path: &Path) {
    let bad = path.with_extension("json.bad");
    if let Err(e) = fs::copy(path, &bad) {
        tracing::debug!(error = %e, "设置备份失败（忽略）");
    }
}

/// 逐字段「尽力恢复」一个小节：以该小节的默认值为模板，**逐个字段实测**
///
/// 判据不是「JSON 类型是否相符」——那太弱：`"theme": "fluorescent"` 与默认值
/// `"system"` 同为字符串、`"fontSize": -5` 与默认值 `14` 同为数字，按类型判断都会
/// 把非法值原样留下，最后 `from_value` 整体失败、**所有字段一起回到默认**。
///
/// 这里让 **serde 自己当裁判**：把某个字段替换进候选值后跑一遍
/// `from_value::<T>`，能过才采用。于是枚举白名单、`u32` 非负、整数不给小数……
/// 全部由类型系统覆盖，无需在 JSON 层复制一遍类型知识。
///
/// 各字段彼此独立（serde 逐字段校验），故逐个替换不存在顺序依赖。
fn recover_section<T>(incoming: Option<&Value>) -> T
where
    T: DeserializeOwned + Serialize + Default,
{
    let Some(incoming) = incoming else {
        return T::default();
    };
    // 快路径：整块能过就直接用（绝大多数字段都合法时的常见路径）
    if let Ok(v) = serde_json::from_value::<T>(incoming.clone()) {
        return v;
    }
    let Ok(mut candidate) = serde_json::to_value(T::default()) else {
        return T::default();
    };
    if let (Value::Object(cand), Value::Object(inc)) = (&mut candidate, incoming) {
        for (k, iv) in inc {
            if iv.is_null() || !cand.contains_key(k) {
                continue; // 未知字段直接丢；显式 null 视为「用默认」
            }
            let mut probe = cand.clone();
            probe.insert(k.clone(), iv.clone());
            if serde_json::from_value::<T>(Value::Object(probe)).is_ok() {
                cand.insert(k.clone(), iv.clone());
            }
        }
    }
    serde_json::from_value::<T>(candidate).unwrap_or_default()
}

/// `shortcuts` 是映射而非结构体，逐键实测没有意义（键是开放的），
/// 故单独清扫：只保留「非空字符串键 → 字符串值」
fn recover_shortcuts(incoming: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = incoming {
        for (k, v) in map {
            let key = k.trim();
            if key.is_empty() {
                continue;
            }
            if let Value::String(s) = v {
                out.insert(key.to_owned(), s.trim().to_owned());
            }
        }
    }
    clean_shortcuts(out)
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "aiotext-settings-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p.join(SETTINGS_FILE)
    }

    #[test]
    fn defaults_match_spec() {
        let s = Settings::default();
        assert_eq!(s.appearance.font_size, 14);
        assert_eq!(s.appearance.theme, Theme::System);
        assert!(s.appearance.show_toolbar && s.appearance.show_status_bar);
        assert!(s.appearance.show_line_number);
        // 不可见字符默认勾选（v0.6 #2：开关在「选项 → 编辑器」里，默认开）
        assert!(
            s.appearance.show_spaces
                && s.appearance.show_line_ends
                && s.appearance.show_paragraph_marks
        );
        assert_eq!(s.appearance.font_family, DEFAULT_FONT_FAMILY);
        assert_eq!(s.editor.tab_width, 4);
        assert!(s.editor.insert_spaces);
        assert!(!s.editor.wrap);
        assert_eq!(s.editor.default_encoding, EncodingOrAuto::Auto);
        assert_eq!(s.editor.default_line_ending, LineEnding::Lf);
        assert_eq!(s.conversion.bracket_skip, "[]");
        assert!(!s.conversion.preserve_converted);
        assert_eq!(s.compare, CompareOptions::default());
        // 快捷键默认是空覆盖表（默认键位只有前端注册表一份）
        assert!(s.shortcuts.is_empty());
    }

    #[test]
    fn serde_shape_is_camel_case() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        let a = &v["appearance"];
        assert_eq!(a["fontFamily"], DEFAULT_FONT_FAMILY);
        assert_eq!(a["fontSize"], 14);
        assert_eq!(a["showLineNumber"], true);
        assert_eq!(a["showToolbar"], true);
        assert_eq!(a["showStatusBar"], true);
        assert_eq!(a["theme"], "system");
        let e = &v["editor"];
        assert_eq!(e["tabWidth"], 4);
        assert_eq!(e["insertSpaces"], true);
        assert_eq!(e["wrap"], false);
        assert_eq!(e["defaultEncoding"], "auto");
        assert_eq!(e["defaultLineEnding"], "lf");
        assert_eq!(v["conversion"]["bracketSkip"], "[]");
        assert_eq!(v["conversion"]["preserveConverted"], false);
        // compare 复用 F-06 的 CompareOptions
        assert_eq!(v["compare"]["variantStrictness"], "strict");
        assert_eq!(v["compare"]["ignoreNewlines"], false);
        assert_eq!(v["shortcuts"], serde_json::json!({}));
    }

    #[test]
    fn roundtrip_through_disk() {
        let path = tmp_path("roundtrip");
        let mut s = Settings::default();
        s.appearance.theme = Theme::Dark;
        s.appearance.font_size = 20;
        s.editor.tab_width = 2;
        s.editor.wrap = true;
        s.editor.default_line_ending = LineEnding::CrLf;
        s.shortcuts
            .insert("ctrl+alt+t".into(), "convert.s2t".into());
        let written = save_to(&path, &s).unwrap();
        assert_eq!(written, sanitize(s.clone()));
        assert_eq!(load_from(&path), written);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_file_yields_defaults() {
        let path = tmp_path("missing").join("nope").join(SETTINGS_FILE);
        assert_eq!(load_from(&path), Settings::default());
    }

    #[test]
    fn out_of_range_values_are_clamped() {
        let s = Settings {
            appearance: Appearance {
                font_size: 99,
                font_family: "   ".into(),
                ..Appearance::default()
            },
            editor: EditorPrefs {
                tab_width: 0,
                ..EditorPrefs::default()
            },
            ..Settings::default()
        };
        let c = sanitize(s);
        assert_eq!(c.appearance.font_size, FONT_SIZE_MAX);
        assert_eq!(c.appearance.font_family, DEFAULT_FONT_FAMILY);
        assert_eq!(c.editor.tab_width, TAB_WIDTH_MIN);

        let low = sanitize(Settings {
            appearance: Appearance {
                font_size: 1,
                ..Appearance::default()
            },
            ..Settings::default()
        });
        assert_eq!(low.appearance.font_size, FONT_SIZE_MIN);
    }

    #[test]
    fn save_clamps_what_it_reports() {
        // save 返回的是「实际落盘」的值，前端据此同步（避免前后端各钳一次）
        let path = tmp_path("clamp-save");
        let s = Settings {
            appearance: Appearance {
                font_size: 1000,
                ..Appearance::default()
            },
            ..Settings::default()
        };
        let written = save_to(&path, &s).unwrap();
        assert_eq!(written.appearance.font_size, FONT_SIZE_MAX);
        // 文件里也是钳制后的值
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(&format!("\"fontSize\": {FONT_SIZE_MAX}")));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn lenient_load_keeps_good_fields_when_one_is_bad() {
        // theme 取值非法、fontSize 类型不对；其余字段（含快捷键）必须保留
        let path = tmp_path("lenient");
        std::fs::write(
            &path,
            r#"{
              "appearance": { "theme": "fluorescent", "fontSize": "big", "showToolbar": false },
              "editor": { "wrap": true },
              "shortcuts": { "ctrl+alt+t": "convert.s2t" }
            }"#,
        )
        .unwrap();
        let s = load_from(&path);
        // 坏字段回落默认
        assert_eq!(s.appearance.theme, Theme::System);
        assert_eq!(s.appearance.font_size, 14);
        // 好字段保留
        assert!(!s.appearance.show_toolbar);
        assert!(s.editor.wrap);
        assert_eq!(
            s.shortcuts.get("ctrl+alt+t").map(String::as_str),
            Some("convert.s2t")
        );
        // 坏文件留了备份
        assert!(path.with_extension("json.bad").exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn bad_numbers_fall_back_without_losing_siblings() {
        // 同为「数字」但类型不合法的值：负数进不了 u32、小数进不了 u32、
        // 以及字符串给了数字字段 —— 三种都必须回落默认，且不能连累同节其它字段
        let path = tmp_path("bad-numbers");
        std::fs::write(
            &path,
            r#"{
              "appearance": { "fontSize": -5, "showStatusBar": false },
              "editor": { "tabWidth": 3.5, "wrap": true },
              "conversion": { "preserveConverted": "yes" }
            }"#,
        )
        .unwrap();
        let s = load_from(&path);
        assert_eq!(s.appearance.font_size, 14);
        assert!(!s.appearance.show_status_bar, "同节好字段必须保留");
        assert_eq!(s.editor.tab_width, 4);
        assert!(s.editor.wrap, "同节好字段必须保留");
        assert!(!s.conversion.preserve_converted);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn section_that_is_not_an_object_falls_back() {
        let path = tmp_path("bad-section-type");
        std::fs::write(&path, r#"{"appearance":5,"editor":"nope","compare":[]}"#).unwrap();
        let s = load_from(&path);
        assert_eq!(s.appearance, Appearance::default());
        assert_eq!(s.editor, EditorPrefs::default());
        assert_eq!(s.compare, CompareOptions::default());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn explicit_null_field_uses_default() {
        let path = tmp_path("null-field");
        std::fs::write(&path, r#"{"appearance":{"theme":null,"fontSize":null}}"#).unwrap();
        let s = load_from(&path);
        assert_eq!(s.appearance.theme, Theme::System);
        assert_eq!(s.appearance.font_size, 14);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unknown_keys_are_dropped() {
        let path = tmp_path("unknown");
        std::fs::write(
            &path,
            r#"{"appearance":{"madeUp":1},"editor":{},"whatever":true,"shortcuts":{}}"#,
        )
        .unwrap();
        let s = load_from(&path);
        assert_eq!(s.appearance, Appearance::default());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_json_falls_back_to_defaults_with_backup() {
        let path = tmp_path("corrupt");
        std::fs::write(&path, "{ this is not json").unwrap();
        assert_eq!(load_from(&path), Settings::default());
        let bad = path.with_extension("json.bad");
        assert!(bad.exists());
        assert_eq!(std::fs::read_to_string(&bad).unwrap(), "{ this is not json");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn shortcuts_keep_empty_value_but_drop_empty_key() {
        // 空值 = 显式解绑（要保留）；空键 = 无意义（要丢掉）
        let mut map = BTreeMap::new();
        map.insert("  ".into(), "file.save".into());
        map.insert(" ctrl+s ".into(), "  ".into());
        map.insert("ctrl+o".into(), "  file.open ".into());
        let cleaned = clean_shortcuts(map);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned.get("ctrl+s").map(String::as_str), Some(""));
        assert_eq!(cleaned.get("ctrl+o").map(String::as_str), Some("file.open"));
    }

    #[test]
    fn non_string_shortcut_entries_are_dropped() {
        let path = tmp_path("shortcut-types");
        std::fs::write(
            &path,
            r#"{"shortcuts":{"ctrl+s":"file.save","ctrl+x":123,"":"file.new","ctrl+y":""}}"#,
        )
        .unwrap();
        let s = load_from(&path);
        assert_eq!(s.shortcuts.len(), 2);
        assert_eq!(
            s.shortcuts.get("ctrl+s").map(String::as_str),
            Some("file.save")
        );
        // 显式解绑的空值保留
        assert_eq!(s.shortcuts.get("ctrl+y").map(String::as_str), Some(""));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_is_idempotent_and_atomic_tmp_is_gone() {
        let path = tmp_path("atomic");
        let s = Settings::default();
        let first = save_to(&path, &s).unwrap();
        let second = save_to(&path, &first).unwrap();
        assert_eq!(first, second);
        // 临时文件已被 rename 掉，不留残渣
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn theme_next_cycles() {
        assert_eq!(Theme::System.next(), Theme::Light);
        assert_eq!(Theme::Light.next(), Theme::Dark);
        assert_eq!(Theme::Dark.next(), Theme::System);
    }

    #[test]
    fn theme_from_label_is_lenient() {
        assert_eq!(Theme::from_label(" Dark "), Some(Theme::Dark));
        assert_eq!(Theme::from_label("LIGHT"), Some(Theme::Light));
        assert_eq!(Theme::from_label("neon"), None);
    }
}
