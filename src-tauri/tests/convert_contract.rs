//! 前后端契约集成测试（F-03）
//!
//! 前端 `src/platform/tauriApi.ts` 手工声明了转换相关的 TS 接口。
//! 本测试用真实的序列化形状做交叉验证：前端传的 JSON 能反序列化、
//! 后端返回的字段名（camelCase）与 TS 声明一致、方向 id 集合对齐。

use aiotext_editor_lib::core::convert::{self, ConvertRequest, PREVIEW_LINE_LIMIT};
use aiotext_editor_lib::core::opencc::Direction;
use serde_json::json;

/// PRD v0.5 §3.5：前端与引擎只提供这 6 种方向
const FRONTEND_DIRECTION_IDS: [&str; 6] = ["s2t", "t2s", "s2twp", "tw2sp", "s2hk", "hk2s"];

/// 已彻底删除的方向：引擎侧也必须拒绝（防止哪天被偷偷加回来）
const REMOVED_DIRECTION_IDS: [&str; 8] = [
    "s2tw", "tw2s", "t2tw", "tw2t", "t2hk", "hk2t", "t2jp", "jp2t",
];

#[test]
fn frontend_direction_ids_all_deserialize() {
    for id in FRONTEND_DIRECTION_IDS {
        let direction: Direction =
            serde_json::from_value(json!(id)).unwrap_or_else(|e| panic!("{id} 反序列化失败：{e}"));
        assert_eq!(direction.id(), id, "方向 id 往返不一致");
    }
    // Rust 侧列出的方向集合与前端常量一致
    let listed: Vec<String> = Direction::all_standard().iter().map(|d| d.id()).collect();
    assert_eq!(listed.len(), FRONTEND_DIRECTION_IDS.len());
    for id in FRONTEND_DIRECTION_IDS {
        assert!(listed.contains(&id.to_owned()), "后端缺少方向 {id}");
    }
    // 删除的方向：反序列化必须失败（引擎侧同样不认）
    for id in REMOVED_DIRECTION_IDS {
        assert!(
            serde_json::from_value::<Direction>(json!(id)).is_err(),
            "已删除的方向 {id} 又被反序列化成功了"
        );
    }
}

#[test]
fn convert_request_accepts_frontend_json() {
    // 形状与 tauriApi.ts 的 ConvertRequest 完全一致
    let request: ConvertRequest = serde_json::from_value(json!({
        "text": "头发发展",
        "direction": "s2t",
        "skipInside": [{ "open": "[", "close": "]" }],
        "applyUserTables": [],
        "diagnostics": true
    }))
    .expect("前端请求形状应可反序列化");

    let report = convert::convert(&request).unwrap();
    let value = serde_json::to_value(&report).unwrap();

    assert_eq!(value["text"], "頭髮發展");
    assert_eq!(value["changedCount"], 3);
    assert!(value["ambiguities"].is_array());
    assert!(value["appliedTables"].is_array());
    assert!(value["directionLabel"].is_string());
    // 确认是 camelCase（前端 TS 声明如此）
    assert!(value.get("changed_count").is_none());
}

#[test]
fn preview_returns_camel_case_diff_lines() {
    let request: ConvertRequest = serde_json::from_value(json!({
        "text": "第一行保持\n第二行 头发",
        "direction": "s2t",
        "skipInside": [],
        "applyUserTables": [],
        "diagnostics": false
    }))
    .unwrap();

    let preview = convert::preview(&request, PREVIEW_LINE_LIMIT).unwrap();
    let value = serde_json::to_value(&preview).unwrap();

    assert_eq!(value["changedLines"], 1);
    assert_eq!(value["totalLines"], 2);
    assert_eq!(value["truncated"], false);
    assert_eq!(value["lines"][0]["lineNumber"], 2);
    assert_eq!(value["lines"][0]["old"], "第二行 头发");
    assert_eq!(value["lines"][0]["new"], "第二行 頭髮");
    assert_eq!(value["lines"][0]["oldRange"], json!([4, 6]));
    assert_eq!(value["lines"][0]["newRange"], json!([4, 6]));
}

#[test]
fn user_table_entries_reach_conversion_chain() {
    // F-04 模式 B：内联词典优先于标准词库（不依赖磁盘用户表，直接验核心能力）
    let entries = vec![("软件".to_owned(), "軟體".to_owned())];
    let out = aiotext_editor_lib::core::opencc::convert_with_inline_dicts(
        &Direction::S2T,
        &entries,
        "软件的发展",
    )
    .unwrap();
    assert_eq!(out, "軟體的發展");
}

#[test]
fn ambiguous_short_text_is_untouched() {
    // F-03 §3.7：< 4 字节不走引擎
    let request: ConvertRequest = serde_json::from_value(json!({
        "text": "a",
        "direction": "s2t",
        "skipInside": [],
        "applyUserTables": [],
        "diagnostics": false
    }))
    .unwrap();
    let report = convert::convert(&request).unwrap();
    assert_eq!(report.text, "a");
    assert_eq!(report.changed_count, 0);
}
