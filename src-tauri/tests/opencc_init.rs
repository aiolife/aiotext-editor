//! OpenCC 数据目录的**并发**首次初始化。
//!
//! 这条用例独占一个测试二进制：只有这样它才是该进程里第一次调用 `data_dir()`，
//! 才走得到「多个线程同时抢着铺数据」那条路径 —— 那正是 macOS runner 上
//! `convert_contract` 挂掉的地方（`tests/convert_contract.rs:98`）。
//!
//! 当时的写法有两个洞：
//! 1. `if target.exists() { continue }` —— 别的线程正在写时文件已经存在，
//!    跳过之后就拿着半截字典去 `opencc_open`；
//! 2. `fs::write` 不是原子的，读到半截 JSON 同样会让加载失败。
//!
//! 修法是初始化加锁 + 原子写。这里用 8 个线程同时首启来做回归。

use aiotext_editor_lib::core::opencc::{self, Direction};

#[test]
fn concurrent_first_init_yields_complete_files() {
    let handles: Vec<_> = (0..8)
        .map(|_| {
            std::thread::spawn(|| {
                // 第一次由某个线程真正铺盘，其余线程要么等锁、要么复用
                let dir = opencc::data_dir().expect("数据目录初始化");
                // 铺完之后每个文件都必须是完整的，才可能被 opencc 正确加载
                for data in opencc::all_data() {
                    let path = dir.join(data.file_name);
                    let size = std::fs::metadata(&path).expect("数据文件应存在").len();
                    assert_eq!(size, data.content.len() as u64, "{} 不完整", data.file_name);
                }
                let out =
                    opencc::convert(&Direction::S2T, "软件的发展").expect("并发初始化后应能转换");
                (dir.to_path_buf(), out)
            })
        })
        .collect();

    let mut dirs = Vec::new();
    for handle in handles {
        let (dir, out) = handle.join().expect("线程不应 panic");
        // S2T 只做字形转换（软件 → 軟件）；軟體 是台湾用语，属 S2TWP
        assert_eq!(out, "軟件的發展");
        dirs.push(dir);
    }
    // 所有线程必须用同一个目录（否则每个线程各铺一份，pid 目录会重复）
    assert!(
        dirs.windows(2).all(|w| w[0] == w[1]),
        "并发初始化分裂成多个目录"
    );
}
