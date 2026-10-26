//! core 层：纯 Rust 算法核心（不依赖 Tauri，独立可单测）

pub mod batch;
pub mod compare;
pub mod convert;
pub mod data_tables;
/// 拖拽打开文件：进程参数里的路径解析（PRD §3.8）
pub mod dragdrop;
pub mod embedded;
pub mod encoding;
pub mod merge;
pub mod opencc;
pub mod paths;
pub mod pipelines;
pub mod regex;
pub mod replace;
pub mod session;
pub mod settings;
pub mod text_diff;
pub mod ui_lang;
