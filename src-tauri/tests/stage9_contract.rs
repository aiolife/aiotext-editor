//! 阶段 9（F-01 会话与未保存恢复）契约测试
//!
//! 钉死前端 TypeScript 接口与后端 serde 形状的一致性：
//! - `SessionState` / `SessionTab` 全部字段名（camelCase）
//! - `content` 的**按需保存**语义（`null` = 启动时从 `filePath` 重读）
//! - 落盘是紧凑 JSON、原子写不留 `.tmp`
//! - 会话文件坏掉 / 个别标签坏掉时的降级行为（坏文件留 `.bad`，其余标签保住）
//! - 越界值（光标 0、未知行尾）在服务端就地纠正，回执是「实际落盘值」

use aiotext_editor_lib::core::session::{self, save_to, SessionState, SessionTab, SESSION_FILE};
use aiotext_editor_lib::StartupMetrics;
use serde_json::json;
use std::path::PathBuf;

fn tmp_dir(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "aiotext-stage9-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn tab(id: &str) -> SessionTab {
    SessionTab {
        id: id.to_owned(),
        file_path: None,
        file_name: format!("{id}.txt"),
        content: Some("未保存的正文".to_owned()),
        encoding: "utf-8".to_owned(),
        line_ending: "lf".to_owned(),
        had_bom: false,
        dirty: true,
        cursor_line: 1,
        cursor_column: 1,
    }
}

#[test]
fn session_default_shape_matches_frontend() {
    let v = serde_json::to_value(SessionState::default()).unwrap();
    assert_eq!(v["tabs"], json!([]));
    assert_eq!(v["activeTabId"], json!(null));
    assert_eq!(v.as_object().unwrap().len(), 2, "顶层只该有两个键");
}

#[test]
fn session_tab_keys_are_camel_case_and_roundtrip() {
    // 模拟前端 `sessionSave` 发来的完整标签（含未保存正文）
    let payload = json!({
        "id": "tab-7",
        "filePath": "D:/work/甲.txt",
        "fileName": "甲.txt",
        "content": "未保存的正文",
        "encoding": "gbk",
        "lineEnding": "crlf",
        "hadBom": true,
        "dirty": true,
        "cursorLine": 12,
        "cursorColumn": 3
    });
    let t: SessionTab = serde_json::from_value(payload).unwrap();
    assert_eq!(t.id, "tab-7");
    assert_eq!(t.file_path.as_deref(), Some("D:/work/甲.txt"));
    assert_eq!(t.content.as_deref(), Some("未保存的正文"));
    assert_eq!(t.encoding, "gbk");
    assert_eq!(t.line_ending, "crlf");
    assert!(t.had_bom);
    assert!(t.dirty);
    assert_eq!((t.cursor_line, t.cursor_column), (12, 3));

    let back = serde_json::to_value(&t).unwrap();
    for key in [
        "filePath",
        "fileName",
        "content",
        "encoding",
        "lineEnding",
        "hadBom",
        "dirty",
        "cursorLine",
        "cursorColumn",
    ] {
        assert!(back.get(key).is_some(), "缺少 {key}");
    }
    assert_eq!(back["lineEnding"], "crlf");
}

