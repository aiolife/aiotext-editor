//! 应用错误类型

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("文件不存在或不可读：{0}")]
    Io(#[from] std::io::Error),

    #[error("路径无效：{0}")]
    InvalidPath(String),

    #[error("文本含 {encoding} 不可编码字符 ×{count}，请选择处理策略")]
    Unmappable { encoding: String, count: usize },

    #[error("繁简引擎初始化失败：{0}")]
    OpenccInit(String),

    #[error("转换失败：{0}")]
    Convert(String),

    #[error("转换方向不支持：{0}")]
    UnsupportedDirection(String),

    #[error("替换表错误：{0}")]
    ReplaceTable(String),

    #[error("正则表达式错误：{0}")]
    Regex(String),

    #[error("整理工具错误：{0}")]
    Pipeline(String),

    #[error("文件比较错误：{0}")]
    Compare(String),

    #[error("文件合并错误：{0}")]
    Merge(String),

    #[error("批处理错误：{0}")]
    Batch(String),

    #[error("设置错误：{0}")]
    Settings(String),

    #[error("会话恢复错误：{0}")]
    Session(String),
}

pub type AppResult<T> = Result<T, AppError>;
