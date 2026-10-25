//! 应用错误类型
//!
//! ## 为什么手写 `Display` 而不用 thiserror 的 `#[error(...)]`
//!
//! 之前每个变体挂 `#[error("…")]` 属性，文案由宏展开成 `Display`。但 PRD §3.6
//! 要求后端生成的错误提示也要跟着界面语言变（L-5），而宏属性里**没法插翻译逻辑**。
//!
//! 手写 `Display` 之后，`e.to_string()` 自动走翻译——35 个 command 里那些
//! `.map_err(|e| e.to_string())` **一处都不用改**。这是本轮能只碰几个文件就收口的
//! 关键；反过来若改成给每个变体加 `localized()` 方法，就得改 35 处调用点。

use crate::core::ui_lang;

#[derive(Debug)]
pub enum AppError {
    Io(std::io::Error),
    InvalidPath(String),
    Unmappable { encoding: String, count: usize },
    OpenccInit(String),
    Convert(String),
    UnsupportedDirection(String),
    ReplaceTable(String),
    Regex(String),
    Pipeline(String),
    Compare(String),
    Merge(String),
    Batch(String),
    Settings(String),
    Session(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 每段前缀都是界面文案，交给 t()；`{0}` 载荷里既有用户数据（路径、编码名）
        // 也有下层错误——那些不该翻，所以只翻译外层模板会漏掉前缀里的中文字，
        // 这里干脆整条一起转：OpenCC 对 ASCII 与繁體原文都是幂等的。
        let text = match self {
            AppError::Io(e) => ui_lang::t(&format!("文件不存在或不可读：{e}")),
            AppError::InvalidPath(p) => ui_lang::t(&format!("路径无效：{p}")),
            AppError::Unmappable { encoding, count } => ui_lang::t(&format!(
                "文本含 {encoding} 不可编码字符 ×{count}，请选择处理策略"
            )),
            AppError::OpenccInit(s) => ui_lang::t(&format!("繁简引擎初始化失败：{s}")),
            AppError::Convert(s) => ui_lang::t(&format!("转换失败：{s}")),
            AppError::UnsupportedDirection(s) => ui_lang::t(&format!("转换方向不支持：{s}")),
            AppError::ReplaceTable(s) => ui_lang::t(&format!("替换表错误：{s}")),
            AppError::Regex(s) => ui_lang::t(&format!("正则表达式错误：{s}")),
            AppError::Pipeline(s) => ui_lang::t(&format!("整理工具错误：{s}")),
            AppError::Compare(s) => ui_lang::t(&format!("文件比较错误：{s}")),
            AppError::Merge(s) => ui_lang::t(&format!("文件合并错误：{s}")),
            AppError::Batch(s) => ui_lang::t(&format!("批处理错误：{s}")),
            AppError::Settings(s) => ui_lang::t(&format!("设置错误：{s}")),
            AppError::Session(s) => ui_lang::t(&format!("会话恢复错误：{s}")),
        };
        f.write_str(&text)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e)
    }
}

pub type AppResult<T> = Result<T, AppError>;