#[test]
fn saved_tab_omits_content_so_the_session_stays_small() {
    // 「打开十个大文件、一个字没改」：content 应为 null，会话里不出现正文
    let dir = tmp_dir("slim");
    let path = dir.join(SESSION_FILE);
    let state = SessionState {
        tabs: vec![SessionTab {
            content: None,
            file_path: Some("D:/huge.txt".to_owned()),
            file_name: "huge.txt".to_owned(),
            dirty: false,
            ..tab("t1")
        }],
        active_tab_id: Some("t1".to_owned()),
    };
    let written = save_to(&path, &state).unwrap();
    assert_eq!(written.tabs[0].content, None);
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"content\":null"), "raw={raw}");
    assert_eq!(session::load_from(&path), written);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn unsaved_content_and_cursor_survive_a_restart() {
    let dir = tmp_dir("restore");
    let path = dir.join(SESSION_FILE);
    let state = SessionState {
        tabs: vec![
            SessionTab {
                cursor_line: 42,
                cursor_column: 7,
                ..tab("t1")
            },
            SessionTab {
                content: Some(String::new()),
                file_name: "未命名-2".to_owned(),
                dirty: false,
                ..tab("t2")
            },
        ],
        active_tab_id: Some("t2".to_owned()),
    };
    save_to(&path, &state).unwrap();
    let restored = session::load_from(&path);
    assert_eq!(restored, state, "整份会话应原样恢复（含未保存正文与光标）");
    assert_eq!(restored.tabs[0].cursor_line, 42);
    assert_eq!(restored.active_tab_id.as_deref(), Some("t2"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_session_file_is_not_an_error() {
    let dir = tmp_dir("missing");
    assert_eq!(
        session::load_from(&dir.join(SESSION_FILE)),
        SessionState::default(),
        "首次启动（无会话文件）应得到空会话而不是报错"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn broken_json_falls_back_to_empty_session_and_keeps_a_backup() {
    let dir = tmp_dir("broken");
    let path = dir.join(SESSION_FILE);
    std::fs::write(&path, "{ 这不是 JSON").unwrap();
    assert_eq!(session::load_from(&path), SessionState::default());
    assert!(
        path.with_extension("json.bad").exists(),
        "坏会话应留 .bad 备份供排查"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn one_bad_tab_does_not_lose_the_rest() {
    // 第一个标签的 cursorLine 是字符串 → 该标签反序列化失败，应被丢弃
    let dir = tmp_dir("partly-bad");
    let path = dir.join(SESSION_FILE);
    std::fs::write(
        &path,
        r#"{"tabs":[{"id":"bad","cursorLine":"x"},{"id":"good","fileName":"g.txt","dirty":true,"content":"正文"}],"activeTabId":"good"}"#,
    )
    .unwrap();
    let s = session::load_from(&path);
    assert_eq!(s.tabs.len(), 1, "坏标签被丢弃");
    assert_eq!(s.tabs[0].id, "good");
    assert_eq!(s.tabs[0].content.as_deref(), Some("正文"));
    assert_eq!(s.active_tab_id.as_deref(), Some("good"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn out_of_range_values_are_corrected_on_save_and_reported_back() {
    let dir = tmp_dir("correct");
    let path = dir.join(SESSION_FILE);
    let state = SessionState {
        tabs: vec![SessionTab {
            cursor_line: 0,
            cursor_column: 0,
            line_ending: "crlf\r\n".to_owned(), // 非法取值
            ..tab("t1")
        }],
        active_tab_id: Some("不存在".to_owned()),
    };
    let written = save_to(&path, &state).unwrap();
    // 回执是「实际落盘值」，前端据此对齐，不会出现界面显示非法值
    assert_eq!(written.tabs[0].cursor_line, 1);
    assert_eq!(written.tabs[0].cursor_column, 1);
    assert_eq!(written.tabs[0].line_ending, "lf");
    assert_eq!(
        written.active_tab_id.as_deref(),
        Some("t1"),
        "活动标签指向不存在的 id 时回落到第一个"
    );
    assert_eq!(session::load_from(&path), written);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn clear_removes_session_and_leftovers() {
    let dir = tmp_dir("clear");
    let path = dir.join(SESSION_FILE);
    save_to(
        &path,
        &SessionState {
            tabs: vec![tab("t1")],
            active_tab_id: None,
        },
    )
    .unwrap();
    std::fs::write(path.with_extension("json.bad"), "旧的坏文件").unwrap();
    assert!(path.exists());

    session::clear_at(&path).unwrap();
    assert!(!path.exists(), "session.json 应被删除");
    assert!(
        !path.with_extension("json.bad").exists(),
        ".bad 残留应被清理"
    );
    // 幂等：已经不存在时再清一次也成功
    session::clear_at(&path).unwrap();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn startup_metrics_shape_is_camel_case() {
    // 前端 `startupMetrics()` 读的就是这个形状（`setupMs`）
    let m = StartupMetrics {
        setup_ms: 128,
        debug_build: false,
    };
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v["setupMs"], json!(128));
    assert_eq!(v["debugBuild"], json!(false));
    assert_eq!(v.as_object().unwrap().len(), 2, "指标字段数应稳定");
}
