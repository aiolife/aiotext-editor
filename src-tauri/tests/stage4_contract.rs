//! 第四阶段前后端契约集成测试（F-04 自定义替换表 / F-05 中文增强正则）
//!
//! 前端 `src/platform/tauriApi.ts` 的 TS 接口是手写的，这里用真实序列化形状
//! 交叉验证：字段名（camelCase）、枚举取值（`standalone` / `asOpenccDic`）、
//! 偏移口径（UTF-16 码元）与两种应用模式的语义。

use aiotext_editor_lib::core::regex::{self, RegexOptions};
use aiotext_editor_lib::core::replace::{self, ApplyMode, ApplyOpts, ReplaceTable};
use serde_json::json;

fn table_from(text: &str, name: &str) -> ReplaceTable {
    replace::parse_table_text(text, name).table
}

#[test]
fn frontend_apply_request_shapes() {
    // 形状与 tauriApi.ts 的 ReplaceTable / ApplyOpts 完全一致
    let table: ReplaceTable = serde_json::from_value(json!({
        "name": "测试表",
        "description": "单测",
        "entries": [
            { "pattern": "少/兔", "candidates": ["少", "兔"], "replacement": "㝹" }
        ],
        "rules": { "wholeWord": false, "caseSensitive": true, "escape": true, "useRegex": false },
        "meta": { "name": "测试表", "builtin": false, "entryCount": 1, "description": "单测", "path": "" }
    }))
    .expect("前端表结构应可反序列化");

    let opts: ApplyOpts = serde_json::from_value(json!({ "mode": "standalone" })).unwrap();
    assert_eq!(opts.mode, ApplyMode::Standalone);

    let report = replace::apply("少兔", &table, &opts).unwrap();
    assert_eq!(report.text, "㝹㝹");
    assert_eq!(report.changed_count, 2);

    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["changedCount"], 2);
    assert_eq!(value["perEntryCount"]["兔"], 1);
    assert!(value.get("changed_count").is_none(), "须为 camelCase");
}

#[test]
fn opencc_dictionary_mode_applies_user_entries() {
    // F-04 模式 B：同一张表交给 OpenCC 内联词典执行
    let table = table_from("#name: 词表\n鼠标=滑鼠\n", "词表");
    let opts = ApplyOpts {
        mode: ApplyMode::AsOpenccDic,
    };
    let report = replace::apply("我的鼠标和鼠标垫", &table, &opts).unwrap();
    assert_eq!(report.text, "我的滑鼠和滑鼠垫");
    assert_eq!(report.changed_count, 2, "两种模式都应按命中数计数");
}

#[test]
fn standalone_mode_respects_whole_word_option() {
    let mut table = table_from("#name: 词表\ncat=猫\n", "词表");
    table.rules.whole_word = true;
    let report = replace::apply_standalone("concatenate a cat", &table).unwrap();
    assert_eq!(report.text, "concatenate a 猫");
}

#[test]
fn table_text_round_trip_through_frontend_shape() {
    // 前端「镜像编辑器」链路：文本 → 解析 → 报告 → 结构化表
    let parsed = replace::parse_table_text("#name: 往返\n鼠标=滑鼠\n裸文本\n", "往返");
    assert!(!parsed.report.ok, "裸文本应报错");
    assert_eq!(parsed.report.errors, 1);
    let value = serde_json::to_value(&parsed).unwrap();
    assert_eq!(value["report"]["issues"][0]["severity"], "error");
    assert_eq!(
        value["report"]["issues"][0]["line"], 3,
        "行号必须是源文件行号"
    );
    assert_eq!(value["table"]["name"], "往返");
    assert_eq!(value["table"]["entries"][0]["candidates"][0], "鼠标");
}

#[test]
fn regex_options_shape_and_utf16_offsets() {
    let opts: RegexOptions = serde_json::from_value(json!({
        "regex": true,
        "ignoreNewlines": false,
        "ignorePunct": false,
        "ignoreHalfSpace": false,
        "caseInsensitive": false,
        "useEscape": true
    }))
    .expect("前端选项结构应可反序列化");

    // 天干类目 + UTF-16 偏移（含增补平面字符时的口径）
    let spans = regex::find("甲😀乙", "\\c[天干]", &opts).unwrap();
    assert_eq!(spans.len(), 2);
    let value = serde_json::to_value(&spans).unwrap();
    assert_eq!(value[0]["start"], 0);
    assert_eq!(value[0]["end"], 1);
    // 😀 占两个 UTF-16 码元，故「乙」的区间起点为 3
    assert_eq!(value[1]["start"], 3);
    assert_eq!(value[1]["text"], "乙");
}

#[test]
fn regex_ignore_switches_map_to_frontend_fields() {
    let opts: RegexOptions = serde_json::from_value(json!({
        "regex": true,
        "ignoreNewlines": true,
        "ignorePunct": false,
        "ignoreHalfSpace": true,
        "caseInsensitive": false,
        "useEscape": true
    }))
    .unwrap();
    let spans = regex::find("关 键\n词", "关键词", &opts).unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].text, "关 键\n词", "命中区间应覆盖被忽略字符");
}

#[test]
fn regex_replace_reports_rendered_replacements() {
    let opts = RegexOptions::default();
    let report = regex::replace("张三 李四", "(\\S+) (\\S+)", "\\2 \\1", &opts, 0, None).unwrap();
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["text"], "李四 张三");
    assert_eq!(value["replacements"][0], "李四 张三");
    assert_eq!(value["count"], 1);
}

#[test]
fn bundled_builtin_tables_are_loadable_by_display_name() {
    // 内置表在资源目录内，按「#name: 显示名」也要能定位（前端列表用的是显示名）
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data/builtin-tables");
    let mut checked = 0usize;
    for item in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("tab") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap();
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let parsed = replace::parse_table_text(&content, &stem);
        assert!(parsed.report.ok, "{} 校验未通过", path.display());
        assert!(
            !parsed.table.name.is_empty(),
            "{} 缺少可用表名",
            path.display()
        );
        checked += 1;
    }
    assert!(checked >= 3, "内置表示例数量不足：{checked}");
}
