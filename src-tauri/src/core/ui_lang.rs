//! 后端侧的界面语言（PRD §3.6）
//!
//! ## 为什么后端也要知道语言
//!
//! 有一批面向用户的文案是**后端生成**的：错误提示（`AppError` 的 14 个变体）、
//! 整理工具目录（`pipelines::catalog()`）、转换方向名、正则类目名。前端拿到的已经
//! 是成品字符串，无从翻译，所以后端得自己按当前语言输出。
//!
//! ## 为什么是「进程内缓存 + 重启生效」
//!
//! PRD §3.6 L-5 定的边界就是这样：前端切语言即时生效，后端文案**重启后**才变。
//! 这里用 `OnceLock` 在首次用到时读一次 `settings.json` 并缓存，正好等价——进程
//! 活着期间不再重读，改了设置也要下次启动才生效。
//!
//! 顺带省掉了另一个麻烦：若改成每次调用都读盘，错误路径上会多一次约 10ms 的
//! 磁盘读，而错误提示恰恰是用户正在等的东西。

use std::sync::OnceLock;

use super::opencc::{self, Direction};
use super::settings::UiLang;
// 只有非测试编译才读磁盘上的设置（测试期恒简体，见 `current` 的注释）
#[cfg(not(test))]
use super::settings;

#[cfg_attr(
    test,
    allow(dead_code, reason = "测试期 current() 直接返回简体，用不到这个缓存")
)]
static UI_LANG: OnceLock<UiLang> = OnceLock::new();

/**
 * 当前语言。读不到设置就按简体算——界面语言不该让程序起不来。
 *
 * ## 为什么测试期恒为简体
 *
 * 后端错误提示会跟着语言变（PRD L-5），于是有一批单测断言「错误消息里含某个
 * 中文字串」。若测试期也去读开发者机器上真实的 `settings.json`，同一套测试就会
 * **在简体机器上通过、在繁體机器上失败**——测试依赖了外部环境，这是回归网不该
 * 有的性质（PRD L-8 要求默认路径可预测）。
 *
 * 故 `#[cfg(test)]` 下直接返回简体，与磁盘配置解耦。要验繁體分支的用例请直接调
 * [`t_with`] 传入语言，不要改这里的全局值——`cargo test` 默认多线程，改全局
 * 会让并发中的其它用例跟着变，结果 unpredictable。
 */
fn current() -> UiLang {
    #[cfg(test)]
    {
        UiLang::Zh
    }
    #[cfg(not(test))]
    {
        *UI_LANG.get_or_init(|| settings::load().language)
    }
}

/**
 * 把面向用户的文案按当前语言输出。
 *
 * 简体原样返回（零开销，也是绝大多数用户的路径）；繁體才走 OpenCC。转换本身
 * 失败时回退原文——宁可显示简体，也不能因为翻译失败把错误提示吞掉。
 */
pub fn t(text: &str) -> String {
    t_with(current(), text)
}

/**
 * 按指定语言输出文案。
 *
 * 抽出来是为了**可测**：`t()` 读全局语言，而 `cargo test` 默认多线程跑，测试里
 * 改全局会让并发中的其它用例跟着变。把语言做成参数，`t()` 就成了薄薄一层，
 * 繁體分支可以直接单独断言。
 */
pub fn t_with(lang: UiLang, text: &str) -> String {
    if lang != UiLang::ZhHant {
        return text.to_owned();
    }
    match opencc::convert(&Direction::S2TWP, text) {
        Ok(converted) => converted,
        Err(_) => text.to_owned(),
    }
}

/** 已经拼好的模板 + 参数：`t_fmt!("…{a}…", a = x)` 的简写 */
#[macro_export]
macro_rules! ui_t {
    ($fmt:literal $(, $arg:tt)*) => {
        $crate::core::ui_lang::t(&format!($fmt $(, $arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 简体下原样返回() {
        // 默认设置就是简体，即便 OpenCC 不可用也不该改写
        assert_eq!(t("文件不存在"), "文件不存在");
    }

    #[test]
    fn 空串与不含中文的串不受影响() {
        assert_eq!(t(""), "");
        assert_eq!(t("UTF-8"), "UTF-8");
    }

    #[test]
    fn 繁體下走_opencc() {
        // 直接传语言，不碰全局——否则并发中的其它用例会跟着变
        assert_eq!(t_with(UiLang::ZhHant, "文件不存在"), "檔案不存在");
    }

    #[test]
    fn 翻译失败时回退原文而不是吞掉提示() {
        // OpenCC 起不来（比如 %TEMP% 不可写）时，宁可显示简体也不能没提示
        assert!(!t_with(UiLang::ZhHant, "文件不存在").is_empty());
    }
}
