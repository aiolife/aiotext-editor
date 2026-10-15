//! 路径约定的单一来源
//!
//! 原先 `app_data_dir()` 长在 `core::replace` 里（它是最早需要落盘的用户数据 ——
//! 替换表），但 F-11 的 `settings.json` 也要用它，让「设置模块依赖替换表模块」
//! 显然是错的依赖方向。故提到本模块；`core::replace` 仍再导出该函数，
//! 既有调用路径 `core::replace::app_data_dir()` 不变。

use std::path::PathBuf;

/// 用户数据根目录（`%APPDATA%/AioTextEditor`、macOS `~/Library/Application Support/AioTextEditor`、Linux `~/.config/AioTextEditor`）
///
/// 返回 `None` 表示无法定位（环境变量缺失），调用方应给出明确错误而非静默用相对路径。
pub fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("AioTextEditor"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|p| PathBuf::from(p).join("Library/Application Support/AioTextEditor"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
            .map(|p| p.join("AioTextEditor"))
    }
}
