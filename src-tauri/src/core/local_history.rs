//! 本地历史（PRD §3.12）——纯 Rust 存储核心，不依赖 Tauri。
//!
//! ## 为什么路径映射放在这里
//!
//! 前端只传「真实文件路径」，`normalize_path` + `docs.json` 把它折成一个安全且
//! 跨重启稳定的 `docId`。这样 Windows 的大小写 / UNC / 斜杠差异不会造出两份历史，
//! 也不必依赖 `tab.id`（`tab-N` 每次启动都会重新计数）。
//!
//! ## 布局
//!
//! ```text
//! <app_data>/local-history/
//!   docs.json            # { "<规范化路径>": "d1", ... }
//!   d1/
//!     index.json         # SnapshotMeta[]，列表只读元数据
//!     <id>.snap          # UTF-8 纯文本，内部统一 LF
//! ```
//!
//! 所有写入走 tmp + rename；坏索引先备份成 `.bad`，再从磁盘上的 `.snap` 重建，
//! **绝不静默当成空历史**。`total_bytes` 按真实文件统计，孤儿快照也计入上限。

use crate::core::paths;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 1;
const DOCS_FILE: &str = "docs.json";
const INDEX_FILE: &str = "index.json";
const SNAP_EXT: &str = "snap";

/// 列表用元数据。内容不进索引，避免把全量正文捞到前端再过滤。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: String,
    pub ts: i64,
    pub trigger: String,
    pub label: Option<String>,
    pub hash: String,
    /// 内容字节数（UTF-8）
    pub size: u64,
    pub schema_version: u32,
    /// 是否已成功保存到磁盘（最近一条 committed 受淘汰保护）
    pub committed: bool,
    /// 用户置顶，永不自动淘汰
    pub pinned: bool,
    /// 以下三项是 aiotext 特有：恢复后再次保存要逐字节一致
    pub encoding: String,
    pub had_bom: bool,
    pub line_ending: String,
}

/// 写入入参。前端不传 docId，只传真实路径。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInput {
    pub path: String,
    pub id: String,
    pub ts: i64,
    pub trigger: String,
    pub label: Option<String>,
    pub hash: String,
    pub size: u64,
    pub schema_version: u32,
    pub committed: bool,
    pub pinned: bool,
    pub encoding: String,
    pub had_bom: bool,
    pub line_ending: String,
    pub content: String,
}

impl SnapshotInput {
    fn meta(&self) -> SnapshotMeta {
        SnapshotMeta {
            id: self.id.clone(),
            ts: self.ts,
            trigger: self.trigger.clone(),
            label: self.label.clone(),
            hash: self.hash.clone(),
            size: self.size,
            schema_version: self.schema_version,
            committed: self.committed,
            pinned: self.pinned,
            encoding: self.encoding.clone(),
            had_bom: self.had_bom,
            line_ending: self.line_ending.clone(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPatch {
    pub pinned: Option<bool>,
    pub committed: Option<bool>,
    pub label: Option<String>,
}

type DocMap = HashMap<String, String>;

fn err(ctx: &str, e: impl std::fmt::Display) -> AppError {
    AppError::LocalHistory(format!("{ctx}：{e}"))
}

/// 用户数据目录下的本地历史根。返回错误而非静默用相对路径。
pub fn base_dir() -> AppResult<PathBuf> {
    let root = paths::app_data_dir()
        .ok_or_else(|| AppError::LocalHistory("无法定位用户数据目录".to_owned()))?;
    Ok(root.join("local-history"))
}

/// 只允许安全字符，阻断 docId / 快照 id 的路径穿越。
pub fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::LocalHistory(format!("非法历史 id：{id}")));
    }
    Ok(())
}

/// 路径规范化：canonicalize 去掉相对 / 大小写差异，去 UNC 前缀，统一分隔符。
/// Windows 下大小写不敏感，故折叠为小写；文件不存在时退回字符串规范化。
pub fn normalize_path(path: &str) -> String {
    let resolved = fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned());
    let stripped = resolved
        .strip_prefix(r"\\?\")
        .unwrap_or(&resolved)
        .to_owned();
    let unified = stripped.replace('\\', "/").trim_end_matches('/').to_owned();
    if cfg!(windows) {
        unified.to_lowercase()
    } else {
        unified
    }
}

/// tmp + rename，保证写到一半退出不会留下半截快照或半截索引。
fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| err("创建本地历史目录", e))?;
    }
    // 追加 .tmp 而不是 with_extension("tmp")：不同扩展名的文件不会抢同一个临时名。
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    {
        let mut file = fs::File::create(&tmp).map_err(|e| err("创建临时文件", e))?;
        file.write_all(bytes).map_err(|e| err("写临时文件", e))?;
        file.sync_all().map_err(|e| err("同步临时文件", e))?;
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path).map_err(|e| err("替换目标文件", e))?;
    }
    Ok(())
}

