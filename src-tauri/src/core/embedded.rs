//! 内嵌资源（Windows 便携版用）

//! ## 为什么需要它
//!
//! 便携版是**单个 exe**：双击直接运行、不安装、不写注册表。但应用运行时要读
//! 两个随安装包分发的目录 —— `data/legacy`（异体字组表，比较用）与
//! `data/builtin-tables`（内置替换表）。单 exe 旁边没有这两个目录，于是比较会报
//! 「未找到异体字组表目录」，内置替换表则是空的（只 warn，不崩）。
//!
//! 这里把它们编译进二进制（`include_bytes!`，合计约 0.13 MB）：磁盘上找不到
//! 资源目录时，从内嵌字节展开一份到临时目录再读。**安装版磁盘上有，永远走不到
//! 这条路径**，行为完全不变。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// 异体字组表（与 `data_tables::LEGACY_RESOURCE_SUBDIR` 对应）
pub const LEGACY_FC1: &[u8] = include_bytes!("../../data/legacy/fc1.txt");
pub const LEGACY_FC2: &[u8] = include_bytes!("../../data/legacy/fc2.txt");

/// 内置替换表（与 `replace::BUILTIN_RESOURCE_SUBDIR` 对应）
pub const BUILTIN_ANCIENT: &[u8] = include_bytes!("../../data/builtin-tables/ancient-usage.tab");
pub const BUILTIN_CN_PUNCT: &[u8] = include_bytes!("../../data/builtin-tables/cn-punct.tab");
pub const BUILTIN_SIMPLIFIED: &[u8] =
    include_bytes!("../../data/builtin-tables/simplified-variants.tab");

static EXPANDED: LazyLock<Mutex<HashMap<String, PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 把内嵌文件展开到临时目录，返回该目录
///
/// `files` 是 `(文件名, 内容)`；同一 `name` 在进程内只展开一次。
/// 展开失败（临时目录不可写）返回 `None`，调用方按「资源缺失」处理。
pub fn expand(name: &str, files: &[(&str, &[u8])]) -> Option<PathBuf> {
    let mut map = EXPANDED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = map.get(name) {
        return Some(dir.clone());
    }
    let dir = std::env::temp_dir().join(format!("aiotext-{name}-{}", std::process::id()));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, "内嵌资源目录创建失败");
        return None;
    }
    for (file, bytes) in files {
        if let Err(e) = write_atomic(&dir.join(file), bytes) {
            tracing::warn!(error = %e, file, "内嵌资源展开失败");
            return None;
        }
    }
    tracing::debug!(dir = %dir.display(), files = files.len(), "内嵌资源已展开");
    map.insert(name.to_owned(), dir.clone());
    Some(dir)
}

/// 原子写：先写同目录的临时文件，再 rename 覆盖
///
/// 首次展开可能被并发触发，直接 `fs::write` 会让人读到半截内容。
fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("data");
    let tmp = path.with_file_name(format!(
        ".{name}.{}-{:?}.tmp",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_writes_all_files() {
        let dir = expand("t-expand", &[("a.txt", b"AAA"), ("b.txt", b"BBB")]).expect("展开");
        assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"AAA");
        assert_eq!(std::fs::read(dir.join("b.txt")).unwrap(), b"BBB");
        // 同名第二次直接复用（进程内只展开一次）
        assert_eq!(expand("t-expand", &[("a.txt", b"AAA")]), Some(dir));
    }

    /// 内嵌字节必须与磁盘上的文件**逐字节一致**
    ///
    /// 这条守的是「数据改了却忘了重编」—— 那会让便携版与安装版行为不同，
    /// 而这种差异在本地跑起来几乎发现不了（本地磁盘上总有 data/）。
    #[test]
    fn embedded_matches_files_on_disk() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let read = |rel: &str| std::fs::read(root.join(rel)).expect(rel);
        assert_eq!(LEGACY_FC1, read("data/legacy/fc1.txt"), "fc1.txt 不同步");
        assert_eq!(LEGACY_FC2, read("data/legacy/fc2.txt"), "fc2.txt 不同步");
        assert_eq!(
            BUILTIN_ANCIENT,
            read("data/builtin-tables/ancient-usage.tab"),
            "ancient-usage.tab 不同步"
        );
        assert_eq!(
            BUILTIN_CN_PUNCT,
            read("data/builtin-tables/cn-punct.tab"),
            "cn-punct.tab 不同步"
        );
        assert_eq!(
            BUILTIN_SIMPLIFIED,
            read("data/builtin-tables/simplified-variants.tab"),
            "simplified-variants.tab 不同步"
        );
    }
}
