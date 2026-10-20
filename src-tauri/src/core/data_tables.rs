//! TextPro 异体字组表加载（F-06 §6.5）
//!
//! 数据文件为开放文本格式（见 docs/06-data-dictionary.md）：每行一个
//! 异体字组（组内字符视作等同），UTF-8 with BOM：
//!
//! - `data/legacy/fc1.txt` —— **完全等同**（音义全同，如「兔兎」「伪偽僞」），
//!   比较 `VariantStrictness::FullEq` 时启用；
//! - `data/legacy/fc2.txt` —— **部分等同**（部分相同，如「㒓达達」），
//!   `VariantStrictness::PartialEq` 时在 fc1 之外追加启用。
//!
//! 同一字符出现在多个组时按**首次出现**的组为准（TextPro 语义未定义，
//! 取稳定结果）；加载结果经 `OnceLock` 缓存，进程内只读一次。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{AppError, AppResult};

/// 随安装包分发的资源子目录（与 `tauri.conf.json` 的 resources 对应）
pub const LEGACY_RESOURCE_SUBDIR: &str = "data/legacy";
/// 完全等同组表文件名
pub const FULL_VARIANT_FILE: &str = "fc1.txt";
/// 部分等同组表文件名
pub const PARTIAL_VARIANT_FILE: &str = "fc2.txt";

/// 异体字组表：字符 → 组号（组号从 1 起，按表中出现顺序）
#[derive(Debug, Default)]
pub struct VariantTables {
    full: HashMap<char, u32>,
    partial: HashMap<char, u32>,
}

impl VariantTables {
    /// 完全等同组号（fc1.txt）
    pub fn full_group(&self, ch: char) -> Option<u32> {
        self.full.get(&ch).copied()
    }

    /// 部分等同组号（fc2.txt）
    pub fn partial_group(&self, ch: char) -> Option<u32> {
        self.partial.get(&ch).copied()
    }

    pub fn full_group_count(&self) -> usize {
        self.full.values().max().map(|id| *id as usize).unwrap_or(0)
    }

    pub fn partial_group_count(&self) -> usize {
        self.partial
            .values()
            .max()
            .map(|id| *id as usize)
            .unwrap_or(0)
    }
}

/// 资源目录探测：打包资源 → 开发态 manifest → 可执行文件同级 → **内嵌展开**
///
/// 最后一项是便携版专用：单 exe 旁边没有 `data/`，这时从编进二进制的字节里
/// 展开一份（`embedded` 模块）。安装版磁盘上就有，走不到这一步。
fn legacy_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    use crate::core::embedded;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(LEGACY_RESOURCE_SUBDIR));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(LEGACY_RESOURCE_SUBDIR));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(LEGACY_RESOURCE_SUBDIR));
        }
    }
    candidates.extend(embedded::expand(
        "legacy",
        &[
            (FULL_VARIANT_FILE, embedded::LEGACY_FC1),
            (PARTIAL_VARIANT_FILE, embedded::LEGACY_FC2),
        ],
    ));
    candidates.into_iter().find(|p| p.is_dir())
}

/// 解析一张组表：每行一个组，行内字符依次登记；返回组数
fn parse_groups(text: &str, map: &mut HashMap<char, u32>) -> usize {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut group = 0u32;
    for line in text.lines() {
        let chars: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
        if chars.len() < 2 {
            // 单字符行没有「等同」语义，空行 / 注释行同样跳过
            continue;
        }
        group += 1;
        for &ch in &chars {
            // 首次出现的组生效（同一字符可能出现在多个组）
            map.entry(ch).or_insert(group);
        }
    }
    group as usize
}

/// 从磁盘加载两张组表
pub fn load_variant_tables(resource_dir: Option<&Path>) -> AppResult<VariantTables> {
    let dir = legacy_dir(resource_dir)
        .ok_or_else(|| AppError::Compare("未找到异体字组表目录（data/legacy 缺失）".into()))?;
    let read = |name: &str| -> AppResult<String> {
        let path = dir.join(name);
        std::fs::read_to_string(&path)
            .map_err(|e| AppError::Compare(format!("读取 {} 失败：{e}", path.display())))
    };
    let mut full = HashMap::new();
    let mut partial = HashMap::new();
    parse_groups(&read(FULL_VARIANT_FILE)?, &mut full);
    parse_groups(&read(PARTIAL_VARIANT_FILE)?, &mut partial);
    if full.is_empty() || partial.is_empty() {
        return Err(AppError::Compare(
            "异体字组表为空，数据文件可能已损坏".into(),
        ));
    }
    Ok(VariantTables { full, partial })
}

static TABLES: OnceLock<VariantTables> = OnceLock::new();

/// 取进程级缓存的组表（首次调用时加载；后续调用忽略传入目录）
pub fn get_variant_tables(resource_dir: Option<&Path>) -> AppResult<&'static VariantTables> {
    if let Some(tables) = TABLES.get() {
        return Ok(tables);
    }
    let loaded = load_variant_tables(resource_dir)?;
    Ok(TABLES.get_or_init(|| loaded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_tables_load_with_expected_size() {
        // 数据字典 §1.3：fc1 = 1003 组；fc2 共 10579 行，其中 6 行为
        // 空行 / 单字符（单字符构不成「等同」语义，解析时跳过）→ 10573 组
        let tables = load_variant_tables(None).unwrap();
        assert_eq!(tables.full_group_count(), 1003);
        assert_eq!(tables.partial_group_count(), 10579 - 6);
    }

    #[test]
    fn known_variant_groups_are_recognized() {
        let tables = load_variant_tables(None).unwrap();
        // fc1 样例行：兔兎 / 伪偽僞（完全等同）
        assert_eq!(tables.full_group('兔'), tables.full_group('兎'));
        assert_eq!(tables.full_group('伪'), tables.full_group('偽'));
        assert!(tables.full_group('伪').is_some());
        // fc2 样例行：㒓达達（部分等同）；fc1 中没有「达」
        assert_eq!(tables.partial_group('达'), tables.partial_group('達'));
        assert!(tables.partial_group('达').is_some());
        assert!(tables.full_group('达').is_none());
        // 「达」按首次出现的组登记（㒓达達 在 達达㒓迭 之前）
        assert_eq!(tables.partial_group('达'), tables.partial_group('㒓'));
    }

    #[test]
    fn parse_groups_strips_bom_and_takes_first_occurrence() {
        // 子模块可直接访问私有解析函数：用合成数据锁定解析语义
        let mut map = std::collections::HashMap::new();
        let text = "\u{feff}甲乙\n  \n单\n丙甲\n";
        let groups = parse_groups(text, &mut map);
        assert_eq!(groups, 2, "空行与单字符行不构成组");
        assert_eq!(map.get(&'甲'), map.get(&'乙'));
        assert_eq!(map.get(&'甲'), Some(&1), "首次出现生效（第二组的甲不覆盖）");
        assert_eq!(map.get(&'丙'), Some(&2));
    }

    #[test]
    fn cached_instance_is_stable() {
        let a = get_variant_tables(None).unwrap();
        let b = get_variant_tables(None).unwrap();
        assert!(std::ptr::eq(a, b));
    }
}
