//! 托盘图标
//!
//! 只在「关闭时隐藏」（`Settings::hide_on_close`）生效、主窗口被隐藏时出现。
//!
//! ## 为什么必须有它
//!
//! 开启隐藏后关闭窗口只是 `hide()`，进程还在跑。若不给用户一个入口，窗口
//! 就再也唤不回来、也没法真正退出——那是体验事故，不是优化。所以托盘是
//! `hideOnClose` 这个开关的**必要配套**，不是可选装饰。
//!
//! ## 默认路径不受影响
//!
//! 托盘建好即 `set_show(false)`。默认（关闭即退出）下它永远不显示，
//! 任务栏不会多出图标，行为与开启该开关之前完全一致。
//!
//! ## 分层
//!
//! 这里依赖 Tauri，故不放在 `core/`（`core` 的约定是纯 Rust、独立可单测）。

use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::core::ui_lang;

/// 托盘 id（全局只有一个主托盘）
const TRAY_ID: &str = "main";

/// 托盘句柄。
///
/// 自己存一份而不是「按 id 反查」——当前 Tauri 版本的 `Manager` 没有提供按 id
/// 取回托盘的方法（编译期即报 `no method named tray_by_id`）。托盘本身可 clone，
/// 这里放进 `Mutex` 只是为了能放进 `app.manage()`。
pub struct TrayHandle(pub Mutex<Option<TrayIcon>>);

/// 建托盘。默认**不显示**，窗口被隐藏时由 [`set_visible`] 打开。
///
/// 失败只记日志不阻断启动：托盘是这个开关的配套，主流程不该被它拖垮。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // 菜单项走一遍语言：托盘是 Rust 侧建的**原生**菜单，前端 DOM 够不到，
    // 所以和其他后端文本一样由 ui_lang 负责（PRD L-5，重启后生效）。
    //
    // 立刻重建也能做（暴露一个 command 让前端切语言时调），但那会让托盘成为
    // 唯一「不重启就变」的后端文本，与错误提示、工具目录的行为不一致，故不做。
    //
    // 注：「退出」繁簡同形，s2twp 转出来还是「退出」——不按台湾习惯改成「結束」，
    // 与「批處理」等词一样，接受 OpenCC 原样输出（见 PRD §3.6 落地口径）。
    let show = MenuItemBuilder::with_id("show", ui_lang::t("显示主窗口")).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", ui_lang::t("退出")).build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => restore(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击即唤回；右键由系统弹出上面的菜单
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore(&tray.app_handle());
            }
        });

    // 复用 tauri.conf.json 里配好的窗口图标，避免再引一份资源路径
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    // 建好即隐藏：默认（关闭即退出）路径下托盘从不出现
    tray.set_visible(false)?;
    app.manage(TrayHandle(Mutex::new(Some(tray))));
    Ok(())
}

/// 显示 / 隐藏托盘图标
///
/// 托盘是**按需**建的：要显示时才建。默认（关闭即退出）路径下它从不出现，
/// 也就没必要在启动时付那笔钱——实测繁體界面下一次 [`build`] 要 455ms，其中
/// 451ms 是 OpenCC 首次初始化（菜单文案要走语言转换）。启动路径上省掉它，
/// 冷启动从约 1.3s 降到约 0.85s。
pub fn set_visible(app: &AppHandle, visible: bool) {
    if visible && app.try_state::<TrayHandle>().is_none() {
        if let Err(e) = build(app) {
            tracing::warn!(error = %e, "托盘创建失败（不影响关闭行为）");
            return;
        }
    }
    let Some(handle) = app.try_state::<TrayHandle>() else {
        return; // 托盘没建起来（build 曾失败）：静默忽略，不该影响关闭行为
    };
    // 用 match 而不是 `if let`：后者会把 `Result` 临时值留到语句末尾才 drop，
    // 晚于 `handle` 的释放，借用检查器不接受（E0597）。
    let guard = match handle.0.lock() {
        Ok(g) => g,
        Err(_) => return, // 锁中毒：忽略，关闭行为本身照常
    };
    if let Some(tray) = guard.as_ref() {
        let _ = tray.set_visible(visible);
    }
}

/// 唤回主窗口，并收起托盘
fn restore(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        set_visible(app, false);
    }
}
