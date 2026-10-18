/**
 * 打包契约与阈值检查（第十阶段）
 *
 * 这些断言守的不是「代码对不对」，而是**交付形态对不对**：
 * 三平台各一个安装文件、Windows 上不依赖预装的运行库、版本号只有一个出处、
 * 完全离线、资源与图标齐全、产物体积在预算内。
 *
 * 两条设计原则：
 *
 * 1. **能读产物就读产物的真实字节**。比如「不依赖 VC++ 运行库」不是去 grep 构建脚本，
 *    而是直接解析 `target/release/aiotext-editor.exe` 的 PE 导入表——我们真正在意的
 *    是**最终二进制**里有没有 `MSVCP140.dll`。
 * 2. **产物不存在时跳过，而不是失败**。CI 的测试阶段跑在构建之前，本地也可能只改了代码；
 *    体积与导入表检查因此用 `describe.skipIf`。契约（配置文件）检查则永远执行。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');

// ---------------------------------------------------------------------------
// 只声明我们要读的那几个字段：比 `any` 更能挡住「配置写错位置」这类错误
// ---------------------------------------------------------------------------

interface BundleConf {
  active?: boolean;
  targets?: string[] | string;
  icon?: string[];
  resources?: Record<string, string>;
  windows?: {
    webviewInstallMode?: { type?: string };
    nsis?: { installMode?: string; languages?: string[]; displayLanguageSelector?: boolean };
  };
  macOS?: { minimumSystemVersion?: string; signingIdentity?: string };
  linux?: { appimage?: { bundleMediaFramework?: boolean } };
}

interface AppConf {
  productName?: string;
  version?: string;
  identifier?: string;
  bundle: BundleConf;
}

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface CapabilityConf {
  permissions: string[];
  windows: string[];
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const fileSize = (p: string) => statSync(p).size;
const dirSize = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const p = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? dirSize(p) : statSync(p).size);
  }, 0);

const baseConf = readJson<AppConf>(path.join(SRC_TAURI, 'tauri.conf.json'));
const windowsConf = readJson<AppConf>(path.join(SRC_TAURI, 'tauri.windows.conf.json'));
const macosConf = readJson<AppConf>(path.join(SRC_TAURI, 'tauri.macos.conf.json'));
const linuxConf = readJson<AppConf>(path.join(SRC_TAURI, 'tauri.linux.conf.json'));

const RELEASE_EXE = path.join(ROOT, 'target', 'release', 'aiotext-editor.exe');
const INSTALLER_DIR = path.join(ROOT, 'target', 'release', 'bundle', 'nsis');
const DIST_DIR = path.join(ROOT, 'dist');

/** 安装包体积预算（PRD §六 验收标准：Windows < 16MB） */
const INSTALLER_BUDGET = 16 * 1024 * 1024;
/** 可执行文件体积预算（实测约 7.5MB，留一半余量作回归护栏） */
const EXE_BUDGET = 12 * 1024 * 1024;
/** 前端产物体积预算（解压后，实测约 620kB） */
const DIST_BUDGET = 1_500_000;

/** 从 `target/release/bundle/nsis/` 里找出安装包 */
function findInstaller(): string | null {
  if (!existsSync(INSTALLER_DIR)) return null;
  const hit = readdirSync(INSTALLER_DIR).find((f) => f.endsWith('.exe'));
  return hit ? path.join(INSTALLER_DIR, hit) : null;
}

// ---------------------------------------------------------------------------
// PE 导入表：直接在最终二进制上验证「不依赖 VC++ 运行库」
// ---------------------------------------------------------------------------

interface PeSection {
  virtualAddress: number;
  virtualSize: number;
  rawPointer: number;
  rawSize: number;
}

/** 读出 PE 文件的导入 DLL 名单（只够用，不依赖任何第三方库） */
function readPeImports(file: string): string[] {
  const buf = readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 PE 文件（缺少 MZ）');

  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('PE 签名缺失');

  const coff = peOffset + 4;
  const sectionCount = buf.readUInt16LE(coff + 2);
  const optionalSize = buf.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const is64 = buf.readUInt16LE(optional) === 0x20b;

  // 数据目录：索引 1 = 导入表
  const dataDir = optional + (is64 ? 112 : 96);
  const importRva = buf.readUInt32LE(dataDir + 8);

  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const s = coff + 20 + optionalSize + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPointer: buf.readUInt32LE(s + 20),
    });
  }

  const toFileOffset = (rva: number): number => {
    for (const sec of sections) {
      const span = Math.max(sec.virtualSize, sec.rawSize);
      if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
        return sec.rawPointer + (rva - sec.virtualAddress);
      }
    }
    return -1;
  };

  const readCString = (rva: number): string => {
    const start = toFileOffset(rva);
    if (start < 0) throw new Error(`RVA 0x${rva.toString(16)} 不在任何节里`);
    let end = start;
    while (buf[end] !== 0) end += 1;
    return buf.toString('ascii', start, end);
  };

  const names: string[] = [];
  let cursor = toFileOffset(importRva);
  if (cursor < 0) return names;
  // 导入描述符数组以全零项结尾；加一个硬上限，防止畸形文件把测试挂死
  for (let i = 0; i < 512; i += 1) {
    const nameRva = buf.readUInt32LE(cursor + 12);
    if (nameRva === 0) break;
    names.push(readCString(nameRva));
    cursor += 20;
  }
  return names;
}

