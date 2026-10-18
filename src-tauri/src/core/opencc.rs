//! OpenCC 1.4.2 引擎封装（F-03 §3.8）
//!
//! **数据机制**（第一阶段探针实测确认）：`opencc-sys` 在编译期把 OpenCC 1.4.2 的
//! 全部配置 JSON（16 个）与 `.ocd2` 词典（22 个）以 `Data { file_name, content }`
//! 常量嵌入二进制。`opencc_open` 只接受磁盘路径，故本模块首次使用时把全部数据
//! 平铺写入 `%TEMP%/aiotext-opencc-<pid>/`（配置目录即词典搜索根），退出时清理。
//!
//! **线程安全**：C API 无并发保证，转换器池用 `Mutex` 串行化（F-03 §3.8）。
//! 转换器按配置路径缓存复用——`opencc_open` 需加载并反序列化全部词典，代价高。
//!
//! **C API 陷阱**：`opencc_open` 失败返回 `(opencc_t)-1` 而非 NULL，错误详情在
//! 全局 `opencc_error()`；两者都要检查。

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 转换方向（F-03 §3.3 `OpenCCDirection`）
///
/// **PRD v0.5 §3.5：只提供 6 种常用方向**（s2t / t2s / s2twp / tw2sp / s2hk / hk2s）。
///
/// 原先的 8 种低频方向 —— `s2tw` / `tw2s` / `t2tw` / `tw2t` / `t2hk` / `hk2t` /
/// `t2jp` / `jp2t` —— 按用户要求**从引擎侧彻底删除**：枚举变体、配置映射、
/// `all_standard()` 全部移除，它们的 id 在反序列化时会被拒绝（不是"UI 不显示但
/// 引擎还认"）。需要这些方向的用 `Custom`（`%APPDATA%/AioTextEditor/configs/<name>.json`）。
///
/// 另：`t2seal` / `seal2t` / `s2seal`（小篆，试验性）在 `opencc-sys` 0.5.2 内嵌
/// 数据中本就不存在，历来不支持。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    S2T,
    T2S,
    S2TWP,
    TW2SP,
    S2HK,
    HK2S,
    /// 用户自定义转换配置（`%APPDATA%/AioTextEditor/configs/<name>.json`）
    #[serde(rename = "custom")]
    Custom(String),
}

impl Direction {
    /// 内嵌配置文件名（`Custom` 为用户配置目录内的文件名）
    pub fn config_name(&self) -> String {
        let stem = match self {
            Direction::S2T => "s2t",
            Direction::T2S => "t2s",
            Direction::S2TWP => "s2twp",
            Direction::TW2SP => "tw2sp",
            Direction::S2HK => "s2hk",
            Direction::HK2S => "hk2s",
            Direction::Custom(name) => return format!("{name}.json"),
        };
        format!("{stem}.json")
    }

    /// 序列化 id（前端传参 / 缓存键）
    pub fn id(&self) -> String {
        match self {
            Direction::S2T => "s2t".into(),
            Direction::T2S => "t2s".into(),
            Direction::S2TWP => "s2twp".into(),
            Direction::TW2SP => "tw2sp".into(),
            Direction::S2HK => "s2hk".into(),
            Direction::HK2S => "hk2s".into(),
            Direction::Custom(name) => format!("custom:{name}"),
        }
    }

    /// UI 显示名
    pub fn label(&self) -> &'static str {
        match self {
            Direction::S2T => "简体 → 繁体（OpenCC 标准）",
            Direction::T2S => "繁体 → 简体（OpenCC 标准）",
            Direction::S2TWP => "简体 → 台湾正体（含台湾惯用词彙）",
            Direction::TW2SP => "台湾正体 → 简体（含大陆惯用词彙）",
            Direction::S2HK => "简体 → 香港繁体",
            Direction::HK2S => "香港繁体 → 简体",
            Direction::Custom(_) => "用户自定义转换配置",
        }
    }

    /// 同族方向（歧义诊断差分用）：同一转换族的其他标准方向
    ///
    /// 删掉 8 种低频方向后只剩两族（简→繁 / 繁→简）。差分照样能标出地区用字歧义：
    /// `s2t` 与 `s2twp` / `s2hk` 的用字差异就是"这里有别的合理写法"。
    pub fn family(&self) -> Vec<Direction> {
        match self {
            Direction::S2T | Direction::S2TWP | Direction::S2HK => {
                vec![Direction::S2T, Direction::S2TWP, Direction::S2HK]
            }
            Direction::T2S | Direction::TW2SP | Direction::HK2S => {
                vec![Direction::T2S, Direction::TW2SP, Direction::HK2S]
            }
            Direction::Custom(_) => Vec::new(),
        }
    }

    /// 全部提供的标准方向（PRD v0.5 §3.5：只保留常用 6 种）
    pub fn all_standard() -> Vec<Direction> {
        vec![
            Direction::S2T,
            Direction::T2S,
            Direction::S2TWP,
            Direction::TW2SP,
            Direction::S2HK,
            Direction::HK2S,
        ]
    }
}

