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
  },
});
