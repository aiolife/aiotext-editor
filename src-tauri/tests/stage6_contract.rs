//! 第六阶段契约测试（F-06 文件比较 + F-07 文件合并）
//!
//! 目的：把「前端 TS 接口 ↔ Rust 结构体」的序列化形状钉死。前端发的是
//! `{"ignoreNewlines":true,"variantStrictness":"fullEq"}` 这样的 **camelCase
//! JSON**，任何字段改名 / 改大小写都会在这里先炸，而不是等到真实 UI 里
//! 静默失效。
//!
//! 与单测的分工：`core::text_diff::tests` / `core::merge::tests` 验证
//! **算法语义**，本文件只验证**跨语言契约**。

use aiotext_editor_lib::core::compare::{CompareOptions, VariantStrictness};
use aiotext_editor_lib::core::data_tables;
use aiotext_editor_lib::core::merge::{self, MergePlanOptions, MergeStrategy};
use aiotext_editor_lib::core::text_diff;
use aiotext_editor_lib::error::AppResult;
use serde_json::{json, Value};

/// 取 JSON 对象的键集合（排序后便于比较）
fn keys(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = value
        .as_object()
        .expect("应为 JSON 对象")
        .keys()
        .cloned()
        .collect();
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// F-06 文件比较
// ---------------------------------------------------------------------------

#[test]
fn frontend_style_compare_options_parse() {
    // 前端完整写法（camelCase + 枚举取值）
    let opts: CompareOptions = serde_json::from_value(json!({
        "ignoreNewlines": true,
        "ignoreHalfSpace": true,
        "ignoreFullPunct": true,
        "ignoreHalfPunct": true,
        "variantStrictness": "partialEq"
    }))
    .expect("camelCase 选项应能解析");
    assert_eq!(opts.variant_strictness, VariantStrictness::PartialEq);

    // 前端最小写法：省略的字段取默认值（Strict、全部不忽略）
    let minimal: CompareOptions =
        serde_json::from_value(json!({})).expect("空对象应能解析（serde default）");
    assert_eq!(minimal, CompareOptions::default());
    assert_eq!(minimal.variant_strictness, VariantStrictness::Strict);

    // 枚举取值与前端 TS 联合类型一一对应
    for value in ["fullEq", "partialEq", "strict"] {
        let parsed: VariantStrictness = serde_json::from_value(json!(value))
            .unwrap_or_else(|e| panic!("枚举取值 {value} 应能解析：{e}"));
        let back = serde_json::to_value(parsed).unwrap();
        assert_eq!(back, json!(value), "序列化往返应保持小驼峰");
    }
}

#[test]
fn diff_result_shape_is_stable() {
    let tables = data_tables::load_variant_tables(None).unwrap();
    let opts = CompareOptions::default();
    let result = text_diff::diff("甲乙丙", "甲X丙", &opts, &tables);
    let value = serde_json::to_value(&result).expect("结果应可序列化");

    assert_eq!(
        keys(&value),
        vec!["blocks", "degraded", "truncated"],
        "DiffResult 字段必须与前端 TS 接口一致（camelCase）"
    );
    assert_eq!(
        keys(&value["blocks"][0]),
        vec!["lenA", "lenB", "posA", "posB"],
        "DiffBlock 字段必须与前端 TS 接口一致（camelCase）"
    );
    // 「乙 → X」是换掉一个字：算一处（工具条上的「第 i/N 处」就是这么数的）
    assert_eq!(
        value["blocks"].as_array().expect("blocks 应是数组").len(),
        1
    );
    assert_eq!(value["blocks"][0]["posA"], json!(1));
    assert_eq!(value["blocks"][0]["lenA"], json!(1));
    assert_eq!(value["blocks"][0]["lenB"], json!(1));
    assert_eq!(value["truncated"], json!(false));
    assert_eq!(value["degraded"], json!(false));

    // 尾部多出来的字：一处「只有一侧」的差异
    let terminal = text_diff::diff("甲", "甲乙", &opts, &tables);
    let value = serde_json::to_value(&terminal).unwrap();
    assert_eq!(value["blocks"][0]["lenA"], json!(0));
    assert_eq!(value["blocks"][0]["lenB"], json!(1));
}

// ---------------------------------------------------------------------------
// F-07 文件合并
// ---------------------------------------------------------------------------

#[test]
fn frontend_style_merge_request_parses() {
    use aiotext_editor_lib::commands::merge::MergeRequest;

    // 手工合并：清单 + 输出文件（共用字段经 flatten 平铺进同一层 JSON）
    let manual: MergeRequest = serde_json::from_value(json!({
        "mode": "manual",
        "files": ["a.txt", "b.txt"],
        "strategy": "simple",
        "sortKey": "序-(\\d+)-",
        "outputPath": "C:\\out\\merged.txt",
        "overwrite": true
    }))
    .expect("手工合并请求应能解析");
    match manual {
        MergeRequest::Manual { files, shared } => {
            assert_eq!(files, vec!["a.txt", "b.txt"]);
            assert_eq!(shared.strategy, MergeStrategy::Simple);
            assert_eq!(shared.output_path.as_deref(), Some(r"C:\out\merged.txt"));
            assert!(shared.overwrite);
        }
        other => panic!("mode 应解析为 Manual：{other:?}"),
    }

    // 自动合并：目录 + 正则三件套；overwrite 省略时默认 false
    let auto: MergeRequest = serde_json::from_value(json!({
        "mode": "auto",
        "directory": "D:\\splits",
        "strategy": "sameName",
        "sourcePattern": "(\\d+)_(\\d+)\\.txt",
        "outputPattern": "\\1.txt",
        "sortKey": "\\2"
    }))
    .expect("自动合并请求应能解析");
    match auto {
        MergeRequest::Auto { directory, shared } => {
            assert_eq!(directory, "D:\\splits");
            assert_eq!(shared.strategy, MergeStrategy::SameName);
            assert!(!shared.overwrite, "overwrite 未给出时应为 false");
        }
        other => panic!("mode 应解析为 Auto：{other:?}"),
    }
}

#[test]
fn merge_report_shape_is_stable() {
    let items = vec![
        aiotext_editor_lib::core::merge::MergeItem {
            name: "1_2.txt".into(),
            text: "甲".into(),
        },
        aiotext_editor_lib::core::merge::MergeItem {
            name: "1_9.txt".into(),
            text: "乙".into(),
        },
    ];
    let opts = MergePlanOptions {
        strategy: MergeStrategy::SameName,
        source_pattern: Some(r"(\d+)_(\d+)\.txt".into()),
        output_pattern: Some(r"\1.txt".into()),
        sort_key: Some(r"\2".into()),
    };
    let outputs = merge::plan_merge(&items, &opts).expect("规划应成功");
    let value = serde_json::to_value(&outputs).unwrap();
    assert_eq!(
        keys(&value[0]),
        vec!["name", "order", "text"],
        "MergedOutput 字段必须与前端 TS 接口一致（camelCase）"
    );
    assert_eq!(value[0]["name"], json!("1.txt"));
    assert_eq!(value[0]["order"], json!(["1_2.txt", "1_9.txt"]));

    // 命令层报告形状（serde Serialize，无 Deserialize 也可钉形状）
    let report = aiotext_editor_lib::commands::merge::MergeReport {
        outputs: Vec::new(),
        skipped: vec![aiotext_editor_lib::commands::merge::MergeSkip {
            path: "x.txt".into(),
            reason: "读取失败".into(),
        }],
        scanned: 3,
    };
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(keys(&value), vec!["outputs", "scanned", "skipped"]);
    assert_eq!(keys(&value["skipped"][0]), vec!["path", "reason"]);
}

#[test]
fn merged_text_end_to_end() -> AppResult<()> {
    // 语义抽查：同名段拼接按序 + 空行相接（与单测互补，聚焦「前端可见」结果）
    let items: Vec<aiotext_editor_lib::core::merge::MergeItem> = ["1_9.txt", "1_2.txt"]
        .iter()
        .map(|name| aiotext_editor_lib::core::merge::MergeItem {
            name: (*name).into(),
            text: format!("{name} 的内容\n"),
        })
        .collect();
    let opts = MergePlanOptions {
        strategy: MergeStrategy::SameName,
        source_pattern: Some(r"(\d+)_(\d+)\.txt".into()),
        output_pattern: Some(r"\1.txt".into()),
        sort_key: Some(r"\2".into()),
    };
    let outputs = merge::plan_merge(&items, &opts)?;
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].name, "1.txt");
    assert_eq!(outputs[0].text, "1_2.txt 的内容\n\n1_9.txt 的内容\n");
    Ok(())
}
