#!/usr/bin/env node
/**
 * 便携版产出：把 Tauri 构建的**单个 exe** 挑出来、带上版本号改名。
 *
 * ## 为什么只是「复制一下」
 *
 * Tauri 没有 portable 这个 bundle target（Windows 只有 nsis / msi / wix）。
 * 而 `target/release/<name>.exe` 本身就是便携的：前端资源已编进二进制，
 * 双击直接运行、不安装、不写注册表（应用本身不碰注册表）。
 *
 * 唯一要解决的坑是运行时要读的两个资源目录 `data/legacy` 与
 * `data/builtin-tables` —— 它们在 `src-tauri/core/embedded.rs` 里用
 * `include_bytes!` 编进了二进制，磁盘上找不到时从内嵌字节展开，
 * 所以这里**不需要**把 data/ 一起复制，单个 exe 就是完整的。
 *
 * 用法：node scripts/make-portable.mjs
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const src = path.join(ROOT, 'target', 'release', 'aiotext-editor.exe');
if (!existsSync(src)) {
  console.error(`✗ 找不到主程序：${src}\n  先跑 npm run tauri:build`);
  process.exit(1);
}

const outDir = path.join(ROOT, 'target', 'release', 'bundle', 'portable');
mkdirSync(outDir, { recursive: true });
const dst = path.join(outDir, `AioTextEditor_${version}_x64_portable.exe`);
copyFileSync(src, dst);

console.log(`便携版：${path.relative(ROOT, dst)}  ${(statSync(dst).size / 1024 / 1024).toFixed(2)} MiB`);
console.log('（单个 exe，双击直接运行；资源已内嵌，不需要旁边的 data/ 目录）');
