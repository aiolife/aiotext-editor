//! 阶段 8（F-11 偏好设置）契约测试
//!
//! 钉死前端 TypeScript 接口与后端 serde 形状的一致性：
//! - `Settings` 全部字段名（camelCase）与取值（枚举小写、编码裸字符串）
//! - `compare` 复用 F-06 的 `CompareOptions`（字段名与 F-06 契约一致）
//! - 快捷键覆盖表的**三态语义**（缺键 / 空串 / 非空）
//! - 前端发来的越界值在服务端被钳制，且回执是「实际落盘值」
//! - `reset` 真的删掉文件（含 `.bad` / `.tmp` 残留）

use aiotext_editor_lib::core::compare::{CompareOptions, VariantStrictness};
use aiotext_editor_lib::core::encoding::{Encoding, EncodingOrAuto, LineEnding};
use aiotext_editor_lib::core::settings::{
    self, reset_at, save_to, Appearance, Settings, Theme, DEFAULT_FONT_FAMILY, FONT_SIZE_MAX,
    FONT_SIZE_MIN, SETTINGS_FILE,
};
use serde_json::json;
use std::path::PathBuf;

fn tmp_dir(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "aiotext-stage8-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn settings_defaults_serialize_to_frontend_shape() {
    // 前端 `Settings` 接口能解析的键必须全在
    let v = serde_json::to_value(Settings::default()).unwrap();
    for key in ["appearance", "editor", "conversion", "compare", "shortcuts"] {
        assert!(v.get(key).is_some(), "缺少顶层字段 {key}");
    }
    let appearance = &v["appearance"];
    for key in [
        "fontFamily",
        "fontSize",
        "showLineNumber",
        "showToolbar",
        "showStatusBar",
        "theme",
    ] {
        assert!(appearance.get(key).is_some(), "缺少 appearance.{key}");
    }
    let editor = &v["editor"];
    for key in [
        "tabWidth",
        "insertSpaces",
        "wrap",
        "defaultEncoding",
        "defaultLineEnding",
    ] {
        assert!(editor.get(key).is_some(), "缺少 editor.{key}");
    }
    let conversion = &v["conversion"];
    for key in ["bracketSkip", "preserveConverted"] {
        assert!(conversion.get(key).is_some(), "缺少 conversion.{key}");
    }
    // 枚举 / 编码 / 行尾都是小写裸字符串
    assert_eq!(appearance["theme"], "system");
    assert_eq!(editor["defaultEncoding"], "auto");
    assert_eq!(editor["defaultLineEnding"], "lf");
    assert_eq!(appearance["fontSize"], 14);
    assert_eq!(editor["tabWidth"], 4);
    assert_eq!(appearance["fontFamily"], DEFAULT_FONT_FAMILY);
    assert_eq!(v["shortcuts"], json!({}));
}

#[test]
fn compare_section_reuses_f06_compare_options() {
    // §11.1 的 `compare` 直接复用 F-06 的 `CompareOptions`：
    // 字段名必须与 `compare_texts` 的入参完全一致，否则「设默认值」和
    // 「对话框初值」会变成两份不同的东西
    let v = serde_json::to_value(Settings::default()).unwrap();
    let direct = serde_json::to_value(CompareOptions::default()).unwrap();
    assert_eq!(v["compare"], direct);
    for key in [
        "ignoreNewlines",
        "ignoreHalfSpace",
        "ignoreFullPunct",
        "ignoreHalfPunct",
        "variantStrictness",
    ] {
        assert!(v["compare"].get(key).is_some(), "缺少 compare.{key}");
    }
    assert_eq!(v["compare"]["variantStrictness"], "strict");
}

