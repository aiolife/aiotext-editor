import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 关键：不监视 Rust 构建产物——cargo 链接时会锁定 DLL，
      // chokidar 对加锁文件 watch 会 EBUSY 崩溃（Windows）
      ignored: ['**/src-tauri/**', '**/target/**'],
    },
  },
  // 3. to make use of `TAURI_DEBUG` and other env variables
  // https://vitejs.dev/config/env-and-mode
  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    // Tauri uses Chromium on Windows / WebKit on macOS / Linux
    target: process.env.TAURI_ENV_PLATFORM === 'windows'
      ? 'chrome105'
      : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,

    // 代码分割（PRD §3.7 P-3）
    //
    // 之前所有东西打成一个 622 kB 的 chunk：React、CodeMirror、全部业务组件
    // 挤在一起，浏览器只能串行下载解析。拆成 vendor 之后能并行下载，且业务代码
    // 改动不会让用户重新下载第三方库（桌面应用也是走 http://tauri.localhost）。
    //
    // 注意：**不要**把编辑器本身拆出去动态加载——v0.13 的注释已记录过这个决定，
    // 拆了只会把「能打字」的时间点往后推。这里只拆 vendor，不动业务组件。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@codemirror') || id.includes('@lezer')) {
            return 'vendor-codemirror';
          }
          if (id.includes('react') || id.includes('scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('@tauri-apps')) {
            return 'vendor-tauri';
          }
        },
      },
    },
  },
});
