# AioTextEditor

跨平台中文文本编辑器 —— 面向古籍电子化整理者、内容编辑与校对人员。

Rust + Tauri 2 + React 19 + CodeMirror 6 + OpenCC。

本人不会任何一种编程语言，只是试用 AI 编程。不知道要开发什么，就想到很早以前用过的 TextPro文本处理 软件，只有 Windows 版本且有十几年没更新了，在 Linux 下用不了，我多年前还要装上 Wine 模拟一下才能运行。所以就想着以 TextPro 为基础，把用到的一些开源项目整合进来，功能分析、代码编写及最后打包，完全由AI生成。

新手上路，，BUG难免众多，见谅。

## 功能概览

- **多编码读写互转**：UTF-8 / UTF-16 / GBK / GB2312 / GB18030 / Big5 / ISO-8859-1 等（[`encoding_rs`](https://github.com/encoding-rs/encoding_rs)，WHATWG 标准）
- **简繁互转**：基于 [OpenCC 1.4.2](https://github.com/BYVoid/OpenCC)，14 种标准转换方向（s2t / t2s / s2tw / s2twp / s2hk / t2jp 等），歧义片段诊断
- **自定义替换表**：TextPro 风格 `A/B=目标`，后端编译为 OpenCC 内联字典叠加进转换链
- **中文增强正则**：`\c[GBK]` `\c[BIG5]` `\c[数字]` `\c[天干]` 等类目
- **文本整理工具集**：删除空行 / 段内回车 / 重复行、半角↔全角、行排序、匹配括号检查等；v0.9 起新增 5 个排版类工具，菜单也重组成「简繁 / 排版」两类
- **文件比较与合并**：双栏/三栏 diff，含异体字感知（TextPro fc1/fc2 开放数据）
- **批处理流水线**：目录递归、并行执行、自动备份
- **会话恢复**：启动即恢复上次打开的标签与未保存内容（没有欢迎页）
- **完全离线**：不发起任何网络请求，不检查更新；偏好设置与快捷键全部存本地用户目录

完整规格见 [docs/](./docs/README.md)（PRD、功能规格、技术架构、UI 草图、路线图、数据字典）。

## 开发环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| Node.js | ≥ 20.19（推荐 22/24 LTS） | 前端构建 |
| Rust | stable（rustup 管理） | 后端 |
| CMake | ≥ 3.20 | 第三阶段起编译 OpenCC（opencc-sys） |
| LLVM（libclang） | 任意近期版 | 第三阶段起 bindgen 生成 OpenCC FFI（`LIBCLANG_PATH`） |
| MSVC / clang / gcc | —— | Windows 需 VS 2022 Build Tools（VCTools 工作负载） |
| WebView2 | —— | Windows 10/11 系统自带（安装包另带官方引导程序兜底） |

Linux 另需 `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` 等系统库。

**不需要单独安装 VC++ 运行库**：第十阶段起 Rust 侧与 OpenCC 的 C++ 侧都静态链接 CRT（`+crt-static` + `_CL_=/MT`），发布产物只依赖 Windows 自带的 DLL 与 UCRT api-set（见 [技术架构 §10.1](./docs/03-tech-architecture.md)）。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（启动空白窗口 + Vite 热更新）
npm run tauri dev

# 前端单元测试
npm test

# 代码检查
npm run lint

# Rust 单测（core 层）
cd src-tauri && cargo test

# 发布构建
npm run tauri build
```

## 打包与发布

```bash
npm run tauri:build     # 出当前平台的安装文件
npm run smoke           # 启动刚打出来的包：断言界面可用、OpenCC 转换正常
```

每个平台只出一个安装文件：Windows `.exe`（NSIS）、macOS `.dmg`、Linux `.deb`。平台差异写在
`src-tauri/tauri.<平台>.conf.json` 里，打包契约由 `tests/packaging.test.ts` 守住（三平台单文件、
静态 CRT、PE 导入表白名单、版本号出处、体积预算）。

macOS 与 Linux 的包由 `.github/workflows/release.yml` 在 `v*` tag 上产出——`.dmg` 需要 macOS SDK 与
`codesign`，`.deb` 需要 dpkg 与 webkit2gtk，在 Windows 上无法交叉生成。Linux 最初选的是 AppImage，
但它要额外下载 linuxdeploy 及其插件、在 CI 上最容易翻车（首版三平台发布就挂在它上面），v0.9 起
改为 deb。

## 获取安装包

最新版本的三个安装包都在 [Releases](https://github.com/aiolife/aiotext-editor/releases) 页面：

```
AioTextEditor_<版本>_x64-setup.exe     # Windows 10/11 —— 双击安装
AioTextEditor_<版本>_universal.dmg     # macOS（Intel + Apple Silicon 通用）—— 拖进 Applications
AioTextEditor_<版本>_amd64.deb         # Linux x86-64
```

Linux 是从 `.deb` 安装出来的：

```bash
sudo dpkg -i AioTextEditor_<版本>_amd64.deb
```

若提示依赖不全，补一句 `sudo apt-get -f install` 即可。包自身只依赖 `libwebkit2gtk-4.1-0` 与
`libgtk-3-0`（Ubuntu 24.04 起这两个系统自带）。

## 运行环境要求（拿到安装包的用户）

| 平台 | 需要预装的东西 | 说明 |
|------|----------------|------|
| Windows 10/11 | 无 | 双击安装包即可用。VC++ 运行库已静态链接；WebView2 随包带官方引导程序，仅当系统缺失时才联网下载一次 |
| macOS 10.15+ | 无 | 打开 `.dmg` 拖进 Applications。当前是 ad-hoc 签名，首次打开需右键「打开」放行一次 |
| Linux x86-64 | `libwebkit2gtk-4.1-0`、`libgtk-3-0` | `dpkg -i` 装好后从应用菜单启动。WebKitGTK 是所有 Tauri 应用的系统层前提（Ubuntu 24.04 起默认自带） |

## 项目结构

```
aiotext-editor/
├─ src/                 # 前端（React 19 + CodeMirror 6 + Zustand）
│  ├─ platform/         #   tauriApi.ts —— 前后端唯一接口层
│  ├─ shared/           #   纯前端算法（可单测）
│  ├─ components/        #   UI 组件
│  └─ store/             #   Zustand stores
├─ src-tauri/           # 后端（Rust + Tauri 2）
│  ├─ src/commands/      #   Tauri 命令层（参数解析→调 core→构造返回）
│  ├─ src/core/          #   纯 Rust 算法核心（不依赖 Tauri，独立可单测）
│  ├─ data/legacy/       #   TextPro 开放文本数据（fc1/fc2 异体字组表）
│  └─ data/builtin-tables/ # 内置示例替换表
├─ data-extracted/      # TextPro .dat 逆向提取档案（见 docs/06-data-dictionary.md）
├─ docs/                # 产品文档
└─ scripts/             # 构建/提取辅助脚本
```

## 分层约束

```
React UI → platform/tauriApi（唯一接口） → commands（Tauri 命令层） → core（纯 Rust 算法）
```

- `core` 层不依赖 Tauri，仅用 std + 必备 crate，`cargo test` 独立可跑
- 前端绝不直接调用 `__TAURI__.*`，一律走 `platform/tauriApi.ts`

## 数据来源与许可

- OpenCC 词库：Apache License 2.0（© Carbo Kuo 等），经 `opencc-sys` 编译期嵌入
- TextPro 异体字组表（fc1/fc2，开放文本格式）：© TextPro 作者（佛典网），以继承兼容方式使用
- 编码互转：`encoding_rs`（MIT/Apache-2.0，WHATWG Encoding Standard 参考实现）

详见 [docs/06-data-dictionary.md](./docs/06-data-dictionary.md)。

## 开发路线

当前进度与后续阶段见 [docs/05-roadmap.md](./docs/05-roadmap.md)；文档变更历史见 [docs/CHANGELOG.md](./docs/CHANGELOG.md)。

应用版本号以后端 [`src-tauri/Cargo.toml`](./src-tauri/Cargo.toml) 的 `version` 为唯一出处：前端不维护第二个版本号，「帮助 → 关于」显示的就是它（经 `app_version` 命令读取）。

