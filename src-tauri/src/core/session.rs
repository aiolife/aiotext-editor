//! F-01 §1.2 会话与未保存恢复（第九阶段）
//!
//! 「断电后下次启动能恢复到上次关闭时的标签和未保存的内容」（规格 §1.1）。
//!
//! ## 内容策略：只存「从磁盘就能还原」之外的部分
//!
//! 每个标签都记下 id / 路径 / 编码 / 行尾 / 光标，但**正文按需保存**：
//!
//! | 标签状态 | `content` | 启动时 |
//! |----------|-----------|--------|
//! | 有路径且已保存（`dirty = false`） | `None` | 从磁盘重读（文件可能已被外部改动，以磁盘为准） |
//! | 有未保存修改（`dirty = true`） | `Some(正文)` | 直接用会话里的正文 |
//! | 新建、从未保存过（无路径） | `Some(正文)` | 直接用会话里的正文 |
//!
//! 于是「打开十个大文件、一个字没改」的会话只有几 KB，而「改了一半没保存」的
//! 内容一个字都不会丢。
//!
//! ## 与设置文件同样的三条底线
//!
//! 1. **永不因为会话文件坏掉而启动失败**：解析不了就回落空会话（原文件留
//!    `.bad` 备份）；个别标签坏掉只丢那个标签，其余照常恢复。
//! 2. **原子写**：同目录临时文件 + `rename`（与 `core::settings` 同法）。
//! 3. **就地纠正明显越界值**：光标至少为 `1`、行尾收敛到 `lf` / `cr` / `crlf`、
//!    空 id 的标签丢弃——省得让前端到处判非法值。
//!
//! 纯 Rust：不依赖 Tauri，可独立单测。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// 会话文件名（`<app_data>/session.json`）
pub const SESSION_FILE: &str = "session.json";

/// 合法的行尾取值（前端 `EditorTab.lineEnding` 三态）
const LINE_ENDINGS: [&str; 3] = ["lf", "cr", "crlf"];

fn default_encoding() -> String {
    "utf-8".to_owned()
}

fn default_line_ending() -> String {
    "lf".to_owned()
}

fn default_cursor() -> u32 {
    1
}

/// 一个会话标签（与前端 `EditorTab` 同形，`content` 可缺省）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    /// `None` = 新建、未关联文件
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub file_name: String,
    /// 未保存正文；`None` = 启动时从 `file_path` 重读
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default = "default_line_ending")]
    pub line_ending: String,
    #[serde(default)]
    pub had_bom: bool,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default = "default_cursor")]
    pub cursor_line: u32,
    #[serde(default = "default_cursor")]
    pub cursor_column: u32,
}

/// 全部会话
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionState {
    pub tabs: Vec<SessionTab>,
    pub active_tab_id: Option<String>,
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/// 就地纠正越界值（幂等）
pub fn sanitize(mut s: SessionState) -> SessionState {
    s.tabs.retain(|t| !t.id.trim().is_empty());
    for t in &mut s.tabs {
        t.id = t.id.trim().to_owned();
        t.file_path = t.file_path.take().and_then(|p| {
            let p = p.trim().to_owned();
            if p.is_empty() {
                None
            } else {
                Some(p)
            }
        });
        if t.file_name.trim().is_empty() {
            t.file_name = t
                .file_path
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "未命名".to_owned());
        }
        if t.encoding.trim().is_empty() {
            t.encoding = default_encoding();
        }
        if !LINE_ENDINGS.contains(&t.line_ending.as_str()) {
            t.line_ending = default_line_ending();
        }
        t.cursor_line = t.cursor_line.max(1);
        t.cursor_column = t.cursor_column.max(1);
    }
    // 活动标签必须存在；否则回落到第一个（都没有则 None）
    if let Some(active) = &s.active_tab_id {
        if !s.tabs.iter().any(|t| &t.id == active) {
            s.active_tab_id = None;
        }
    }
    if s.active_tab_id.is_none() {
        s.active_tab_id = s.tabs.first().map(|t| t.id.clone());
    }
    s
}

// ---------------------------------------------------------------------------
// 路径与读写
// ---------------------------------------------------------------------------

/// 会话文件路径：`<app_data>/session.json`
pub fn session_path() -> AppResult<PathBuf> {
    let base = crate::core::paths::app_data_dir()
        .ok_or_else(|| AppError::Session("无法定位用户数据目录".into()))?;
    Ok(base.join(SESSION_FILE))
}

/// 读取会话（**永不失败**）：文件缺失 / 不可读 / 坏掉都得到空会话
pub fn load() -> SessionState {
    match session_path() {
        Ok(path) => load_from(&path),
        Err(e) => {
            // 定位不到数据目录时会话必然恢复不出来。留一条日志，否则「上次打开
            // 的标签怎么没了」会变成无头案（PRD §3.9 Q-7）。
            tracing::warn!(error = %e, "无法定位会话文件，本次不恢复会话");
            SessionState::default()
        }
    }
}

/// 写入会话；返回**实际落盘**（已纠正）的值
pub fn save(state: &SessionState) -> AppResult<SessionState> {
    save_to(&session_path()?, state)
}

