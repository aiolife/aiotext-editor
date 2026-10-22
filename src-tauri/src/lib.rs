//! AioTextEditor 应用入口（Tauri 2）
//!
//! 分层约定（见 docs/03-tech-architecture.md §3.2）：
//! - `commands/`：Tauri 命令层——只做参数解析 → 调 core → 构造返回类型
//! - `core/`：纯 Rust 算法核心，不依赖 Tauri，独立可单测

pub mod commands;
pub mod core;
pub mod error;
pub mod tray;

/// 启动耗时指标（第九阶段）
///
/// 把「启动 < 1.5s」这条验收标准变成**可观测、可断言**的数字：`setup_ms` 是
/// 从 `run()` 被调用到 `setup` 执行完的毫秒数（窗口已建、初始化结束），
/// **不含前端加载**——前端资源与 vite dev server 的快慢不该混进这条指标。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupMetrics {
    pub setup_ms: u64,
    /// 是否为调试构建（`cargo build` 未优化）。
    ///
    /// 同一台机器上 dev 构建的启动明显慢于发布构建（未优化代码 + 更大的二进制 +
    /// WebView2 冷启动），所以「启动 < 1.5s」这条线只对**发布构建**成立，
    /// 自动化测试据此选择阈值。
    pub debug_build: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started = std::time::Instant::now();
    // 默认 INFO；`RUST_LOG=debug` 可放开逐文件的读 / 写日志（见下）。
    //
    // 用 `EnvFilter` 而不是 `with_max_level(INFO)`，是为了让 DEBUG 级日志
    // 在需要时真的能打开：`core::encoding` 的「文件读取完成 / 文件写出完成」
    // 是**逐文件**的，批处理上千文件时既刷屏又慢（tracing 的 fmt 订阅器是
    // 全局互斥的 stdout 写，会把并行的批处理串行化），故降到 DEBUG。
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();

    tauri::Builder::default()
        // 单实例（第九阶段）：必须**第一个**注册（插件官方要求）。
        // 第二次启动不再开新窗口，而是把已有窗口带到前台。
        // `argv` / `cwd` 先忽略，留给后续「用启动参数打开文件」。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            match app.get_webview_window("main") {
                Some(window) => {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                None => tracing::warn!("单实例回调：找不到主窗口"),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            use tauri::Manager;
            // 第九阶段：把「启动 < 1.5s」变成可观测、可断言的数字（见 StartupMetrics）
            //
            // 这里刻意**不做任何磁盘写入**。内置示例表的复制（F-04 §4.10）原先挂
            // 在 setup 里（先是前台、后来挪到后台线程），两种写法都会在冷启动时
            // 白写一遍磁盘；便携版尤其明显，还要从二进制展开 131 KB 到临时目录。
            // 现已改为**按需**：由命令层 `list_replace_tables` / `load_replace_table`
            // 在真正要用到时兜一次（幂等），启动路径上彻底没有这笔开销。
            let metrics = StartupMetrics {
                setup_ms: started.elapsed().as_millis() as u64,
                debug_build: cfg!(debug_assertions),
            };
            // 托盘建好即隐藏；只有开启「关闭时隐藏」且窗口真的被藏起来时才显示
            // （见 tray 模块头注释）。失败不阻断启动。
            if let Err(e) = crate::tray::build(app.handle()) {
                tracing::warn!(error = %e, "托盘创建失败（不影响主流程）");
            }
            tracing::info!(setup_ms = metrics.setup_ms, "启动完成");
            app.manage(metrics);
            Ok(())
        })
        .manage(commands::batch::BatchCancel::default())
        .invoke_handler(tauri::generate_handler![
            commands::fs::fs_read,
            commands::fs::fs_read_with,
            commands::fs::fs_check_mappable,
            commands::fs::fs_write,
            commands::convert::list_opencc_directions,
            commands::convert::convert_opencc,
            commands::convert::preview_convert,
            commands::replace::list_replace_tables,
            commands::replace::load_replace_table,
            commands::replace::save_replace_table,
            commands::replace::delete_replace_table,
            commands::replace::validate_replace_table,
            commands::replace::apply_replace,
            commands::replace::import_textpro_tab,
            commands::replace::ensure_replace_tables,
            commands::replace::read_replace_table_source,
            commands::replace::parse_replace_table_text,
            commands::replace::save_replace_table_source,
            commands::regex::regex_categories,
            commands::regex::regex_find,
            commands::regex::regex_replace,
            commands::regex::regex_replace_with_tool,
            commands::pipelines::pipelines_catalog,
            commands::pipelines::apply_pipeline_step,
            commands::pipelines::apply_pipeline_chain,
            commands::compare::compare_diff,
            commands::merge::merge_files,
            commands::batch::batch_run,
            commands::batch::batch_cancel,
            commands::batch::batch_plan,
            commands::settings::settings_get,
            commands::settings::settings_save,
            commands::settings::settings_reset,
            commands::session::session_load,
            commands::session::session_save,
            commands::session::session_clear,
            commands::app::startup_metrics,
            commands::app::app_version,
        ])
        // 关闭主窗口：默认退出进程；开启「关闭时隐藏」后改为隐藏 + 亮出托盘。
        // 隐藏后再启动走单实例的「聚焦已有窗口」，不再重建 WebView2——
        // 实测二次启动 748ms → 66~127ms（见 docs/CHANGELOG.md）。
        .on_window_event(|window, event| {
            // `app_handle()` 由 Manager 提供
            use tauri::Manager;
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 关闭是低频操作：直接读磁盘拿最新值（约 10ms，能反映刚改的设置）
                if crate::core::settings::load().hide_on_close {
                    let _ = window.hide();
                    crate::tray::set_visible(window.app_handle(), true);
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // 退出时清理 OpenCC 临时数据目录（%TEMP%/aiotext-opencc-<pid>）
    core::opencc::cleanup();
}
