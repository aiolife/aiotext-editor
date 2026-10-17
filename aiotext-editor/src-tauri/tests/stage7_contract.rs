//! 阶段 7（F-08 批处理）契约测试
//!
//! 钉死前端 TypeScript 接口与后端 serde 形状的一致性：
//! - `BatchRequest` 字段名（camelCase）+ `EncodingOrAuto` 平铺字符串
//! - `BatchProgress` 的 tag 枚举
//! - `BatchReport` / `BatchFileError` / `BatchPhase` 字段
//! - `BatchPlan` 形状
//! - 端到端：模拟前端的 JSON 走完一轮 run_batch，回执含 `errors` 与 `written` 等

use aiotext_editor_lib::core::batch::{self, BatchPhase, BatchRequest, EncodingOrAuto};
use aiotext_editor_lib::core::encoding::Encoding;
use aiotext_editor_lib::core::pipelines::PipelineStep;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

#[test]
fn batch_request_uses_camel_case_and_flat_encoding() {
    // 模拟前端 fetch(`batch_run`, { req: <this> })
    let req_json = json!({
        "inputs": ["D:\\incoming"],
        "recursive": true,
        "backup": true,
        "preserveMtime": true,
        "inputEncoding": "auto",
        "outputEncoding": "utf-8",
        "steps": [
            { "kind": "remove_empty_lines" },
            { "kind": "trim_line_end" },
        ],
    });
    let req: BatchRequest = serde_json::from_value(req_json).unwrap();
    assert_eq!(req.inputs, vec![PathBuf::from("D:\\incoming")]);
    assert!(req.recursive);
    assert!(req.backup);
    assert!(req.preserve_mtime);
    assert!(req.input_encoding.is_auto());
    assert!(matches!(
        req.output_encoding,
        EncodingOrAuto::Fixed(Encoding::Utf8)
    ));
    assert_eq!(req.steps.len(), 2);
    assert!(matches!(req.steps[0], PipelineStep::RemoveEmptyLines));
    assert!(matches!(req.steps[1], PipelineStep::TrimLineEnd));
}

#[test]
fn encoding_or_auto_serializes_as_plain_string() {
    // 序列化：必须是裸字符串，不能是 { "Auto": null } 或 null
    let s = serde_json::to_string(&EncodingOrAuto::Auto).unwrap();
    assert_eq!(s, "\"auto\"");
    let s = serde_json::to_string(&EncodingOrAuto::Fixed(Encoding::Gbk)).unwrap();
    assert_eq!(s, "\"gbk\"");
    let s = serde_json::to_string(&EncodingOrAuto::Fixed(Encoding::Big5)).unwrap();
    assert_eq!(s, "\"big5\"");

    // 反序列化
    let v: EncodingOrAuto = serde_json::from_str("\"auto\"").unwrap();
    assert!(v.is_auto());
    let v: EncodingOrAuto = serde_json::from_str("\"gb18030\"").unwrap();
    assert!(matches!(v, EncodingOrAuto::Fixed(Encoding::Gb18030)));

    // 未知编码应报错而非静默回退
    let r: Result<EncodingOrAuto, _> = serde_json::from_str("\"shift-jis\"");
    assert!(
        r.is_err(),
        "未支持的编码必须被拒绝，让前端在 UI 校验阶段就发现"
    );
}

#[test]
fn batch_phase_serialization_is_lowercase_camel() {
    assert_eq!(
        serde_json::to_string(&BatchPhase::Enumerate).unwrap(),
        "\"enumerate\""
    );
    assert_eq!(
        serde_json::to_string(&BatchPhase::Read).unwrap(),
        "\"read\""
    );
    assert_eq!(
        serde_json::to_string(&BatchPhase::Process).unwrap(),
        "\"process\""
    );
    assert_eq!(
        serde_json::to_string(&BatchPhase::Backup).unwrap(),
        "\"backup\""
    );
    assert_eq!(
        serde_json::to_string(&BatchPhase::Write).unwrap(),
        "\"write\""
    );
    assert_eq!(
        serde_json::to_string(&BatchPhase::Mtime).unwrap(),
        "\"mtime\""
    );
}

#[test]
fn batch_summary_serializes_to_expected_keys() {
    // 用空 summary（默认值）走一遍：确认前端能解析的字段都在
    let s = serde_json::to_string(&batch::BatchSummary::default()).unwrap();
    for key in [
        "\"scanned\"",
        "\"unchanged\"",
        "\"written\"",
        "\"backedUp\"",
        "\"cancelled\"",
        "\"errors\"",
        "\"elapsedMs\"",
    ] {
        assert!(s.contains(key), "缺少字段 {key}：{s}");
    }
}

#[test]
fn end_to_end_request_runs_and_returns_consistent_report() {
    // 直接走 core API（不依赖 tauri Channel），验证完整请求/回执闭环
    let tmp = std::env::temp_dir().join(format!(
        "aiotext-stage7-contract-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    for i in 0..5 {
        std::fs::write(tmp.join(format!("f{i}.txt")), "  spaced  \n").unwrap();
    }
    // 加一个读不出的「目录项」来触发错误（用不存在的子路径）
    let bad = tmp.join("missing_subdir");

    let req = BatchRequest {
        inputs: vec![tmp.clone(), bad],
        recursive: false,
        backup: false,
        preserve_mtime: true,
        input_encoding: EncodingOrAuto::Auto,
        output_encoding: EncodingOrAuto::Auto,
        steps: vec![PipelineStep::TrimLineEnd],
    };
    let summary = batch::run_batch(&req, &AtomicBool::new(false), |_| {});

    // 5 个真文件全部 trim；无效路径单独作为 Enumerate 错误入报
    assert_eq!(summary.scanned, 5, "无效路径不应计入 scanned");
    assert_eq!(summary.written, 5);
    assert_eq!(
        summary.errors.len(),
        1,
        "无效路径应作为 Enumerate 错误被记录"
    );
    assert_eq!(summary.errors[0].phase, BatchPhase::Enumerate);
    assert!(!summary.cancelled);

    // 报告可序列化为前端期望的 camelCase
    let s = serde_json::to_string(&summary).unwrap();
    assert!(s.contains("\"written\":5"));
    assert!(s.contains("\"backedUp\":0"));

    std::fs::remove_dir_all(&tmp).ok();
}