/** 系统 api-set（`api-ms-win-*` / `ext-ms-*`）：任何 Windows 10+ 都在 */
const API_SET_DLL = /^(api-ms-win-|ext-ms-)/i;
/** Windows 自带 DLL 白名单 */
const SYSTEM_DLL_NAMES = new Set([
  'advapi32.dll',
  'bcrypt.dll',
  'bcryptprimitives.dll',
  'combase.dll',
  'comctl32.dll',
  'comdlg32.dll',
  'crypt32.dll',
  'dwmapi.dll',
  'gdi32.dll',
  'imm32.dll',
  'kernel32.dll',
  'msvcrt.dll',
  'ntdll.dll',
  'ole32.dll',
  'oleaut32.dll',
  'powrprof.dll',
  'propsys.dll',
  'rpcrt4.dll',
  'sechost.dll',
  'setupapi.dll',
  'shell32.dll',
  'shlwapi.dll',
  'ucrtbase.dll',
  'user32.dll',
  'userenv.dll',
  'uxtheme.dll',
  'version.dll',
  'winmm.dll',
  'winspool.drv',
  'ws2_32.dll',
]);
/** VC++ 运行库（可再发行组件）——这些才是「要目标机器预装」的东西 */
const VC_RUNTIME = /^(msvcp|vcruntime|concrt|vccorlib)/i;

// ---------------------------------------------------------------------------

describe('三平台各一个安装文件', () => {
  it('Windows 只出 NSIS（一个 .exe 安装包），不出 MSI', () => {
    expect(windowsConf.bundle.targets).toEqual(['nsis']);
  });

  it('macOS 只出 DMG（一个 .dmg）', () => {
    expect(macosConf.bundle.targets).toEqual(['dmg']);
  });

  it('Linux 只出 deb（Debian / Ubuntu 系的标准安装包）', () => {
    // v0.9：原来这里要求 AppImage。AppImage 需要额外下载 linuxdeploy 及其插件，
    // 在 CI 上属于最容易翻车的一环（第一版三平台发布就挂在它上面）；
    // deb 由 Tauri 直接生成，依赖更少，也是这两个发行版用户真正会用的格式。
    expect(linuxConf.bundle.targets).toEqual(['deb']);
  });

  it('每个平台都显式收窄 targets，不允许回退到基线的 "all"', () => {
    // 基线 `targets: "all"` 在 Windows 上会同时产出 msi + nsis（两个安装包），
    // 所以三个平台配置必须各自显式收窄——这条断言就是防止有人删掉其中一个。
    for (const conf of [windowsConf, macosConf, linuxConf]) {
      expect(Array.isArray(conf.bundle.targets)).toBe(true);
      expect((conf.bundle.targets as string[]).length).toBe(1);
    }
  });

  it('Windows 安装到当前用户，不弹管理员提权', () => {
    expect(windowsConf.bundle.windows?.nsis?.installMode).toBe('currentUser');
  });

  it('基线配置仍然是可打包的桌面应用', () => {
    expect(baseConf.bundle.active).toBe(true);
    expect(baseConf.productName).toBe('AioTextEditor');
    expect(baseConf.identifier).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
  });
});

describe('Windows 开箱即用：不依赖目标机器预装任何东西', () => {
  it('随包携带 WebView2 官方引导程序', () => {
    // 取舍：`offlineInstaller` 能把安装包做到「零前提零联网」，但要内嵌约 127MB 的运行时，
    // 安装包体积从 ~13MB 涨到 ~150MB，直接突破 PRD §六「Windows < 16MB」这条验收线。
    // 故选 `embedBootstrapper`：引导程序（约 1.8MB）随包走，目标机已有 WebView2
    // （Windows 11 全部、打过补丁的 Win10）就直接用，缺失时才联网下载一次。
    // 真要做到隔离机器也能装，把这里换成 { type: 'offlineInstaller' } 即可，体积代价自负。
    expect(windowsConf.bundle.windows?.webviewInstallMode?.type).toBe('embedBootstrapper');
  });

  it('两侧都走静态 CRT：rustc 的 +crt-static 与 cl.exe 的 _CL_=/MT', () => {
    const cargoConfig = readFileSync(path.join(ROOT, '.cargo', 'config.toml'), 'utf8');
    // 少任何一条都会让 MSVCP140.dll 回到导入表里：
    // - 只有 _CL_=/MT：C++ 产物要 libcmt 的符号，而 rustc 仍按动态 CRT 链接 → LNK2019
    // - 只有 +crt-static：CMake 默认 /MD，OpenCC 依旧引 MSVCP140.dll
    expect(cargoConfig).toMatch(/\[target\.x86_64-pc-windows-msvc\][\s\S]*target-feature=\+crt-static/);
    expect(cargoConfig).toMatch(/_CL_\s*=\s*"\/MT"/);
  });

  describe.skipIf(!existsSync(RELEASE_EXE))('发布构建的导入表', () => {
    // 注意：`skipIf` 只是把收集到的用例标成跳过，回调本身在收集阶段仍会执行，
    // 所以这里不能把 readPeImports 放在 describe 体内——产物不存在时会直接抛错。
    // 改成惰性读取 + 记忆化。
    let cached: string[] | null = null;
    const importsOfRelease = (): string[] => (cached ??= readPeImports(RELEASE_EXE));

    it('不导入任何 VC++ 运行库', () => {
      const vc = importsOfRelease().filter((d) => VC_RUNTIME.test(d));
      expect(vc, `导入表里出现了 VC++ 运行库：${vc.join(', ')}`).toEqual([]);
    });

    it('只导入 Windows 自带的系统 DLL', () => {
      const unknown = importsOfRelease().filter(
        (d) => !API_SET_DLL.test(d) && !SYSTEM_DLL_NAMES.has(d.toLowerCase()),
      );
      expect(unknown, `出现了未知依赖（若是系统组件请加进白名单）：${unknown.join(', ')}`).toEqual([]);
    });

    it('导入表非空（说明 PE 解析本身有效）', () => {
      expect(importsOfRelease().length).toBeGreaterThan(3);
    });
  });
});

