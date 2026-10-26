//! 第五阶段契约测试（F-09 文本整理工具集）
//!
//! 目的：把「前端 TS 接口 ↔ Rust 结构体」的序列化形状钉死。前端发的是
//! `{"kind":"control_width","width":10,"breakAfter":"，"}` 这样的 **camelCase
//! JSON**，任何字段改名 / 改大小写都会在这里先炸，而不是等到真实 UI 里
//! 静默失效（第四阶段已经因此吃过一次亏：表名与文件名不一致）。
//!
//! 与单测的分工：`core::pipelines::tests` 验证**算法语义**，
//! 本文件只验证**跨语言契约**。

use aiotext_editor_lib::core::pipelines::{self, PipelineStep, StepOutcome, ToolMeta};
use aiotext_editor_lib::core::ui_lang;
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

#[test]
fn catalog_matches_frontend_tool_meta_shape() {
    let metas: Vec<ToolMeta> = pipelines::catalog();
    // v0.9：菜单只露出「5 个排版类工具 + 6 个高频直点项」，
    // 其余步骤收进了工具内部（仍可用 `from_id` 构造，批处理照旧选得到）。
    assert_eq!(metas.len(), 11, "菜单上应露出 11 项");

    let value = serde_json::to_value(&metas).expect("目录应可序列化");
    let first = &value[0];
    assert_eq!(
        keys(first),
        vec!["group", "hasOptions", "hint", "id", "inspectsOnly", "label"],
        "ToolMeta 字段必须与前端 TS 接口一致（camelCase）"
    );

    // 分组必须真实存在，前端据此渲染分隔标题
    //
    // 期望值要过一遍 `ui_lang::t`：`catalog()` 会按当前界面语言输出分组名（PRD
    // L-5），而集成测试用的是 lib 的非 test 编译，读得到开发者机器上真实的
    // settings.json。硬编码简体会让这组断言在繁體配置的机器上失败。
    let groups: Vec<&str> = metas.iter().map(|m| m.group.as_str()).collect();
    for expected in [ui_lang::t("排版规范"), ui_lang::t("常用")] {
        assert!(groups.contains(&expected.as_str()), "缺少分组：{expected}");
    }
    // 五个排版类工具都要在目录里，且都可带选项
    for id in [
        "normalize_punctuation",
        "web_novel_layout",
        "chinese_copywriting",
        "tech_doc_layout",
        "snippet_process",
    ] {
        let meta = metas
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("目录里应有 {id}"));
        assert!(meta.has_options, "{id} 应带可调选项");
    }
    // 纯检查型（匹配括号）已收进「规范标点」，目录里不再有独立项
    assert!(
        metas.iter().all(|m| !m.inspects_only),
        "目录里不应再有纯检查项：它们只是规范标点的一项检查"
    );
}

#[test]
fn frontend_style_step_json_applies() {
    // 前端最小写法：只给 kind
    let step: PipelineStep =
        serde_json::from_value(json!({"kind": "remove_empty_lines"})).expect("应能解析");
    let outcome = pipelines::run_step("甲\n\n　\n乙\n", &step).expect("应能执行");
    assert_eq!(outcome.text, "甲\n乙\n");
    assert_eq!(outcome.changed, 2);

    // 前端带选项：camelCase 字段名
    let step: PipelineStep = serde_json::from_value(json!({
        "kind": "control_width",
        "width": 10,
        "indent": 0,
        "breakAfter": "，",
        "forbidHead": "，"
    }))
    .expect("camelCase 选项应能解析");
    let outcome = pipelines::run_step("甲乙丙丁，戊己庚辛壬癸\n", &step).expect("应能执行");
    assert_eq!(outcome.text, "甲乙丙丁，\n戊己庚辛壬\n癸\n");
}