/// 清除会话（连同 `.bad` / `.tmp` 残留）
pub fn clear() -> AppResult<()> {
    clear_at(&session_path()?)
}

/// 从指定文件读取（测试入口）
pub fn load_from(path: &Path) -> SessionState {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        // 文件不存在是**首次启动的正常路径**，不打日志
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SessionState::default(),
        Err(e) => {
            // 存在却读不出来（权限 / 磁盘故障 / 被占）：会话会静默恢复不出来，
            // 用户的直观感受是「我的标签页丢了」，必须留下可查的线索
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "会话文件存在但读不出来，本次不恢复会话"
            );
            return SessionState::default();
        }
    };
    // 与设置文件同理：带 BOM 的会话会被 serde_json 整份拒掉（PRD §3.10 Q-8）
    let raw = crate::core::settings::strip_bom(raw);

    // 快路径：整份能过就直接用
    if let Ok(s) = serde_json::from_str::<SessionState>(&raw) {
        return sanitize(s);
    }

    tracing::warn!(path = %path.display(), "会话文件解析失败，尝试逐标签恢复");

    // 慢路径：逐标签恢复，坏的丢、好的留
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        tracing::warn!(path = %path.display(), "会话文件不是合法 JSON，回落空会话");
        backup(path);
        return SessionState::default();
    };
    let tabs: Vec<SessionTab> = v
        .get("tabs")
        .and_then(Value::as_array)
        .map(|arr| {
            let total = arr.len();
            let parsed: Vec<SessionTab> = arr
                .iter()
                .filter_map(|t| serde_json::from_value::<SessionTab>(t.clone()).ok())
                .collect();
            if parsed.len() != total {
                // 丢掉几个要记一笔：用户打开编辑器发现少了标签，却查不到线索，
                // 是很难排查的那类问题（PRD §3.9 Q-7）
                tracing::warn!(
                    dropped = total - parsed.len(),
                    total,
                    "会话里有标签无法解析：坏的丢弃、好的保留"
                );
            }
            parsed
        })
        .unwrap_or_default();
    let active_tab_id = v
        .get("activeTabId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    backup(path);
    sanitize(SessionState {
        tabs,
        active_tab_id,
    })
}

/// 写到指定文件（测试入口）
pub fn save_to(path: &Path, state: &SessionState) -> AppResult<SessionState> {
    let clean = sanitize(state.clone());
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    // 紧凑 JSON：会话可能含大段未保存正文，pretty 会白白撑大文件
    let json = serde_json::to_string(&clean)
        .map_err(|e| AppError::Session(format!("会话序列化失败：{e}")))?;
    // 原子写：临时文件 + rename（Windows 上 `fs::rename` 也会覆盖已存在文件）
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes())?;
    fs::rename(&tmp, path)?;
    tracing::debug!(path = %path.display(), tabs = clean.tabs.len(), "会话已保存");
    Ok(clean)
}

/// 从指定路径清除（测试入口）
pub fn clear_at(path: &Path) -> AppResult<()> {
    for p in [
        path.to_path_buf(),
        path.with_extension("json.bad"),
        path.with_extension("json.tmp"),
    ] {
        match fs::remove_file(&p) {
            Ok(()) => tracing::debug!(path = %p.display(), "已删除会话文件"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Session(format!("删除失败：{e}"))),
        }
    }
    Ok(())
}