#[test]
fn frontend_payload_roundtrips() {
    // 模拟前端设置对话框点「保存」时发来的完整对象
    let payload = json!({
        "appearance": {
            "fontFamily": "'Noto Serif SC', serif",
            "fontSize": 18,
            "showLineNumber": false,
            "showToolbar": false,
            "showStatusBar": true,
            "theme": "dark"
        },
        "editor": {
            "tabWidth": 2,
            "insertSpaces": false,
            "wrap": true,
            "defaultEncoding": "gbk",
            "defaultLineEnding": "crlf"
        },
        "conversion": { "bracketSkip": "【】", "preserveConverted": true },
        "compare": {
            "ignoreNewlines": true,
            "ignoreHalfSpace": false,
            "ignoreFullPunct": true,
            "ignoreHalfPunct": false,
            "variantStrictness": "partialEq"
        },
        "shortcuts": { "ctrl+alt+t": "convert.s2t", "f5": "compare.next" }
    });
    let s: Settings = serde_json::from_value(payload).unwrap();
    assert_eq!(s.appearance.font_size, 18);
    assert_eq!(s.appearance.theme, Theme::Dark);
    assert!(!s.appearance.show_toolbar);
    assert!(!s.appearance.show_line_number);
    assert_eq!(s.editor.tab_width, 2);
    assert!(!s.editor.insert_spaces);
    assert!(s.editor.wrap);
    assert_eq!(
        s.editor.default_encoding,
        EncodingOrAuto::Fixed(Encoding::Gbk)
    );
    assert_eq!(s.editor.default_line_ending, LineEnding::CrLf);
    assert_eq!(s.conversion.bracket_skip, "【】");
    assert!(s.conversion.preserve_converted);
    assert!(s.compare.ignore_newlines);
    assert!(s.compare.ignore_full_punct);
    assert!(!s.compare.ignore_half_punct);
    assert_eq!(s.compare.variant_strictness, VariantStrictness::PartialEq);
    assert_eq!(s.shortcuts.len(), 2);

    // 回写形状一致（前端可直接复用同一份 TS 类型）
    let back = serde_json::to_value(&s).unwrap();
    assert_eq!(back["appearance"]["theme"], "dark");
    assert_eq!(back["editor"]["defaultEncoding"], "gbk");
    assert_eq!(back["editor"]["defaultLineEnding"], "crlf");
    assert_eq!(back["compare"]["variantStrictness"], "partialEq");
    assert_eq!(back["shortcuts"]["f5"], "compare.next");
}

#[test]
fn shortcut_override_table_has_three_states() {
    // 缺键 = 用默认；空串 = 显式解绑；非空 = 覆盖
    let dir = tmp_dir("shortcut-states");
    let path = dir.join(SETTINGS_FILE);
    let s = Settings {
        shortcuts: [
            ("file.save".to_owned(), "ctrl+alt+1".to_owned()), // 覆盖
            ("file.open".to_owned(), String::new()),           // 解绑
        ]
        .into_iter()
        .collect(),
        ..Settings::default()
    };
    let written = save_to(&path, &s).unwrap();
    assert_eq!(
        written.shortcuts.get("file.save").map(String::as_str),
        Some("ctrl+alt+1")
    );
    assert_eq!(
        written.shortcuts.get("file.open").map(String::as_str),
        Some(""),
        "空串必须原样保留：它是「显式解绑」，与「没有这个键（用默认）」是两回事"
    );
    assert_eq!(written.shortcuts.get("file.new"), None);
    assert_eq!(settings::load_from(&path), written);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn out_of_range_values_are_clamped_on_save_and_reported_back() {
    let dir = tmp_dir("clamp");
    let path = dir.join(SETTINGS_FILE);
    let s = Settings {
        appearance: Appearance {
            font_size: 999,
            font_family: "   ".to_owned(),
            ..Appearance::default()
        },
        ..Settings::default()
    };
    let written = save_to(&path, &s).unwrap();
    // 回执是「实际落盘值」，前端据此对齐，不会出现界面上写着 999、磁盘里是 32
    assert_eq!(written.appearance.font_size, FONT_SIZE_MAX);
    assert_eq!(written.appearance.font_family, DEFAULT_FONT_FAMILY);
    let on_disk = settings::load_from(&path);
    assert_eq!(on_disk.appearance.font_size, FONT_SIZE_MAX);
    assert_eq!(on_disk.appearance.font_family, DEFAULT_FONT_FAMILY);

    let low = save_to(
        &path,
        &Settings {
            appearance: Appearance {
                font_size: 1,
                ..Appearance::default()
            },
            ..Settings::default()
        },
    )
    .unwrap();
    assert_eq!(low.appearance.font_size, FONT_SIZE_MIN);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn reset_removes_settings_and_leftovers() {
    let dir = tmp_dir("reset");
    let path = dir.join(SETTINGS_FILE);
    save_to(&path, &Settings::default()).unwrap();
    // 手工造出两种残留
    std::fs::write(path.with_extension("json.bad"), "坏的").unwrap();
    std::fs::write(path.with_extension("json.tmp"), "半截").unwrap();
    assert!(path.exists());

    let defaults = reset_at(&path).unwrap();
    assert_eq!(defaults, Settings::default());
    assert!(!path.exists(), "settings.json 应被删除");
    assert!(
        !path.with_extension("json.bad").exists(),
        ".bad 残留应被清理"
    );
    assert!(
        !path.with_extension("json.tmp").exists(),
        ".tmp 残留应被清理"
    );

    // 对已经不存在的文件再 reset 一次也必须成功（幂等）
    assert_eq!(reset_at(&path).unwrap(), Settings::default());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn unknown_encoding_in_settings_is_rejected_not_silently_defaulted() {
    // 编码沿用 `EncodingOrAuto` 的严格解析：未知编码报错，交给恢复逻辑回落，
    // 而不是把用户写的 "shift-jis" 当成 auto 悄悄改掉
    let r: Result<EncodingOrAuto, _> = serde_json::from_str("\"shift-jis\"");
    assert!(r.is_err());
}