#[test]
fn step_outcome_shape_is_stable() {
    let outcome = pipelines::run_step("甲\n乙", &pipelines::from_id("sort_lines").unwrap())
        .expect("应能执行");
    let value = serde_json::to_value(&outcome).expect("结果应可序列化");
    assert_eq!(
        keys(&value),
        vec!["bracketIssues", "changed", "notes", "text"],
        "StepOutcome 字段必须与前端 TS 接口一致"
    );
    assert!(value["notes"].is_array(), "notes 应为字符串数组");

    // 检查型工具带回结构化问题（前端按行/列标红提示）
    let inspect = pipelines::run_step("甲（乙", &pipelines::from_id("match_brackets").unwrap())
        .expect("应能执行");
    let value = serde_json::to_value(&inspect).expect("结果应可序列化");
    let issue = &value["bracketIssues"][0];
    assert_eq!(keys(issue), vec!["ch", "column", "line", "message"]);
    assert_eq!(issue["line"], 1);
    assert_eq!(issue["column"], 2);
    assert_eq!(issue["ch"], "（");
    // 检查型工具不改写正文
    assert_eq!(value["text"], "甲（乙");
}

#[test]
fn chain_runs_in_order_with_accumulated_notes() {
    let steps: Vec<PipelineStep> = serde_json::from_value(json!([
        { "kind": "trim_line_end" },
        { "kind": "insert_blank_between" },
        { "kind": "normalize_line_head", "indent": 1 }
    ]))
    .expect("链应能解析");
    let outcome = pipelines::run_chain("甲 \n乙\n\n丙\n", &steps).expect("应能执行");
    // insert_blank_between 现在按「每段 = 一个非空行」补齐空行，故三行之间各有一个空行
    assert_eq!(outcome.text, "　甲\n\n　乙\n\n　丙\n");
    assert_eq!(
        outcome.notes.len(),
        3,
        "每步至少一条提示：{:?}",
        outcome.notes
    );
    // 提示按步骤序号前缀，便于 UI 直接展示
    assert!(outcome.notes[0].starts_with("1. "), "{:?}", outcome.notes);
    assert!(outcome.notes[2].starts_with("3. "), "{:?}", outcome.notes);
}

#[test]
fn every_catalog_id_round_trips_through_json() {
    // 前端只会发送目录里的 id：逐个用 JSON 走一遍，确认「目录 → JSON → 步骤」闭环
    for meta in pipelines::catalog() {
        let value = json!({ "kind": meta.id });
        let step: PipelineStep = serde_json::from_value(value.clone())
            .unwrap_or_else(|e| panic!("目录项 {} 无法从前端 JSON 还原：{e}", meta.id));
        assert_eq!(step.id(), meta.id);
        let round_trip = serde_json::to_value(&step).expect("应可序列化");
        assert_eq!(round_trip["kind"], value["kind"]);
    }
    // 未知 id 必须报错（不能静默当成空操作）
    assert!(serde_json::from_value::<PipelineStep>(json!({ "kind": "unknown_tool" })).is_err());
}

#[test]
fn search_panel_tool_replacement_contract() {
    use aiotext_editor_lib::core::regex::{self, RegexOptions};
    let opts = RegexOptions {
        regex: true,
        ignore_newlines: false,
        ignore_punct: false,
        ignore_half_space: false,
        case_insensitive: false,
        use_escape: true,
    };
    let step = pipelines::from_id("half_to_full").expect("工具存在");
    // 只对命中内容套用工具；命中外的文本原样保留
    let report =
        regex::replace_with_tool("a甲 b甲", r"[ab]", &opts, &step, 0, None).expect("应能替换");
    assert_eq!(report.text, "ａ甲 ｂ甲");
    assert_eq!(report.count, 2);
    // 报告形状（前端据此做精确区间改写与提示）
    let value = serde_json::to_value(&report).expect("应可序列化");
    assert_eq!(
        keys(&value),
        vec!["count", "replacements", "spans", "text"],
        "RegexReplaceReport 字段必须与前端 TS 接口一致"
    );
    assert_eq!(
        keys(&value["spans"][0]),
        vec!["end", "groups", "start", "text"]
    );
}

#[test]
fn every_tool_runs_with_default_options_and_reports_a_note() {
    // 前端「直接应用」时只发 kind：所有工具都必须能取默认值运行，且给出一条提示
    for meta in pipelines::catalog() {
        let step: PipelineStep = serde_json::from_value(json!({ "kind": meta.id }))
            .unwrap_or_else(|e| panic!("{} 缺少默认选项：{e}", meta.id));
        let outcome: StepOutcome = pipelines::run_step("甲\n乙\n", &step)
            .unwrap_or_else(|e| panic!("{} 默认选项无法执行：{e}", meta.id));
        assert!(!outcome.notes.is_empty(), "{} 未给出提示", meta.id);
    }
}