/// 把坏文件另存为 `<name>.bad`（保留现场供排查）
fn backup(path: &Path) {
    let bad = path.with_extension("json.bad");
    if let Err(e) = fs::copy(path, &bad) {
        tracing::debug!(error = %e, "会话备份失败（忽略）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 每个用例一个独立临时目录（不依赖 tempfile：核心层保持零新增依赖）
    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aiotext-session-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join(SESSION_FILE)
    }

    fn tab(id: &str) -> SessionTab {
        SessionTab {
            id: id.to_owned(),
            file_path: None,
            file_name: format!("{id}.txt"),
            content: Some("正文".to_owned()),
            encoding: "utf-8".to_owned(),
            line_ending: "lf".to_owned(),
            had_bom: false,
            dirty: true,
            cursor_line: 3,
            cursor_column: 5,
        }
    }

    #[test]
    fn default_session_is_empty() {
        let s = SessionState::default();
        assert!(s.tabs.is_empty());
        assert_eq!(s.active_tab_id, None);
    }

    #[test]
    fn missing_file_yields_empty_session() {
        let p = temp_path("missing");
        assert_eq!(load_from(&p), SessionState::default());
    }

    #[test]
    fn round_trip_keeps_saved_and_unsaved_tabs() {
        let p = temp_path("roundtrip");
        let state = SessionState {
            tabs: vec![
                SessionTab {
                    content: None, // 已保存：靠路径重读
                    file_path: Some("D:/work/a.txt".to_owned()),
                    dirty: false,
                    ..tab("t1")
                },
                tab("t2"),
            ],
            active_tab_id: Some("t2".to_owned()),
        };
        let written = save_to(&p, &state).unwrap();
        assert_eq!(written, state);
        assert_eq!(load_from(&p), state);
    }

    #[test]
    fn save_is_atomic_and_leaves_no_tmp() {
        let p = temp_path("atomic");
        save_to(
            &p,
            &SessionState {
                tabs: vec![tab("t1")],
                active_tab_id: Some("t1".into()),
            },
        )
        .unwrap();
        assert!(p.exists());
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn json_is_camel_case_and_compact() {
        let p = temp_path("shape");
        save_to(
            &p,
            &SessionState {
                tabs: vec![tab("t1")],
                active_tab_id: Some("t1".into()),
            },
        )
        .unwrap();
        let raw = fs::read_to_string(&p).unwrap();
        assert!(raw.contains("\"activeTabId\""), "raw={raw}");
        assert!(raw.contains("\"filePath\""), "raw={raw}");
        assert!(raw.contains("\"lineEnding\""), "raw={raw}");
        assert!(!raw.contains('\n'), "会话应写紧凑 JSON");
    }

    #[test]
    fn broken_json_falls_back_and_backs_up() {
        let p = temp_path("broken");
        fs::write(&p, "{ this is not json").unwrap();
        assert_eq!(load_from(&p), SessionState::default());
        assert!(p.with_extension("json.bad").exists());
    }

    #[test]
    fn one_bad_tab_does_not_lose_the_others() {
        let p = temp_path("partly_bad");
        // 第一个标签的 cursorLine 是字符串 → 该标签反序列化失败，应被丢掉
        fs::write(
            &p,
            r#"{"tabs":[{"id":"bad","cursorLine":"x"},{"id":"good","fileName":"g.txt","dirty":true,"content":"正文"}],"activeTabId":"good"}"#,
        )
        .unwrap();
        let s = load_from(&p);
        assert_eq!(s.tabs.len(), 1, "坏标签应被丢弃");
        assert_eq!(s.tabs[0].id, "good");
        assert_eq!(s.tabs[0].content.as_deref(), Some("正文"));
        assert_eq!(s.active_tab_id.as_deref(), Some("good"));
        assert!(p.with_extension("json.bad").exists(), "坏文件应留备份");
    }

    #[test]
    fn unknown_line_ending_falls_back_to_lf() {
        let s = sanitize(SessionState {
            tabs: vec![SessionTab {
                line_ending: "crlf\r\n".to_owned(),
                ..tab("t1")
            }],
            active_tab_id: None,
        });
        assert_eq!(s.tabs[0].line_ending, "lf");
    }

    #[test]
    fn cursor_is_clamped_to_at_least_one() {
        let s = sanitize(SessionState {
            tabs: vec![SessionTab {
                cursor_line: 0,
                cursor_column: 0,
                ..tab("t1")
            }],
            active_tab_id: None,
        });
        assert_eq!((s.tabs[0].cursor_line, s.tabs[0].cursor_column), (1, 1));
    }

    #[test]
    fn blank_id_tab_is_dropped() {
        let s = sanitize(SessionState {
            tabs: vec![
                SessionTab {
                    id: "   ".to_owned(),
                    ..tab("t1")
                },
                tab("keep"),
            ],
            active_tab_id: None,
        });
        assert_eq!(s.tabs.len(), 1);
        assert_eq!(s.tabs[0].id, "keep");
    }

    #[test]
    fn blank_file_path_becomes_none_and_name_falls_back() {
        let s = sanitize(SessionState {
            tabs: vec![SessionTab {
                file_path: Some("   ".to_owned()),
                file_name: "".to_owned(),
                ..tab("t1")
            }],
            active_tab_id: None,
        });
        assert_eq!(s.tabs[0].file_path, None);
        assert_eq!(s.tabs[0].file_name, "未命名");
    }

    #[test]
    fn active_tab_falls_back_when_missing_or_stale() {
        // 指向不存在的标签 → 回落第一个
        let s = sanitize(SessionState {
            tabs: vec![tab("a"), tab("b")],
            active_tab_id: Some("nope".to_owned()),
        });
        assert_eq!(s.active_tab_id.as_deref(), Some("a"));

        // 没有任何标签 → None
        let s = sanitize(SessionState {
            tabs: vec![],
            active_tab_id: Some("x".to_owned()),
        });
        assert_eq!(s.active_tab_id, None);
    }

    #[test]
    fn clear_removes_file_and_backups() {
        let p = temp_path("clear");
        save_to(
            &p,
            &SessionState {
                tabs: vec![tab("t1")],
                active_tab_id: None,
            },
        )
        .unwrap();
        fs::write(p.with_extension("json.bad"), "old").unwrap();
        clear_at(&p).unwrap();
        assert!(!p.exists());
        assert!(!p.with_extension("json.bad").exists());
    }

    #[test]
    fn save_creates_missing_parent_dir() {
        let dir =
            std::env::temp_dir().join(format!("aiotext-session-mkdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let p = dir.join("nested").join(SESSION_FILE);
        save_to(
            &p,
            &SessionState {
                tabs: vec![tab("t1")],
                active_tab_id: None,
            },
        )
        .unwrap();
        assert!(p.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
