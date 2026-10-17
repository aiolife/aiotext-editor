/// <reference types="vite/client" />

/**
 * 应用挂在 `window` 上的诊断信息（第九阶段）。
 *
 * 启动后由 `App` 写入，供**端到端测试与排查**读取；不参与任何业务逻辑。
 */
interface Window {
  /** 启动耗时指标：`setupMs` = 后端 `run()` → 初始化结束的毫秒数 */
  __aioStartupMetrics?: { setupMs: number; debugBuild: boolean };
}