fn backup_bad(path: &Path) {
    let bad = PathBuf::from(format!("{}.bad", path.display()));
    let _ = fs::remove_file(&bad);
    let _ = fs::rename(path, &bad);
}

/// 文件不存在 / 解析失败都返回 `None`；解析失败会先把坏文件备份成 `.bad`。
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<T>(&raw) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                backup_bad(path);
                Ok(None)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err("读取 JSON", e)),
    }
}

fn load_docs(base: &Path) -> AppResult<DocMap> {
    Ok(read_json::<DocMap>(&base.join(DOCS_FILE))?.unwrap_or_default())
}

fn save_docs(base: &Path, docs: &DocMap) -> AppResult<()> {
    let json = serde_json::to_string(docs).map_err(|e| err("序列化路径映射", e))?;
    atomic_write(&base.join(DOCS_FILE), json.as_bytes())
}

/// 查已有映射；不会新建条目（清除路径用，避免给没历史的文件留下空条目）。
fn existing_doc_key(base: &Path, path: &str) -> AppResult<Option<String>> {
    let key = normalize_path(path);
    Ok(load_docs(base)?.get(&key).cloned())
}

/// 取（或建立）稳定的安全 docId。
pub fn doc_key(base: &Path, path: &str) -> AppResult<String> {
    let key = normalize_path(path);
    let mut docs = load_docs(base)?;
    if let Some(id) = docs.get(&key) {
        return Ok(id.clone());
    }
    let used: HashSet<String> = docs.values().cloned().collect();
    let mut n = docs.len() + 1;
    while used.contains(&format!("d{n}")) {
        n += 1;
    }
    let id = format!("d{n}");
    docs.insert(key, id.clone());
    save_docs(base, &docs)?;
    Ok(id)
}

fn doc_dir(base: &Path, id: &str, create: bool) -> AppResult<PathBuf> {
    validate_id(id)?;
    let dir = base.join(id);
    if create {
        fs::create_dir_all(&dir).map_err(|e| err("创建文档历史目录", e))?;
    }
    Ok(dir)
}

fn write_dir(base: &Path, path: &str) -> AppResult<PathBuf> {
    let id = doc_key(base, path)?;
    doc_dir(base, &id, true)
}

fn read_dir_for(base: &Path, path: &str) -> AppResult<Option<PathBuf>> {
    match existing_doc_key(base, path)? {
        Some(id) => Ok(Some(doc_dir(base, &id, false)?)),
        None => Ok(None),
    }
}

/// 索引坏了 / 丢了就从磁盘上的 `.snap` 重建，历史不凭空消失。
fn rebuild_index(dir: &Path) -> AppResult<Vec<SnapshotMeta>> {
    let mut items = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(items),
        Err(e) => return Err(err("读取文档历史目录", e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| err("遍历历史目录", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some(SNAP_EXT) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| err("读取快照属性", e))?;
        let ts = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        items.push(SnapshotMeta {
            id: id.to_owned(),
            ts,
            trigger: "auto".to_owned(),
            label: Some("索引重建".to_owned()),
            size: meta.len(),
            schema_version: SCHEMA_VERSION,
            encoding: "utf-8".to_owned(),
            line_ending: "lf".to_owned(),
            ..SnapshotMeta::default()
        });
    }
    items.sort_by_key(|item| item.ts);
    Ok(items)
}

fn load_index(dir: &Path) -> AppResult<Vec<SnapshotMeta>> {
    match read_json::<Vec<SnapshotMeta>>(&dir.join(INDEX_FILE))? {
        Some(items) => Ok(items),
        None => {
            let rebuilt = rebuild_index(dir)?;
            if !rebuilt.is_empty() {
                save_index(dir, &rebuilt)?;
            }
            Ok(rebuilt)
        }
    }
}

fn save_index(dir: &Path, items: &[SnapshotMeta]) -> AppResult<()> {
    let json = serde_json::to_string(items).map_err(|e| err("序列化历史索引", e))?;
    atomic_write(&dir.join(INDEX_FILE), json.as_bytes())
}

fn snap_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.{SNAP_EXT}"))
}

// ---------------------------------------------------------------------------
// 对外 API（全部收 `&Path base`，便于用临时目录单测）
// ---------------------------------------------------------------------------

pub fn list(base: &Path, path: &str) -> AppResult<Vec<SnapshotMeta>> {
    let Some(dir) = read_dir_for(base, path)? else {
        return Ok(Vec::new());
    };
    let mut items = load_index(&dir)?;
    items.sort_by_key(|item| item.ts);
    Ok(items)
}