// ---------------------------------------------------------------------------
// 内嵌数据落盘
// ---------------------------------------------------------------------------

/// 落盘的内嵌数据：**仍在提供**的 6 个配置 JSON + 全部 22 个词典
///
/// 已删除方向的配置（hk2t / jp2t / s2tw / s2hkp / t2hk / t2jp / t2tw / tw2s /
/// tw2t / hk2sp）不再写出——它们的 id 已无法反序列化，写出来只是给临时目录添
/// 无用文件。词典仍全量写出：剩下 6 个配置会引用其中大部分（含地区变体词典），
/// 逐个挑「谁用谁」不划算也容易漏。
fn all_data() -> Vec<&'static opencc_sys::Data> {
    vec![
        // 配置 JSON（PRD v0.5 §3.5：只剩 6 种方向）
        &opencc_sys::HK2S_JSON,
        &opencc_sys::S2HK_JSON,
        &opencc_sys::S2T_JSON,
        &opencc_sys::S2TWP_JSON,
        &opencc_sys::T2S_JSON,
        &opencc_sys::TW2SP_JSON,
        // 词典
        &opencc_sys::CJK_COMPATIBILITY_IDEOGRAPHS_OCD2,
        &opencc_sys::HK_PHRASES_OCD2,
        &opencc_sys::HK_PHRASES_REV_OCD2,
        &opencc_sys::HK_VARIANTS_OCD2,
        &opencc_sys::HK_VARIANTS_PHRASES_OCD2,
        &opencc_sys::HK_VARIANTS_REV_OCD2,
        &opencc_sys::HK_VARIANTS_REV_PHRASES_OCD2,
        &opencc_sys::JP_SHINJITAI_CHARATERS_OCD2,
        &opencc_sys::JP_SHINJITAI_CHARACTERS_REV_OCD2,
        &opencc_sys::JP_SHINJITAI_PHRASES_OCD2,
        &opencc_sys::ST_CHARACTERS_OCD2,
        &opencc_sys::ST_PHRASES_GENERATED_FROM_REGIONAL_PHRASES_OCD2,
        &opencc_sys::ST_PHRASES_OCD2,
        &opencc_sys::TS_CHARACTERS_OCD2,
        &opencc_sys::TS_CHARACTERS_EXT_OCD2,
        &opencc_sys::TS_PHRASES_OCD2,
        &opencc_sys::TW_PHRASES_OCD2,
        &opencc_sys::TW_PHRASES_REV_OCD2,
        &opencc_sys::TW_VARIANTS_OCD2,
        &opencc_sys::TW_VARIANTS_PHRASES_OCD2,
        &opencc_sys::TW_VARIANTS_REV_OCD2,
        &opencc_sys::TW_VARIANTS_REV_PHRASES_OCD2,
    ]
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 数据目录（懒初始化：首次调用时写盘，进程内复用）
pub fn data_dir() -> AppResult<&'static Path> {
    if let Some(dir) = DATA_DIR.get() {
        return Ok(dir.as_path());
    }
    let dir = std::env::temp_dir().join(format!("aiotext-opencc-{}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::OpenccInit(format!("创建临时目录失败：{e}")))?;
    for data in all_data() {
        let target = dir.join(data.file_name);
        if target.exists() {
            continue; // 同 pid 复用目录（重复初始化）
        }
        std::fs::write(&target, data.content)
            .map_err(|e| AppError::OpenccInit(format!("写出 {} 失败：{e}", data.file_name)))?;
    }
    tracing::info!(dir = %dir.display(), files = all_data().len(), "OpenCC 数据已展开");
    let _ = DATA_DIR.set(dir);
    Ok(DATA_DIR.get().expect("刚刚写入").as_path())
}

/// 清理临时数据目录（应用退出时调用）
pub fn cleanup() {
    if let Some(dir) = DATA_DIR.get() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 内嵌配置 JSON 原文（生成叠加配置时的基线）
fn embedded_config(direction: &Direction) -> AppResult<&'static [u8]> {
    let data = match direction {
        Direction::HK2S => &opencc_sys::HK2S_JSON,
        Direction::S2HK => &opencc_sys::S2HK_JSON,
        Direction::S2T => &opencc_sys::S2T_JSON,
        Direction::S2TWP => &opencc_sys::S2TWP_JSON,
        Direction::T2S => &opencc_sys::T2S_JSON,
        Direction::TW2SP => &opencc_sys::TW2SP_JSON,
        Direction::Custom(_) => {
            return Err(AppError::UnsupportedDirection(
                "自定义方向不参与内联叠加".into(),
            ))
        }
    };
    Ok(data.content)
}

// ---------------------------------------------------------------------------
// 转换器（RAII + 池化）
// ---------------------------------------------------------------------------

/// `opencc_t` 的 RAII 包装（`Drop` 调 `opencc_close`）
struct OpenccHandle {
    raw: opencc_sys::opencc_t,
}

// C API 本身无并发保证，但所有权唯一；跨线程传递安全性由外层 Mutex 串行化保证
unsafe impl Send for OpenccHandle {}
unsafe impl Sync for OpenccHandle {}

/// 取 `opencc_error()` 的全局错误串
fn last_error() -> String {
    unsafe {
        let ptr = opencc_sys::opencc_error();
        if ptr.is_null() {
            "未知错误".to_owned()
        } else {
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}

impl OpenccHandle {
    /// 打开配置文件（失败时 C API 返回 `(opencc_t)-1`，需与 NULL 一并检查）
    fn open(config_path: &Path) -> AppResult<Self> {
        let path_str = config_path
            .to_str()
            .ok_or_else(|| AppError::OpenccInit("配置路径含非法字符".into()))?;
        let c_path =
            CString::new(path_str).map_err(|_| AppError::OpenccInit("配置路径含 NUL".into()))?;
        let raw = unsafe { opencc_sys::opencc_open(c_path.as_ptr()) };
        // 陷阱：失败既可能是 NULL 也可能是 (opencc_t)-1
        if raw.is_null() || raw as isize == -1 {
            return Err(AppError::OpenccInit(format!(
                "加载 {} 失败：{}",
                config_path.display(),
                last_error()
            )));
        }
        tracing::debug!(config = %config_path.display(), "OpenCC 转换器已加载");
        Ok(Self { raw })
    }

    /// 转换文本（输入按 UTF-8 + 显式长度传入，NUL 安全）
    fn convert(&self, text: &str) -> AppResult<String> {
        let mut buf = text.as_bytes().to_vec();
        buf.push(0); // opencc_convert_utf8 需要 NUL 结尾（长度另行显式传入）
        let out = unsafe {
            opencc_sys::opencc_convert_utf8(
                self.raw,
                buf.as_ptr() as *const c_char,
                text.len() as _,
            )
        };
        if out.is_null() {
            return Err(AppError::Convert(last_error()));
        }
        let result = unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        unsafe { opencc_sys::opencc_convert_utf8_free(out) };
        Ok(result)
    }
}

impl Drop for OpenccHandle {
    fn drop(&mut self) {
        unsafe {
            opencc_sys::opencc_close(self.raw);
        }
    }
}

/// 转换器池：配置路径 → 已加载句柄
///
/// 锁的粒度覆盖整个转换过程——C API 的 `opencc_error()` 为全局状态，
/// 串行化是最省心的正确选择（F-03 §3.8 同一设计）。
static CONVERTERS: LazyLock<Mutex<HashMap<String, OpenccHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 以指定配置文件执行一次转换（路径经池化缓存复用）
fn convert_with_config(config_path: &Path, text: &str) -> AppResult<String> {
    let key = config_path.to_string_lossy().into_owned();
    let mut pool = CONVERTERS.lock().unwrap_or_else(|e| e.into_inner());
    if !pool.contains_key(&key) {
        let handle = OpenccHandle::open(config_path)?;
        pool.insert(key.clone(), handle);
    }
    let handle = pool.get(&key).expect("刚插入");
    handle.convert(text)
}

/// 按方向转换（数据目录内的标准配置）
pub fn convert(direction: &Direction, text: &str) -> AppResult<String> {
    let config_path = data_dir()?.join(direction.config_name());
    convert_with_config(&config_path, text)
}

/// 叠加用户内联词典后转换（F-03 §3.2 用户词典叠加 / F-04 模式 B）
///
/// 做法：读入基线配置 JSON → 在该配置 `conversion_chain[0].dict` 的
/// `short_circuit` 组**首位**插入 `{"type":"inline","entries":{...}}` →
/// 写入数据目录（按内容哈希命名，池化复用）。首位插入保证用户表优先于
/// 标准词库（第一阶段探针实测确认的行为）。
pub fn convert_with_inline_dicts(
    direction: &Direction,
    entries: &[(String, String)],
    text: &str,
) -> AppResult<String> {
    if entries.is_empty() {
        return convert(direction, text);
    }
    let base = embedded_config(direction)?;
    let config_path = write_inline_config(direction, base, entries)?;
    convert_with_config(&config_path, text)
}

/// 仅用用户内联词典转换（F-04 §4.5 `ApplyMode::AsOpenccDic`）
///
/// 与 [`convert_with_inline_dicts`] 的区别：**不挂简繁基线**，转换链只含用户
/// 词典。用于让用户核对"同一张表交给 OpenCC 引擎"的结果（例如与独立替换
/// 模式 A 对照），也是 F-04 模式 B 的独立入口。
pub fn convert_dict_only(entries: &[(String, String)], text: &str) -> AppResult<String> {
    if entries.is_empty() {
        return Ok(text.to_owned());
    }
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        map.insert(key.clone(), serde_json::Value::String(value.clone()));
    }
    let root = serde_json::json!({
        "name": "AioTextEditor:UserDictionary",
        "conversion_chain": [
            { "dict": { "type": "inline", "entries": serde_json::Value::Object(map) } }
        ]
    });
    let path = write_config("dict-only", &root, entries)?;
    convert_with_config(&path, text)
}

/// 生成「基线配置 + 内联词典」配置文件，返回其路径
fn write_inline_config(
    direction: &Direction,
    base_json: &[u8],
    entries: &[(String, String)],
) -> AppResult<PathBuf> {
    use serde_json::{json, Map, Value};

    let mut root: Value = serde_json::from_slice(base_json)
        .map_err(|e| AppError::OpenccInit(format!("解析内嵌配置失败：{e}")))?;

    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.clone(), Value::String(value.clone()));
    }
    let inline = json!({ "type": "inline", "entries": Value::Object(map) });

    // 定位 conversion_chain[0].dict
    let dict = root
        .get_mut("conversion_chain")
        .and_then(|c| c.get_mut(0))
        .and_then(|c| c.get_mut("dict"))
        .ok_or_else(|| AppError::OpenccInit("配置缺少 conversion_chain[0].dict".into()))?;

    if dict.get("type").and_then(|t| t.as_str()) == Some("group") {
        let dicts = dict
            .get_mut("dicts")
            .and_then(|d| d.as_array_mut())
            .ok_or_else(|| AppError::OpenccInit("group 缺少 dicts 数组".into()))?;
        dicts.insert(0, inline); // 首位 = 最高优先级
    } else {
        // 非 group：包一层 short_circuit，用户表在前
        let original = dict.take();
        *dict = json!({
            "type": "group",
            "match_policy": "short_circuit",
            "dicts": [inline, original]
        });
    }

    let prefix = format!("aiotext-inline-{}", direction.id());
    write_config(&prefix, &root, entries)
}