describe('版本号只有一个出处', () => {
  it('package.json / Cargo.toml / tauri.conf.json 三处一致', () => {
    const pkg = readJson<PackageJson>(path.join(ROOT, 'package.json'));
    // 不引 TOML 解析器：这里只需要顶层 version 一行
    const cargoVersion = readFileSync(path.join(SRC_TAURI, 'Cargo.toml'), 'utf8').match(
      /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(cargoVersion).toBeTruthy();
    expect(pkg.version).toBe(cargoVersion);
    expect(baseConf.version).toBe(cargoVersion);
    // 「帮助 → 关于」显示的就是后端版本号（app_version 命令读 CARGO_PKG_VERSION）
  });
});

describe('完全离线', () => {
  it('没有引入任何更新器插件', () => {
    const pkg = readJson<PackageJson>(path.join(ROOT, 'package.json'));
    const cargo = readFileSync(path.join(SRC_TAURI, 'Cargo.toml'), 'utf8');
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(allDeps).filter((d) => d.includes('updater'))).toEqual([]);
    expect(cargo).not.toMatch(/tauri-plugin-updater|tauri-plugin-http/);
  });

  it('窗口能力最小：只有核心能力与文件对话框', () => {
    const caps = readJson<CapabilityConf>(path.join(SRC_TAURI, 'capabilities', 'default.json'));
    expect(caps.permissions).toEqual(['core:default', 'dialog:default']);
    expect(caps.windows).toEqual(['main']);
  });
});

describe('资源与图标齐全', () => {
  it('bundle.resources 指向的目录都真实存在', () => {
    const resources = baseConf.bundle.resources ?? {};
    expect(Object.keys(resources).length).toBeGreaterThan(0);
    for (const from of Object.keys(resources)) {
      expect(existsSync(path.join(SRC_TAURI, from)), `资源目录缺失：${from}`).toBe(true);
    }
  });

  it('图标齐全，且含 macOS 需要的 .icns 与 Windows 需要的 .ico', () => {
    for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.icns']) {
      expect(existsSync(path.join(SRC_TAURI, 'icons', name)), `图标缺失：${name}`).toBe(true);
    }
    for (const rel of baseConf.bundle.icon ?? []) {
      expect(existsSync(path.join(SRC_TAURI, rel)), `配置引用的图标不存在：${rel}`).toBe(true);
    }
  });

  it('内置替换表资源仍在位（打包后首次启动要靠它复制到用户目录）', () => {
    const builtin = path.join(SRC_TAURI, 'data', 'builtin-tables');
    expect(existsSync(builtin)).toBe(true);
    expect(readdirSync(builtin).length).toBeGreaterThan(0);
  });
});

describe('体积预算', () => {
  it.skipIf(!existsSync(DIST_DIR))('前端产物不超过预算', () => {
    const size = dirSize(DIST_DIR);
    expect(size, `dist 实际 ${(size / 1024).toFixed(0)} kB`).toBeLessThan(DIST_BUDGET);
  });

  it.skipIf(!existsSync(RELEASE_EXE))('可执行文件不超过预算', () => {
    const size = fileSize(RELEASE_EXE);
    expect(size, `exe 实际 ${(size / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(EXE_BUDGET);
  });

  it.skipIf(!findInstaller())('Windows 安装包不超过预算', () => {
    const installer = findInstaller();
    const size = fileSize(installer ?? '');
    // 内嵌 WebView2 离线安装器是这里的大头（约 130MB），换来「装机不需要联网」
    expect(size, `安装包实际 ${(size / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(INSTALLER_BUDGET);
  });
});