pub fn read(base: &Path, path: &str, id: &str) -> AppResult<Option<String>> {
    validate_id(id)?;
    let Some(dir) = read_dir_for(base, path)? else {
        return Ok(None);
    };
    match fs::read_to_string(snap_path(&dir, id)) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err("读取快照", e)),
    }
}

pub fn write(base: &Path, input: &SnapshotInput) -> AppResult<()> {
    validate_id(&input.id)?;
    let dir = write_dir(base, &input.path)?;
    atomic_write(&snap_path(&dir, &input.id), input.content.as_bytes())?;
    let meta = input.meta();
    let mut items = load_index(&dir)?;
    match items.iter().position(|item| item.id == meta.id) {
        Some(pos) => items[pos] = meta,
        None => items.push(meta),
    }
    items.sort_by_key(|item| item.ts);
    save_index(&dir, &items)
}

pub fn update(base: &Path, path: &str, id: &str, patch: &SnapshotPatch) -> AppResult<()> {
    validate_id(id)?;
    let Some(dir) = read_dir_for(base, path)? else {
        return Ok(());
    };
    let mut items = load_index(&dir)?;
    let Some(item) = items.iter_mut().find(|item| item.id == id) else {
        return Ok(());
    };
    if let Some(pinned) = patch.pinned {
        item.pinned = pinned;
    }
    if let Some(committed) = patch.committed {
        item.committed = committed;
    }
    if let Some(label) = &patch.label {
        item.label = Some(label.clone());
    }
    save_index(&dir, &items)
}

/// 返回**删除失败**的 id（NotFound 视为成功）。先删文件再写索引，
/// 保证不会出现「索引指向已删文件」。
pub fn remove(base: &Path, path: &str, ids: &[String]) -> AppResult<Vec<String>> {
    for id in ids {
        validate_id(id)?;
    }
    let Some(dir) = read_dir_for(base, path)? else {
        return Ok(Vec::new());
    };
    let mut failed = Vec::new();
    for id in ids {
        match fs::remove_file(snap_path(&dir, id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed.push(id.clone()),
        }
    }
    let removed: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let kept: Vec<SnapshotMeta> = load_index(&dir)?
        .into_iter()
        .filter(|item| !removed.contains(item.id.as_str()) || failed.contains(&item.id))
        .collect();
    save_index(&dir, &kept)?;
    Ok(failed)
}

/// `paths` 为空 = 清空全部（连 `docs.json` 一起删）。返回删除失败的路径。
pub fn clear(base: &Path, paths: &[String]) -> AppResult<Vec<String>> {
    if paths.is_empty() {
        if base.exists() {
            fs::remove_dir_all(base).map_err(|e| err("清空本地历史", e))?;
        }
        return Ok(Vec::new());
    }
    let mut failed = Vec::new();
    let mut docs = load_docs(base)?;
    for path in paths {
        let key = normalize_path(path);
        let Some(id) = docs.remove(&key) else {
            continue; // 本来就没有历史，无需新建映射
        };
        let dir = base.join(&id);
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                docs.insert(key, id); // 没删掉就把映射放回去，下次还能清
                failed.push(path.clone());
            }
        }
    }
    save_docs(base, &docs)?;
    Ok(failed)
}