/// 写出运行时生成的配置：按「前缀 + 内容哈希」命名（内容变化即新文件，
/// 池化缓存天然失效），返回文件路径。
fn write_config(
    prefix: &str,
    root: &serde_json::Value,
    entries: &[(String, String)],
) -> AppResult<PathBuf> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&prefix, &mut hasher);
    for (k, v) in entries {
        std::hash::Hash::hash(k, &mut hasher);
        std::hash::Hash::hash(v, &mut hasher);
    }
    let digest = std::hash::Hasher::finish(&hasher);

    let dir = data_dir()?;
    let path = dir.join(format!("{prefix}-{digest:016x}.json"));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(root).expect("内置结构可序列化"),
    )
    .map_err(|e| AppError::OpenccInit(format!("写出叠加配置失败：{e}")))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ensure_engine() {
        data_dir().expect("OpenCC 数据目录初始化");
    }

    #[test]
    fn data_dir_contains_all_embedded_files() {
        let dir = data_dir().unwrap();
        for data in all_data() {
            let p = dir.join(data.file_name);
            assert!(p.exists(), "缺少 {}", data.file_name);
            assert_eq!(
                std::fs::metadata(&p).unwrap().len(),
                data.content.len() as u64,
                "{} 大小不符",
                data.file_name
            );
        }
    }

    #[test]
    fn s2t_handles_ambiguous_words() {
        ensure_engine();
        let out = convert(
            &Direction::S2T,
            "汉字简繁转换测试：头发，发展。皇后在后面。",
        )
        .unwrap();
        assert_eq!(out, "漢字簡繁轉換測試：頭髮，發展。皇后在後面。");
    }

    #[test]
    fn t2s_reverse() {
        ensure_engine();
        let out = convert(&Direction::T2S, "頭髮發展，皇后在後面").unwrap();
        assert_eq!(out, "头发发展，皇后在后面");
    }

    #[test]
    fn s2twp_uses_taiwan_phrases() {
        ensure_engine();
        let out = convert(&Direction::S2TWP, "鼠标和软件").unwrap();
        assert_eq!(out, "滑鼠和軟體");
    }

    #[test]
    fn hk2s_direction() {
        ensure_engine();
        // 香港繁体用字 → 简体
        let out = convert(&Direction::HK2S, "香港嘅繁體字").unwrap();
        assert!(out.contains("繁体"));
    }

    #[test]
    fn inline_dict_overrides_standard_phrases() {
        ensure_engine();
        let entries = vec![("软件".to_owned(), "軟體".to_owned())];
        let out = convert_with_inline_dicts(&Direction::S2T, &entries, "软件的发展").unwrap();
        // 标准 s2t 给「軟件」，用户表优先 → 「軟體」
        assert_eq!(out, "軟體的發展");
        // 未叠加时按标准词库
        let std_out = convert(&Direction::S2T, "软件的发展").unwrap();
        assert_eq!(std_out, "軟件的發展");
    }

    #[test]
    fn inline_dict_multi_key_many_to_one() {
        ensure_engine();
        // F-04 多对一：两个源字 → 同一目标字
        let entries = vec![
            ("少".to_owned(), "㝹".to_owned()),
            ("兔".to_owned(), "㝹".to_owned()),
        ];
        let out = convert_with_inline_dicts(&Direction::S2T, &entries, "少年和兔子").unwrap();
        assert!(out.starts_with("㝹年"), "实际：{out}");
        assert!(out.contains("㝹子"), "实际：{out}");
    }

    #[test]
    fn every_standard_direction_runs() {
        ensure_engine();
        let sample = "汉字简繁转换测试，头发发展，皇后在后面。";
        let mut failures = Vec::new();
        for direction in Direction::all_standard() {
            match convert(&direction, sample) {
                Ok(out) => {
                    assert!(!out.is_empty(), "{direction:?} 输出为空");
                }
                Err(e) => failures.push(format!("{direction:?}: {e}")),
            }
        }
        assert!(failures.is_empty(), "失败方向：{failures:#?}");
    }

    #[test]
    fn long_text_conversion_performance() {
        ensure_engine();
        // 约 10 万字样本（与 F-03 §3.9 单测覆盖一致）
        let unit = "汉字简繁转换测试，头发发展，皇后在后面。屏幕上的鼠标和软件。";
        let text = unit.repeat(4000);
        assert!(text.chars().count() > 100_000, "样本不足 10 万字");
        let start = std::time::Instant::now();
        let out = convert(&Direction::S2T, &text).unwrap();
        let elapsed = start.elapsed();
        assert!(out.contains("頭髮"));
        assert!(out.chars().count() > 90_000);
        tracing::info!(ms = elapsed.as_millis(), "10 万字转换耗时");
        assert!(elapsed.as_secs() < 10, "10 万字转换过慢：{elapsed:?}");
    }

    #[test]
    fn direction_metadata() {
        assert_eq!(Direction::S2T.config_name(), "s2t.json");
        assert_eq!(
            Direction::Custom("my-config".into()).config_name(),
            "my-config.json"
        );
        // PRD v0.5 §3.5：只保留 6 种常用方向
        assert_eq!(Direction::all_standard().len(), 6);
        assert!(Direction::S2T.family().contains(&Direction::S2TWP));
        // 删掉的 8 种方向，引擎侧也不认（反序列化必须失败）
        for removed in [
            "s2tw", "tw2s", "t2tw", "tw2t", "t2hk", "hk2t", "t2jp", "jp2t",
        ] {
            assert!(
                serde_json::from_value::<Direction>(serde_json::json!(removed)).is_err(),
                "{removed} 应已删除，却仍能被反序列化"
            );
        }
    }
}
