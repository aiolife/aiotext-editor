//! 拖拽打开文件：进程参数里的路径解析（PRD §3.8）
//!
//! 拖拽有**两个入口**，走的是两条完全不同的路：
//!
//! | 入口 | 路径从哪来 | 谁解析 |
//! |------|-----------|--------|
//! | 拖到 exe 图标 | Windows 把路径作为**进程参数**给出 | 本模块（Rust） |
//! | 拖到界面 | Tauri emit `tauri://drag-drop`，payload 里**直接是路径数组** | 前端 |
//!
//! 但两边都要遵守同一组规则（剥引号、滤掉文件夹），故把规则集中在这里，
//! 界面的那条也复用了 [`unquote`] 之外的逻辑——只在前端调 `:memory:` 之前过滤。
//! 具体地说：**保留哪些文件**这件事两边一致（只留存在的普通文件）。

use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// 剥掉 Windows Shell 给带空格路径裹的双引号（PRD Why-D-3）
///
/// 拖到 exe 时 Shell 传来的可能是 `"C:\my dir\a.txt"`（连引号一起），不剥掉就会去
/// 打开一个名为 `"C:\my` 的文件，必然失败且错误信息让人摸不着头脑。
///
/// 只有**成对**出现才剥——单边引号说明它是路径真实的一部分，别自作聪明。
pub fn unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    match trimmed.strip_prefix('"') {
        Some(inner) => match inner.strip_suffix('"') {
            Some(stripped) => stripped.to_owned(),
            None => trimmed.to_owned(),
        },
        None => trimmed.to_owned(),
    }
}

/// 从一串原始路径里挑出**要打开的普通文件**。
///
/// 过滤规则与 PRD 一致：
/// - **文件夹无声忽略**（D-4）：`is_file()` 对目录返回 false；
/// - 不存在的路径同样丢掉——启动参数里可能混着 Tauri 内部参数，不必让用户看到报错；
/// - **二进制文件照常保留**（D-5）：不预判内容，与菜单「打开」同一套规则。
pub fn keep_openable<P: AsRef<Path>>(raw: &[P]) -> Vec<String> {
    raw.iter()
        .map(|p| p.as_ref())
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// 从进程参数里取出要打开的文件。
///
/// **必须跳过 `argv[0]`**：那是本程序自己的 exe 路径，而它恰好也是一个存在的
/// 普通文件——不跳过就会把应用自己当文本文档打开（读出一屏乱码二进制）。
pub fn files_from_argv(argv: &[String]) -> Vec<String> {
    let rest: Vec<String> = argv.iter().skip(1).map(|a| unquote(a)).collect();
    keep_openable(&rest)
}

/// 本次启动时被拖到图标上的文件
static STARTUP_FILES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn slot() -> &'static Mutex<Vec<String>> {
    STARTUP_FILES.get_or_init(|| Mutex::new(Vec::new()))
}

/// 记下启动参数里的待打开文件（在 `setup` 之前调用一次）
pub fn remember_startup_files(files: Vec<String>) {
    let mut guard = slot()
        .lock()
        .expect("只在赋值瞬间持锁，不会 panic（PRD §3.7 R-1 的口径）");
    *guard = files;
}

/// 前端启动后**主动来取**，取走即清空。
///
/// 之所以不用「Rust emit → 前端 listen」：`run()` 里 emit 的时刻，前端很可能还没
/// 注册监听，事件就丢了。让前端主动拉，顺序就确定了（PRD §3.8 落地口径）。
pub fn take_startup_files() -> Vec<String> {
    let mut guard = slot()
        .lock()
        .expect("只在取值的瞬间持锁，不会 panic（PRD §3.7 R-1 的口径）");
    std::mem::take(&mut *guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquote_strips_matched_quotes() {
        assert_eq!(unquote(r#""C:\my dir\a.txt""#), r"C:\my dir\a.txt");
    }

    #[test]
    fn unquote_leaves_unpaired_alone() {
        // 只有单边引号 → 不当成包裹，原样保留
        assert_eq!(unquote(r#""C:\weird"#), r#""C:\weird"#);
        assert_eq!(unquote("plain.txt"), "plain.txt");
    }

    #[test]
    fn unquote_leaves_nested_quoted_body_intact() {
        // 内容里还有引号也别乱剥：只剥最外一层
        assert_eq!(unquote(r#""a"b""#), r#"a"b"#);
    }

    #[test]
    fn files_from_argv_skips_program_itself() {
        // argv[0] 是程序自己，必须跳过——否则会把 exe 当文本打开。
        // 这里得造一个**真实存在**的文件：`keep_openable` 会滤掉不存在的路径。
        let real =
            std::env::temp_dir().join(format!("aiotext-dragdrop-argv-{}.txt", std::process::id()));
        std::fs::write(&real, b"hi").expect("临时文件应可写");

        let argv = vec![
            r"C:\Program Files\AioText\AioTextEditor.exe".to_owned(),
            real.to_string_lossy().into_owned(),
        ];
        let got = files_from_argv(&argv);
        let _ = std::fs::remove_file(&real);

        assert_eq!(got.len(), 1, "只应剩 argv[1]：{got:?}");
        assert!(got[0].ends_with(".txt"), "不应把 argv[0] 当成要打开的文件");
    }

    #[test]
    fn keep_openable_drops_directories_and_missing() {
        let temp = std::env::temp_dir().join("aiotext-dragdrop-test");
        let _ = std::fs::create_dir_all(&temp);
        let dir = keep_openable(std::slice::from_ref(&temp));
        assert!(dir.is_empty(), "目录应被无声忽略（D-4）");
        let missing = keep_openable(&[temp.join("nope-nope.txt")]);
        assert!(missing.is_empty(), "不存在的路径应被丢掉");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn take_startup_files_is_take_not_peek() {
        remember_startup_files(vec!["a.txt".into(), "b.txt".into()]);
        assert_eq!(take_startup_files().len(), 2);
        // 取第二次必须为空：否则用户拖一次会反复打开
        assert!(take_startup_files().is_empty());
    }
}
