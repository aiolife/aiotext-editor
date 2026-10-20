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

// 便携版只对 Windows 有意义：Linux 的产物是无扩展名的可执行文件、macOS 是 .app 包，
// 「单个 exe」在这个概念上不成立。万一被误调（例如串进带 && 的脚本里），安静跳过，
// 不要让一个不存在的产物把整条 CI 拖红。
if (process.platform !== 'win32') {
  console.log('便携版只在 Windows 产出，跳过');
  process.exit(0);
}

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
copyWithRetry(src, dst);

/**
 * 复制，遇到瞬时占用就等一会儿重试
 *
 * Windows 上刚构建出来的 exe 常被杀毒软件 / 索引服务短暂占用，`copyFileSync`
 * 会抛 EBUSY / EPERM。CI 的 runner 上同样有 Defender 实时扫描 —— 试一次就放弃
 * 会让整条出包流程红掉，而这时 nsis 明明已经出好了。
 */
function copyWithRetry(from, to, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      copyFileSync(from, to);
      return;
    } catch (err) {
      const transient = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!transient || i === attempts - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

console.log(`便携版：${path.relative(ROOT, dst)}  ${(statSync(dst).size / 1024 / 1024).toFixed(2)} MiB`);
console.log('（单个 exe，双击直接运行；资源已内嵌，不需要旁边的 data/ 目录）');