/// 按真实 `.snap` 文件累加，孤儿快照也计入上限。
pub fn total_bytes(base: &Path) -> AppResult<u64> {
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(err("遍历本地历史根目录", e)),
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(inner) = fs::read_dir(entry.path()) {
            for file in inner.flatten() {
                let path = file.path();
                if path.extension().and_then(|s| s.to_str()) == Some(SNAP_EXT) {
                    if let Ok(meta) = file.metadata() {
                        total += meta.len();
                    }
                }
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "aiotext-lh-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn base(&self) -> &Path {
            &self.0
        }
        /// 建一个真实存在的文件，让 canonicalize 走成功路径
        fn file(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, b"seed").unwrap();
            path.to_string_lossy().into_owned()
        }
        fn first_doc_dir(&self) -> PathBuf {
            fs::read_dir(&self.0)
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .find(|p| p.is_dir())
                .unwrap()
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn input(path: &str, id: &str, ts: i64, content: &str) -> SnapshotInput {
        SnapshotInput {
            path: path.to_owned(),
            id: id.to_owned(),
            ts,
            trigger: "auto".to_owned(),
            label: None,
            hash: format!("hash-{id}"),
            size: content.len() as u64,
            schema_version: SCHEMA_VERSION,
            committed: false,
            pinned: false,
            encoding: "utf-8".to_owned(),
            had_bom: false,
            line_ending: "crlf".to_owned(),
            content: content.to_owned(),
        }
    }

    fn has_tmp(dir: &Path) -> bool {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
    }

    #[test]
    fn validate_id_blocks_traversal() {
        assert!(validate_id("ok-1_A").is_ok());
        for bad in ["", "../etc", "a/b", "a.b", &"x".repeat(129)] {
            assert!(validate_id(bad).is_err(), "{bad} 应当被拒绝");
        }
    }

    #[test]
    fn normalize_path_is_stable() {
        let d = TestDir::new();
        let path = d.file("Note.MD");
        let normalized = normalize_path(&path);
        assert_eq!(normalize_path(&path), normalized);
        assert!(!normalized.contains('\\'));
        if cfg!(windows) {
            assert_eq!(normalize_path(&normalized.to_uppercase()), normalized);
        }
    }

    #[test]
    fn write_list_read_round_trip_and_camel_case_index() {
        let d = TestDir::new();
        let path = d.file("note.md");
        write(d.base(), &input(&path, "s1", 1_000, "内容 A")).unwrap();
        write(d.base(), &input(&path, "s2", 2_000, "内容 B")).unwrap();

        let items = list(d.base(), &path).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "s1");
        assert_eq!(items[0].line_ending, "crlf");
        assert!(!items[0].had_bom);
        assert_eq!(
            read(d.base(), &path, "s1").unwrap().as_deref(),
            Some("内容 A")
        );

        let raw = fs::read_to_string(d.first_doc_dir().join(INDEX_FILE)).unwrap();
        assert!(raw.contains("\"schemaVersion\""));
        assert!(raw.contains("\"hadBom\""));
        assert!(raw.contains("\"lineEnding\""));
        assert!(!raw.contains("schema_version"));
        assert!(!raw.contains('\n')); // 紧凑 JSON
    }

    #[test]
    fn atomic_write_leaves_no_tmp() {
        let d = TestDir::new();
        let path = d.file("note.md");
        write(d.base(), &input(&path, "s1", 1_000, "内容")).unwrap();
        assert!(!has_tmp(&d.first_doc_dir()));
        assert!(!has_tmp(d.base()));
    }

    #[test]
    fn broken_index_is_backed_up_and_rebuilt() {
        let d = TestDir::new();
        let path = d.file("note.md");
        write(d.base(), &input(&path, "s1", 1_000, "内容")).unwrap();
        let dir = d.first_doc_dir();
        fs::write(dir.join(INDEX_FILE), "{broken").unwrap();

        let items = list(d.base(), &path).unwrap();
        assert_eq!(items.len(), 1, "坏索引不能把历史当空");
        assert_eq!(items[0].id, "s1");
        assert!(dir.join("index.json.bad").exists());
    }

    #[test]
    fn remove_keeps_index_consistent() {
        let d = TestDir::new();
        let path = d.file("note.md");
        write(d.base(), &input(&path, "s1", 1_000, "A")).unwrap();
        write(d.base(), &input(&path, "s2", 2_000, "B")).unwrap();
        let failed = remove(d.base(), &path, &["s1".to_owned()]).unwrap();
        assert!(failed.is_empty());
        let items = list(d.base(), &path).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "s2");
        assert!(!d.first_doc_dir().join("s1.snap").exists());
    }

    #[test]
    fn clear_batch_then_all() {
        let d = TestDir::new();
        let p1 = d.file("a.md");
        let p2 = d.file("b.md");
        write(d.base(), &input(&p1, "s1", 1_000, "A")).unwrap();
        write(d.base(), &input(&p2, "s2", 2_000, "B")).unwrap();

        assert!(clear(d.base(), &[p1.clone()]).unwrap().is_empty());
        assert!(list(d.base(), &p1).unwrap().is_empty());
        assert_eq!(list(d.base(), &p2).unwrap().len(), 1);

        assert!(clear(d.base(), &[]).unwrap().is_empty());
        assert!(!d.base().exists());
    }

    #[test]
    fn total_bytes_counts_real_files_including_orphans() {
        let d = TestDir::new();
        let path = d.file("note.md");
        write(d.base(), &input(&path, "s1", 1_000, "ABC")).unwrap();
        fs::write(d.first_doc_dir().join("orphan.snap"), b"12345").unwrap();
        assert_eq!(total_bytes(d.base()).unwrap(), 8);
    }

    #[test]
    fn doc_key_is_stable_and_reuses_mapping() {
        let d = TestDir::new();
        let path = d.file("note.md");
        let a = doc_key(d.base(), &path).unwrap();
        let b = doc_key(d.base(), &path).unwrap();
        assert_eq!(a, b);
        assert_eq!(existing_doc_key(d.base(), "never-opened.md").unwrap(), None);
    }
}
