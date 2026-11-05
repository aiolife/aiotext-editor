//! 本地历史（§3.12）契约测试
//!
//! 从外部 crate 视角钉死前端 TS 接口与后端 serde 形状：
//! - `SnapshotMeta` / `SnapshotInput` 全部 camelCase 字段名（含编码三项）
//! - 索引是紧凑 JSON、原子写不留 `.tmp`
//! - `docs.json` 路径映射跨调用稳定，清除后不留条目
//! - 批量清除与「清空全部」语义

use aiotext_editor_lib::core::local_history::{self, SnapshotInput, SnapshotMeta, SCHEMA_VERSION};
use serde_json::json;
use std::path::PathBuf;

fn tmp_dir(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "aiotext-lh-contract-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn write_file(dir: &PathBuf, name: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, b"seed").unwrap();
    p.to_string_lossy().into_owned()
}

fn sample_input(path: &str) -> SnapshotInput {
    serde_json::from_value(json!({
        "path": path,
        "id": "snap-1",
        "ts": 1700000000000i64,
        "trigger": "auto",
        "label": null,
        "hash": "abcdef",
        "size": 6,
        "schemaVersion": SCHEMA_VERSION,
        "committed": false,
        "pinned": false,
        "encoding": "utf-8",
        "hadBom": false,
        "lineEnding": "crlf",
        "content": "内容A"
    }))
    .unwrap()
}

#[test]
fn snapshot_meta_serializes_camel_case() {
    let meta: SnapshotMeta = serde_json::from_value(json!({
        "id": "snap-1", "ts": 1, "trigger": "auto", "label": null,
        "hash": "h", "size": 3, "schemaVersion": 1,
        "committed": true, "pinned": false,
        "encoding": "gbk", "hadBom": true, "lineEnding": "crlf"
    }))
    .unwrap();
    assert!(meta.committed && meta.had_bom);
    assert_eq!(meta.encoding, "gbk");
    assert_eq!(meta.line_ending, "crlf");

    let raw = serde_json::to_string(&meta).unwrap();
    for key in [
        "schemaVersion",
        "hadBom",
        "lineEnding",
        "committed",
        "pinned",
    ] {
        assert!(raw.contains(&format!("\"{key}\"")), "缺少 {key}");
    }
    for snake in ["schema_version", "had_bom", "line_ending"] {
        assert!(!raw.contains(snake), "不该出现 {snake}");
    }
}

#[test]
fn snapshot_input_accepts_frontend_shape() {
    let d = tmp_dir("input");
    let path = write_file(&d, "note.md");
    let input = sample_input(&path);
    assert_eq!(input.id, "snap-1");
    assert_eq!(input.line_ending, "crlf");
    assert_eq!(input.content, "内容A");
    std::fs::remove_dir_all(&d).unwrap();
}

#[test]
fn index_is_compact_atomic_and_mapping_is_stable() {
    let d = tmp_dir("index");
    let path = write_file(&d, "note.md");
    local_history::write(&d, &sample_input(&path)).unwrap();

    let doc_id = local_history::doc_key(&d, &path).unwrap();
    assert_eq!(doc_id, local_history::doc_key(&d, &path).unwrap());
    let index = std::fs::read_to_string(d.join(&doc_id).join("index.json")).unwrap();
    assert!(!index.contains('\n'), "索引应是紧凑 JSON");
    assert!(index.contains("\"schemaVersion\""));
    assert!(!d.join(&doc_id).join("index.json.tmp").exists());

    let docs = std::fs::read_to_string(d.join("docs.json")).unwrap();
    assert!(!docs.contains('\n'), "路径映射应是紧凑 JSON");
    std::fs::remove_dir_all(&d).unwrap();
}

#[test]
fn clear_batch_and_clear_all_contract() {
    let d = tmp_dir("clear");
    let p1 = write_file(&d, "a.md");
    let p2 = write_file(&d, "b.md");
    let mut second = sample_input(&p2);
    second.id = "snap-2".to_owned();
    local_history::write(&d, &sample_input(&p1)).unwrap();
    local_history::write(&d, &second).unwrap();

    assert!(local_history::clear(&d, &[p1.clone()]).unwrap().is_empty());
    assert!(local_history::list(&d, &p1).unwrap().is_empty());
    assert_eq!(local_history::list(&d, &p2).unwrap().len(), 1);

    assert!(local_history::clear(&d, &[]).unwrap().is_empty());
    assert!(!d.exists());
}
