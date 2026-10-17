# AioTextEditor 技术架构设计

**版本**：v0.1

---

## 一、整体目标

- 在保留 iml-editor-lite 的"轻量、单一 API、跨平台"前提下，把 TextPro 的全部中文处理能力搬进同一个壳层。
- 单个安装包 < 12 MB（Win64），< 8 MB（macOS），< 14 MB（Linux AppImage）。
- 所有性能敏感路径（编码、查找、正则、批处理）在 Rust 端完成。
- 启动后 < 1.5s 显示可编辑窗。

---

## 二、技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 桌面壳层 | **Tauri 2** | 安装包小、系统 WebView、单一 Rust 二进制 |
| 前端框架 | **React 19 + Vite 7 + TypeScript 5.9** | 与 iml-lite 复用经验 |
| 状态管理 | **Zustand 5** | 与 iml-lite 保持一致 |
| 代码编辑器 | **CodeMirror 6** | 虚拟滚动、增量解析、可扩展 |
| **简繁转换引擎** | **`opencc-sys` 0.5.2**（内嵌 OpenCC 1.4.2 词典二进制） | 零运行时依赖、词库最新；构建需 cmake + libclang（bindgen）+ MSVC |
| 基础正则 | **`regex` crate + 中文类目预编译** | 性能与标准库兼容 |
| 字符串处理 | **`aho-corasick`、`unicode-segmentation`、`strum`** | 多模式匹配、CJK 分词 |
| 多线程 | **`rayon`** | 批处理并行 |
| 字符编码 | **`encoding_rs` + `chardet`** | WHATWG 全编码互转（UTF-8 / UTF-16 / GBK / GB2312 / GB18030 / Big5 / ISO-8859-1 等）+ 编码探测 |
| 数据序列化 | **`serde` / `serde_json`** | Tauri 命令边界 |
| 文件监听 | **`notify`** | 文件比较可选 |
| 日志 | **`tracing`** | 多级别、可过滤 |
| 测试 | **`cargo test` + Vitest** | Rust 单测 + 前端组件测试 |
| CI | **GitHub Actions** | Win / macOS / Linux 三平台 |

---

## 三、模块划分

### 3.1 物理目录结构（参考 iml-lite）

```
aiotext-editor/
├─ assets/                       # 应用图标、字体
├─ docs/                         # 文档（PRD、功能规格、UI 草图）
├─ data/                         # TextPro 数据（已提取的开放文本格式，见 docs/06-data-dictionary.md）
├─ tests/                        # 跨模块端到端 fixture
├─ src/                          # 前端
│  ├─ platform/
│  │   └─ tauriApi.ts            # 唯一调用后端的接口
│  ├─ shared/
│  │   ├─ pipelines/             # 各种纯算法实现（与 iml-lite 共享）
│  │   ├─ shortcuts.ts           # 命令注册表 + 键位规范化 / 冲突检测（第八阶段）
│  │   ├─ countChars.ts
│  │   └─ ...
│  ├─ extensions/                # CodeMirror 扩展
│  ├─ components/
│  │   ├─ Editor/
│  │   ├─ FindReplace/
│  │   ├─ ReplaceTables/
│  │   ├─ Compare/
│  │   ├─ Batch/
│  │   ├─ Convert/
│  │   ├─ Settings/
│  │   └─ ...
│  ├─ store/                     # Zustand stores（tabsStore / settingsStore / toastStore）
│  ├─ App.tsx
│  └─ main.tsx
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ build.rs
│  ├─ icons/
│  └─ src/
│     ├─ main.rs                 # 入口
│     ├─ lib.rs                  # run()、菜单、单实例
│     ├─ commands/
│     │   ├─ mod.rs
│     │   ├─ fs.rs               # 文件 I/O
│     │   ├─ session.rs          # 多标签状态
│     │   ├─ convert.rs          # 简繁互转
│     │   ├─ replace.rs          # 自定义替换
│     │   ├─ regex_cmd.rs        # 中文增强正则
│     │   ├─ compare.rs          # 文件比较
│     │   ├─ merge.rs            # 文件合并
│     │   ├─ batch.rs            # 批处理
│     │   ├─ pipelines.rs        # 各 pipeline step
│     │   ├─ stats.rs            # 字数 / 段落统计
│     │   ├─ settings.rs         # 设置读写
│     │   ├─ shortcuts.rs
│     │   ├─ reveal.rs
│     │   └─ print.rs
│     ├─ core/                   # 纯 Rust 算法核心（独立可测）
│     │   ├─ mod.rs
│     │   ├─ encoding.rs         # 读写、检测
│     │   ├─ opencc.rs           # OpenCC 安全封装（简繁引擎）
│     │   ├─ replace.rs          # 自定义表加载 + 应用（独立 / OpenCC 内联）
│     │   ├─ regex.rs            # 中文正则扩展
│     │   ├─ compare.rs          # Myers diff + 异体字
│     │   ├─ merge.rs            # 文件合并
│     │   ├─ pipelines/          # 所有 step 实现
│     │   ├─ data_tables.rs      # 开放文本词表加载器（fc1/fc2 异体字组表）
│     │   ├─ settings.rs         # 偏好设置类型 + 原子读写 + 宽松恢复（第八阶段）
│     │   ├─ session.rs          # 会话与未保存恢复 + 原子写（第九阶段）
│     │   ├─ paths.rs            # 用户数据目录定位（settings / session / replace 复用）
│     │   └─ progress.rs
│     ├─ platform/               # 平台适配
│     │   ├─ macos.rs
│     │   ├─ windows.rs
│     │   └─ linux.rs
│     ├─ app_state.rs
│     ├─ menu.rs                 # 原生菜单（macOS 必装）
│     └─ error.rs
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
└─ README.md
```

### 3.2 内部分层

```
        ┌────────────────────┐
        │   React UI 层      │
        │  (src/components)  │
        └────────┬───────────┘
                 │ invoke('xxx')
        ┌────────▼───────────┐
        │   platform/api     │   ← 唯一前/后端接口
        │  (tauriApi.ts)     │
        └────────┬───────────┘
                 │
        ┌────────▼───────────┐
        │   commands 层      │   ← 参数校验、错误格式化、progress/event
        │  (src-tauri/cmd)   │
        └────────┬───────────┘
                 │
        ┌────────▼───────────┐
        │    core 层         │   ← 纯 Rust、可单元测试
        │  (src-tauri/core)  │
        └────────────────────┘
```

约束：
- **core 层不依赖 Tauri**（仅使用 Rust std + 必备 crate）。
- **commands 层只做：参数解析 → 调用 core → 构造返回类型**，不写业务算法。
- **frontend 仅通过 `tauriApi`** 调用后端，绝不调用 `__TAURI__.*` 的其它接口。
- **快捷键与外观设置在前端收口**：命令注册表、键位规范化、冲突检测、命令分发都在 `shared/shortcuts.ts` + `store/settingsStore.ts`；后端 `settings.json` 只做持久化与校验，不复制默认键位表。

---

## 四、关键数据流

### 4.1 打开文件

```
用户拖入文件
  → frontend 通过 file drop event 拿到 name
  → invoke('fs_read', { path })           // Rust
        → core::encoding::detect(path)    // 自动检测
        → core::encoding::decode(bytes)   // 按 Encoding 解码
        → 返回 LoadResult
  → frontend 把内容塞进 CodeMirror doc
  → 标签 dirty = false
```

### 4.2 简繁转换

```
用户在功能菜单点 "繁 → 简"
  → invoke('convert_t2s', { text, skipInside: "[]" })
  → core::convert::t2s_with_groups(text, opts)
        → Aho-Corasick 多模式匹配词组表
        → 字符表查表
        → 不转换括号对处理
  → 返回新文本 + 歧义区段（用于弹窗）
  → frontend 用 CodeMirror 替换文档并标记歧义区
```

### 4.3 文件比较

```
用户打开两个标签，平铺窗口
用户各自点击设起始位
  → invoke('compare_texts', { a, b, opts })
  → core::compare::myers(a, b, opts)
        → ignore_newlines / ignore_punct 预处理
        → 异体字策略应用
        → Myers diff
  → 返回 differences[]
  → 前端按序在状态栏提示，光标跳到对应位置（CodeMirror view.dispatch）
```

---

## 五、并发与性能

### 5.1 并行策略

- **批处理**：使用 `rayon` 的 `par_iter()`，并行处理文件（I/O 与 CPU 分离）。
- **查找替换**：超长文本（> 10 MB）使用 `rayon::scope` 分段并行扫描，最后合并。
- **单文件操作**：单线程（避免 UI 状态冲突）。

### 5.2 取消

- `tokio_util::sync::CancellationToken` 接收前端 `invoke('batch_cancel')` 取消正在进行的批处理。

### 5.3 进度

- 通过 `tauri::ipc::Channel<T>` 流式推送进度：
  ```rust
  progress.send(ProgressEvent { phase, current, total, ... })?;
  ```
- 前端用 `channel.onmessage` 更新进度条。

---

## 六、安全模型

### 6.1 文件访问

- 默认只允许用户拖入 / 打开操作的文件路径。
- 拖放路径、Windows 启动参数通过 `app_state.pending_open` 队列管理。
- 不主动扫描磁盘。

### 6.2 URL 与外部协议

- `open_external` 只允许 `http` / `https` / `mailto`。
- 自定义协议 `aotext-asset://` 仅放行图片 / 音 / 视频扩展名 + 必须绝对路径。

### 6.3 序列化

- 所有跨边界类型用 `serde` + `#[serde(rename_all = "camelCase")]`。
- 不信任前端输入 —— commands 层用 `serde_json::Value` 校验或自定义 validator。

---

## 七、配置与持久化

统一放在用户数据目录（由 `core::paths::app_data_dir()` 定位）：

| 数据 | 路径 |
|------|------|
| 主配置 | `~/Library/Application Support/AioTextEditor/settings.json`（mac）/ `%APPDATA%/AioTextEditor/settings.json`（win）/ `~/.config/AioTextEditor/settings.json`（linux） |
| 快捷键覆盖表 | **内嵌于 `settings.json` 的 `shortcuts` 字段**（不再是独立的 `keymap.json`） |
| 自定义替换表 | 同上 `tables/*.tab` |
| 会话恢复 | `session.json` |
| 缓存目录 | 系统缓存目录 `AioTextEditor/cache` |

`settings.json` 落盘约定（第八阶段）：

- **原子写**：先写同目录 `settings.json.tmp` 再 `rename` 覆盖，避免写到一半断电留下半截 JSON。
- **坏文件不致命**：JSON 坏了先备份为 `settings.json.bad`，再**逐字段**回落默认；个别字段类型不符只丢该字段，不牵连整节。
- **`shortcuts` 只存覆盖项**（三态：缺键＝默认 / 空串＝显式解绑 / 非空＝覆盖），默认键位由前端注册表 `shared/shortcuts.ts` 唯一提供，后端不复制一份默认表。

---

## 八、构建与发布

### 8.1 本地开发

```bash
npm install
npm run tauri:dev       # 开发
npm run check           # 类型 + ESLint + Vitest + cargo test
npm run tauri:build     # 出包
```

### 8.2 CI（GitHub Actions）

两条工作流，分工明确：

| 工作流 | 触发 | 干什么 |
|--------|------|--------|
| `.github/workflows/ci.yml` | push、PR | 质量门：前端 lint / 类型 / 单测、Rust fmt / clippy / 单测 / 契约（三平台矩阵） |
| `.github/workflows/release.yml` | `v*` tag、手动 | 出包：三平台各出一个安装文件 → Windows 冒烟 → 创建 draft Release |

出包流程（`release.yml`）：

1. 缓存 `node_modules` 与 `~/.cargo`（`swatinem/rust-cache`）。
2. 装依赖：`npm ci` + LLVM（`opencc-sys` 的 bindgen 需要 libclang）+ Linux 的 webkit2gtk 一套。
3. **校验 tag 与版本号一致**：版本号唯一出处是 `Cargo.toml`，打错 tag 会让发布页与「帮助 → 关于」对不上。
4. `npm run tauri:build`（macOS 加 `--target universal-apple-darwin` 出通用包）。
5. Windows 额外跑 `npm run smoke`：把刚打出来的包真启动一次（含一次真实简繁转换）。
6. 上传 artifacts；tag 触发时创建 draft Release，三平台安装包一起挂上去。

**为什么 macOS / Linux 的包必须由 CI 产出**：`.dmg` 需要 macOS SDK 与 `codesign`，AppImage 需要 webkit2gtk 与 linuxdeploy，都不可能在 Windows 上交叉生成。本机只负责 Windows 包（可本地验证）。

**签名**：macOS 默认 ad-hoc（`signingIdentity: "-"`），任何 Mac 都能打开，但从浏览器下载后首次打开会被 Gatekeeper 拦一次（右键「打开」放行）。要免掉这一步需要 Apple Developer 证书（年费 $99），`release.yml` 末尾注释里备好了要加的 Secrets 清单。

### 8.3 安装包体积控制

- 字体子集化（仅打包宋体常用 6k 字符）。
- 图标仅打包 `1024px` 母版，再生成多分辨率（`scripts/gen-app-icon.ps1` → `tauri icon`，含 macOS `.icns` 与 Windows `.ico`）。
- 严禁 base64 内联大资源。
- **静态 CRT**：rustc 侧 `+crt-static` + C++ 侧 `_CL_=/MT`，程序不依赖目标机器预装 VC++ 运行库，也就不必随包分发运行库（见 §10.1）。
- **WebView2 用官方引导程序**（`embedBootstrapper`，约 1.8MB）：已有 WebView2 的机器（Windows 11 全部、打过补丁的 Win10）拿来就用，缺失时才联网下载一次。若要做到隔离机器也能装，改成 `offlineInstaller`——代价是安装包涨到约 150MB，突破 PRD §六 的 16MB 验收线，故未采用。
- 预算阈值写在 `tests/packaging.test.ts`（安装包 16MB / 可执行 12MB / 前端产物 1.5MB），超了 CI 直接红。

---

## 九、可观测性

- 日志：`tracing` + 自定义格式化，输出到 `aotext.log`（用户在"帮助 → 打开日志目录"打开）。
- 错误：UI 弹 Snackbar（操作类）+ 弹 Modal（数据类）。
- 不收集任何遥测。

---

## 十、词库与数据迁移

### 10.1 主力词库：OpenCC 1.4.2（嵌入二进制）

- 通过 `opencc-sys` 0.5.2 构建，**编译期即把全部 JSON 配置与 .ocd2 词典嵌入 Rust 二进制**（`opencc_sys::S2T_JSON`、`ST_CHARACTERS_OCD2` 等 `Data { file_name, content }` 常量），发布包中无需再带词典文件。
- 运行时机制（第一阶段已实测验证）：**把所需 `Data` 写入临时目录 → `opencc_open(临时目录/xx.json)`**。配置目录自动加入词典搜索路径（与官方 `opencc-rs` crate 同机制）。
- **F-04 用户词典叠加**：自定义配置 JSON 中在 `short_circuit` 组首位放 `{"type":"inline","entries":{...}}` 字典，即可让用户表优先于标准词库（第一阶段已实测验证："软件"→"軟體" 优先于 s2t 标准结果）。
- 嵌入词典包括：`STCharacters`、`STPhrases`、`TSCharacters`、`TSPhrases`、`HKVariants` / `HKVariantsRev`、`JPVariants` / `JPVariantsRev`、`TWVariants` / `TWVariantsRev`、`TWPhrasesIT`、`TWPhrasesName`、`TWPhrasesOther`、`TWPhrases` 等等。
- 提供的 6 种标准配置均可用（s2t / t2s / s2twp / tw2sp / s2hk / hk2s；详见 PRD §1.5 与功能规格 F-03 §3.2）——其余低频方向已从 `Direction` 枚举删除。

> **构建环境要求（第一阶段实测）**：`opencc-sys` 构建链 = cmake ≥ 3.20 + MSVC（VCTools）+ **LLVM/libclang**（bindgen 生成 FFI 所需，CI 与开发机都要装）。
>
> **运行环境要求：无（第十阶段实测）**。原先的结论是「Windows 需最新 VC++ 2015-2022 运行库」——旧版（如 14.29）的 `msvcp140.dll` 会导致 OpenCC 词典加载时访问违例（第一阶段在本机实测踩坑）。根因是 OpenCC 的 C++ 侧按 `/MD` 编译，于是程序依赖可再发行运行库。第十阶段把 C++ 侧也改成静态 CRT（`_CL_=/MT`，配 rustc 的 `+crt-static`），发布产物的导入表里**已无 `MSVCP140.dll` / `VCRUNTIME140.dll`**，只剩 Windows 自带 DLL 与 `api-ms-win-crt-*`（UCRT；从 Windows 10 起属于操作系统组件，不属于「需要另装」的东西）——那个坑随链接方式一起消失了。`tests/packaging.test.ts` 直接解析 PE 导入表来守住这条（不 grep 构建脚本，因为真正要紧的是最终二进制）。

### 10.2 简繁转换落地结构（第三阶段）

| 模块 | 职责 |
|------|------|
| `core/opencc.rs` | 内嵌数据懒展开（`%TEMP%/aiotext-opencc-<pid>/`，配置与 `.ocd2` 平铺、进程退出清理）→ `opencc_open`；`Direction`（14 标准 + `Custom`）；`OpenccHandle` RAII + **转换器池**（按配置路径缓存，避免反复加载 22 个词典）；`convert_with_inline_dicts` 生成「基线 + inline」叠加配置 |
| `core/convert.rs` | 括号对豁免分段（栈式，支持嵌套 / 左右同形引号 / 未闭合保护到末尾）；变更计数（码点口径）；预览 Diff（前 200 个差异行 + 行内差异区间）；歧义诊断（同族方向差分）；F-04 表解析（`A=B`、`A/B=C`） |
| `commands/convert.rs` | `list_opencc_directions` / `convert_opencc` / `preview_convert`；重活经 `spawn_blocking` |
| 前端 | `ConvertMenu`（6 常用 + 其他转换二级菜单）、`ConvertDialog`（方向 / 括号对豁免 / 诊断 / 预览 Diff / 歧义列表）、选区范围处理（有选区只转选区） |

**用户词典叠加位置**：写入 `conversion_chain[0].dict` 的 `short_circuit` 组**首位**——`short_circuit` 自前往后匹配，首位即最高优先级（用户表优先于标准词库）。F-04 §4.4 示意图写的是"置于末位"，以实测行为为准（首位才会生效）。

**线程安全**：C API 无并发保证，且 `opencc_error()` 为全局状态 → 转换器池以 `Mutex` 串行化整个转换过程；`opencc_open` 失败返回 `(opencc_t)-1` 而非 NULL，两者都要检查。

### 10.3 自定义替换表与中文正则落地结构（第四阶段）

| 模块 | 职责 |
|------|------|
| `core/replace.rs` | 表模型与 TextPro 风格解析（含**源行号级**诊断）、校验、用户表目录管理（列表/载入/保存/删除，表名接受文件名或 `#name:` 显示名）、**模式 A 独立替换**（Aho-Corasick `MatchKind::LeftmostLongest`，`whole_word` 用字符边界判定）、**模式 B 内联导出**（供 OpenCC 转换链）、内置表首启复制（幂等，仅补缺失文件） |
| `core/regex.rs` | 类目预转换 `extend()`；`Filtered`（移除被忽略字符 + 边界回映射，**起点/终点双规则**）；`find()` / `replace()`（`skip`/`limit`）；UTF-16 偏移换算 |
| `commands/replace.rs` / `commands/regex.rs` | 11 + 3 条命令；重活 `spawn_blocking`；错误统一 `Result<T, String>` |
| 前端 | `SearchPanel`（查找替换面板）、`ReplaceTableDialog` + `TableSourceEditor`（镜像编辑器，实时校验标红）、`Editor` 的 CM6 **命中高亮 StateField** 与外部选区请求、转换对话框的用户表勾选 |

**命中高亮的实现**：CodeMirror 6 用 `StateEffect` + `StateField<DecorationSet>` 承载搜索命中（`tr.changes` 时 map 平移、`setHighlights` 时重建），当前命中额外加 `.cm-search-hit-active`；命中区间直接来自后端（UTF-16 码元 = CM6 文档坐标），前端零换算。跨行命中在 CM6 中会被拆成多个 `mark`，因此 DOM 侧统计 `.cm-search-hit` 元素数并不等于命中数（校验脚本需按区间判断）。

**忽略开关的坐标语义**（易错点，已被真实 UI 回归验证）：被忽略字符从匹配空间摘除后，命中边界回映射到原文时——
- 起点 → 该处字符在原文中的起始偏移（其前的被忽略字符**计入**命中）；
- 终点 → 前一个参与匹配字符在原文中的末尾（其后被忽略字符**不计入**）。
两者用「过滤偏移 → 原文起止」的有序表 + 二分实现（`Filtered::start` / `Filtered::end`）。

**双模式共用一张表**：模式 A 走自有引擎（Aho-Corasick，支持整词与大小写开关），模式 B 走 OpenCC 内联词典（`{"type":"inline","entries":{…}}` 写入 `short_circuit` 首位）。UI 上模式 A 是表管理对话框的「应用到正文」，模式 B 是转换对话框的「叠加用户替换表」。

### 10.5 文件比较与合并落地结构（第六阶段）

| 模块 | 职责 |
|------|------|
| `core/data_tables.rs` | TextPro 异体字组表（`fc1.txt` 完全等同 + `fc2.txt` 部分等同）加载器；UTF-8 with BOM 行解析、每行一组、首次出现的组生效；`OnceLock` 进程内缓存，资源目录探测走 `resource_dir → CARGO_MANIFEST_DIR → exe_dir` 候选链 |
| `core/compare.rs` | **同步逐字比较**（TextPro 口径，非 Myers diff）；`CompareOptions`（4 个忽略项 + 异体字策略 `VariantStrictness`）；流式 `CanonStream` 跳过忽略字符 + 折叠异体字组为「组键」；`compare()` 持双指针逐一比对，**失配处两侧各进一步**（与 Myers 的「最小编辑脚本」语义不同）；偏移始终为原文 **UTF-16 码元**；差异上限 5000 + `truncated`；4 种 `CompareEnd`（`bothEnded` / `aEnded` / `bEnded` / `truncated`） |
| `core/merge.rs` | 文件合并规划器（纯函数，吃 `MergeItem` 内存数据）：`Simple`（行尾追加空行）/ `SameName`（按源正则第 1 捕获组分文件，组内自然排序）；排序为**自然排序**（数字段按数值，段后字符仍参与比较），键相同时按文件名次排、没给关键字时保持输入顺序；模板 `\1.txt` 渲染；`plan_merge` 可万级直测 |
| `commands/compare.rs` | `compare_texts(a, b, opts)`，资源目录解析异体字组表；`spawn_blocking` |
| `commands/merge.rs` | `merge_files(req)`：判别联合（`Manual` 多文件清单 + 输出文件 / `Auto` 目录 + 正则三件套）；`MergeRequest` 用 `tag + flatten` 拼出平铺 JSON；读源失败**跳过并在报告里说明**；输出已存在时**默认跳过**，可勾覆盖 |
| 前端 | `CompareDialog`（对照标签 / 4 忽略项 / 异体字策略 / 平铺方向）；`CompareBar`（差异计数 + 4 个动作）；`MergeDialog`（两页签 + 覆盖开关）；`Editor` 增 `readOnly` + `SelectionRequest.focus`（比较双窗联动时让 B 只读窗不抢焦点）；双栏平铺（垂直 / 水平） |
| 契约 | `tests/stage6_contract.rs`：5 项交叉验证 `CompareOptions` / `CompareReport` / `CompareEnd` / `Difference` / `MergeRequest` / `MergeReport` / `MergedOutput` 的 serde 形状与前端 TS 接口一致；`MergeRequest` tag+flatten 平铺 JSON 钉死 |

**比较采用 TextPro「逐字同步」而非 Myers diff**（与规格 §6.5 的实现提示有偏差，已在 F-06 实现注记里说明）：F-06 的用户故事是「F5 同步、逐字校对、一方到达尾部即结束」，而 Myers 求的是最小编辑脚本——失配处两侧各退一步会与 TextPro 的「两侧各进一步」不符。流式 O(n) 实现百 MB 文本单核 ~秒级就能跑完，无需为百 MB 用例引入 `similar` 依赖；**复杂度 O(n + m)，内存 O(1)**。

**比较偏移是 UTF-16 码元**（与 CodeMirror / regex 一致），指向**原文坐标**而非规范化后的坐标；这是单测 `positions_are_original_offsets_despite_ignored_chars` 锁定的关键不变量。

**异体字策略是「叠加」关系**：`FullEq` 只用 fc1（伪＝偽）；`PartialEq` 优先 fc1 再叠加 fc2（达＝達），即「部分等同」是「完全等同」的超集。`VariantStrictness` 的枚举写法刻意让 `#[default]` 落到 `Strict`，避免「打开比较就忽略异体字」这类隐式行为。

**比较的「完成」语义**：单端先到尾部时仍记一处「尾部多出」差异（`charA` / `charB` 为 `None`，pos 为已到尾部一方的全文长度）以触发 UI 提示「B 窗先到尾部，A 窗还剩 N 字」；`bothEnded` 才是真完成（无尾部差异）。

**合并的排序与平局**：`natural_cmp` 数字段按数值比较，段后字符继续参与比较（不能用 `from_fn` + `filter` 取数字段——那会把分隔符当非数字字符被 filter 吞掉，需用 `Peekable` 的 `take_digits` 助手）；`sort_by_key` 在**给了排序关键字**时按「键名 → 文件名」自然序两轮比较，**没给排序关键字**时保持输入顺序。

**覆盖与跳过语义在命令层**：`overwrite: bool` 显式在请求里；不勾时跳过并在 `MergeReport.skipped` 写明「输出文件已存在（未勾选覆盖）」，让用户在通知里看到、而不是被静默覆盖。

**E2E 真实运行的两个坑（已沉淀为脚本约定）**：① `CodeMirror` 的 Enter（`insertNewlineAndIndent`）会改写 `page.keyboard.type` 的多行文本 → 夹具一律用 `keyboard.insertText` 写入；② `innerText` 会吃掉行末空格、凭空多出空行 → 断言一律拼接 `.cm-content > .cm-line` 的 `textContent` 读取；③ **无 DOM 焦点的 CodeMirror 视图不渲染 `cm-selectionBackground`**——比较模式 B 窗只读不抢焦点（`focus:false`），DOM 选区自然落在 A 窗，E2E 验证「差异字符之一被选中」用 `window.getSelection()`。

### 10.4 文本整理工具集落地结构（第五阶段）

| 模块 | 职责 |
|------|------|
| `core/pipelines.rs` | **18 个工具 = 18 个独立函数**（行处理 / 空格与全半角 / 标点与括号 / 排版与分段）；`PipelineStep` 枚举（`#[serde(tag = "kind", rename_all = "snake_case")]`，选项结构体 `rename_all = "camelCase", default`）**既是工具目录也是流水线步骤**；`catalog()` 提供菜单数据（label / group / hint / hasOptions / inspectsOnly）、`from_id()` 按标识构造默认选项步骤、`run_step()` / `run_chain()` 执行并返回 `StepOutcome{text, changed, notes, bracketIssues}` |
| `core/regex.rs` | `replace_generic(text, pattern, opts, skip, limit, render)` 作为公共内核（`replace` 与 `replace_with_tool` 共用）；`replace_with_tool` 对每个命中先 `run_step` 再拼回正文 |
| `commands/pipelines.rs` | `pipelines_catalog` / `apply_pipeline_step` / `apply_pipeline_chain`；`commands/regex.rs` 增 `regex_replace_with_tool`。均为薄封装 + `spawn_blocking`，错误统一为 `AppError::Pipeline(String)` |
| 前端 | `ToolMenu`（按后端目录分组渲染，`hasOptions` → 「…」，`inspectsOnly` → 「仅检查」，菜单内「常用」快捷区直接以默认选项应用）、`ToolOptionsDialog`（`TOOL_FIELDS` 声明式 schema → 表单，250ms 防抖实时预览，整篇 / 选中文本作用范围）、`SearchPanel` 的「使用工具」下拉 |
| 契约 | `tests/stage5_contract.rs` 交叉验证 `ToolMeta` / `StepOutcome` / `BracketIssue` / `PipelineStep` / `RegexReplaceReport` 的 serde 形状与前端 TS 接口一致 |

**行尾符保真的实现**：`split_lines()` 返回 `Vec<(内容, 行尾符)>`（`\r\n` / `\n` / `\r` / 末尾无行尾符），`map_lines()` / `join_lines()` 在其上做行级变换，故"删除空行 / 排序 / 去重"等不会把 CRLF 文件悄悄改成 LF；`struct` 级 `default` 让前端可以只发 `{"kind":"..."}` 或只发部分选项。

**选项合并方向**：前端**只发被改动的字段**，其余由 Rust 侧 `#[serde(default)]` 补齐——这样"目录里的默认值"与"菜单一键应用的值"天然是同一份（`defaults_match_spec` 单测锁定），不会出现两处默认值漂移。

**纯检查型工具的约定**：`inspects_only = true` 的工具（目前仅 `match_brackets`）返回**原文本** + `bracketIssues`（行 / 列从 1 起），前端据此只显示提示条；`SearchPanel` 的「使用工具」下拉也会过滤掉这类工具，避免"把命中替换成检查结果"这种无意义操作。

**幂等性**：`fix_brackets` 只把半 / 全角圆括号对改写为阶梯样式，`「」『』` 仅在拼接时用于跟踪嵌套深度 → 已规范的文本二次运行不变（`fix_brackets_is_idempotent_on_ladder_styles` 锁定）；「简单排版 / 段间空一行」等组合工具亦按幂等设计。

**真实 UI 端到端测试的两个坑（已沉淀为脚本约定）**：① CodeMirror 的 Enter（`insertNewlineAndIndent`）会改写 `page.keyboard.type` 输入的多行文本 → 夹具一律用 `keyboard.insertText` 写入；② `innerText` 会吃掉行末空格并凭空多出空行 → 断言一律拼接 `.cm-content > .cm-line` 的 `textContent` 读取，且**不用「全选 + 复制」**（会改动选区，进而影响工具的作用范围与撤销栈）。

### 10.6 批处理落地结构（第七阶段）

| 模块 | 职责 |
|------|------|
| `core/batch.rs` | **纯算法核心（不依赖 Tauri，可直测）**。`enumerate_files(inputs, recursive)`：`walkdir` 枚举（`recursive=false` 用 `max_depth(1)`），**`*.bak` 一律排除**；单个输入不可访问时静默跳过（返回 `AppResult<Vec<PathBuf>>`）。`run_batch(config, &AtomicBool, on_progress)`：`rayon::par_iter` 并行 + 每文件开始前查取消信号 + 以 `BatchFileEvent{Started/Done/Error}` 回调上报。`run_one_file`：读（含 mtime）→ `pipelines::run_chain` → 判「是否需要写出」→ 备份 → 写 → 恢复 mtime。类型：`BatchRequest` / `BatchSummary` / `BatchFileError` / `BatchPhase` / `EncodingOrAuto` |
| `commands/batch.rs` | `batch_run(req, progress: Channel<BatchProgress>)` / `batch_cancel()` / `batch_plan(req)`；`ProgressThrottle` 做**进度合并**（原子计数 + CAS 抢占 + 间隔发送）；`tauri::async_runtime::spawn_blocking` 承载重活 |
| 前端 | `BatchDialog`（路径输入 / 浏览… / 添加、递归开关、自动预览计划、双栏步骤选择、编码与开关、进度条 + 当前文件、按阶段染色的错误面板、取消）；`tauriApi` 的 `batchRun` 走 Tauri 2 `Channel<BatchProgress>` |
| 契约 | `tests/stage7_contract.rs`：`BatchRequest` camelCase + `EncodingOrAuto` 裸字符串 + `BatchPhase` 小写 + `BatchSummary` 键名 + 端到端 `run_batch` |

**「进度上报」必须合并——这是本阶段最重要的工程结论。** `Channel::send` 单次实测 **35~100ms**（VM 内 WebView2 的 IPC 往返），而 `core::batch` 处理 300 文件 × 5 步骤只要 **0.12s**。若按规格 §8.5 的字面「每个文件推一条」，600 次 send 就是 **21.3s**——进度上报彻底盖过批处理本身。故 `ProgressThrottle` 用原子量累加计数、CAS 抢占发送权，**首次延迟 `FIRST_FLUSH_MS`(300ms)、之后每 `FLUSH_MS`(500ms) 一条快照**，收尾补 `Finished`。效果：300 文件 **21.3s → 0.12s（164×）**，且**短任务完全不报中间进度**（用户直接看到结果）。

**第二个「164×」：逐文件 INFO 日志会串行化并行批处理。** `core::encoding` 原本对每个文件的读、写各打一条 INFO，而 tracing 的 fmt 订阅器是**全局互斥**的 stdout 写——`rayon` 的 worker 抢同一把日志锁，stdout 又被重定向到文件。实测 300 文件因此从 0.12s 退化到 **20.3s**。现降为 DEBUG，`lib.rs` 改用 `EnvFilter`（默认 INFO，`RUST_LOG=debug` 可放开），批处理只留一条收尾汇总。

**「是否需要写出」= 正文变了 *或* 编码变了。** 输入 GBK、输出 UTF-8 时，即使流水线一个字没改也必须写出，否则「编码互转」在正文无变化时被静默跳过。

**`*.bak` 是本工具的产物，不得作为输入**：否则第二次运行会产出 `x.txt.bak.bak`，「备份」语义也随之破坏。枚举阶段跳过；显式把 `.bak` 当单个输入传入也跳过。

**`EncodingOrAuto` 手写 serde 而非 `untagged`**：`untagged` 下单元变体 `Auto` 会序列化成 `null` 而非 `"auto"`。手写后前端发裸字符串（`"auto"` / `"utf-8"` / `"gbk"` …），未知编码直接报错而非静默回退。

**取消不做半途中断**：`batch_cancel` 只置位全局 `Arc<AtomicBool>`，`run_batch` 在每个文件**开始前**查一次——已启动的文件跑完，避免写出半个文件。

**错误「计数」与错误「列表」是两回事**（合并上报的直接后果）：每个快照只带「本次新增的**最后一条**错误」（`lastError`），所以前端手里的错误列表在运行中被压缩过。**错误总数必须取快照的 `errors` 计数字段**，不能拿列表长度顶替——否则挂 12 条无效路径时会显示「错误 1」。UI 用 `errorCount`（准确计数）显示数字、`errors`（最近若干条）只用于展示，结束后由 `Finished` 的 `report.errors` 全量覆盖。

**兜底分支不能用 state 判断「本次调用内是否已发生」**：`handleStart` 里的 `if (!finalReport)` 曾因为读的是渲染闭包快照值而**恒为真**，改用局部 `sawFinished` 标志由事件回调置位。这类「在同一个 async 函数里既 setState 又读同一份 state」的写法要一律避免。

### 10.7 偏好与快捷键落地结构（第八阶段）

| 模块 | 职责 |
|------|------|
| `core/settings.rs` | **纯算法核心（不依赖 Tauri，可直测）**。类型 `Settings{appearance,editor,conversion,compare,shortcuts}`、`Appearance`、`EditorPrefs`、`ConversionPrefs`、`Theme`（`System`/`Light`/`Dark`，含 `label`/`from_label`/`next`）；`load`/`load_from`/`save`/`reset`/`reset_at`；`sanitize`（钳制字号 12–32、`tabWidth` 1–16、空白字体回落）、`clean_shortcuts`（去空键 / trim，**保留空值**＝显式解绑） |
| `core/paths.rs` | `app_data_dir()`：`%APPDATA%/AioTextEditor`（win）/ `~/Library/Application Support/AioTextEditor`（mac）/ `~/.config/AioTextEditor`（linux）；`replace.rs` 再导出保持既有路径 |
| `commands/settings.rs` | `settings_get()`（**永不失败**）/ `settings_save(s)`（返回**实际落盘值**）/ `settings_reset()`；均为轻量 `async fn`，不套 `spawn_blocking` |
| 前端 | `shared/shortcuts.ts`（命令注册表 + 规范化 + 冲突）、`store/settingsStore.ts`（改动即存 + 300ms 防抖 + 回执灌回）、`components/SettingsDialog.tsx`（五页签）、`App.tsx`（命令分发器 + 外观生效） |
| 契约 | `tests/stage8_contract.rs` 7 项：默认形状 / camelCase / `Theme` 小写 / `shortcuts` 映射 / 原子读写往返 / 坏文件恢复 / `reset` |

**宽容读取让别人去当类型裁判。** 最初的「默认 JSON 与小节 JSON 合并」（`merge_onto`）只按 JSON **类型**判断合法性——`"fluorescent"`（字符串）与默认 `"system"` 同型，非法值被留下，整段 `from_value` 因此失败，**一个坏字段陪葬一整节**。现改为 `recover_section::<T>`：把候选对象**逐字段**喂给 `T` 的 serde 反序列化，坏的丢、好的留——不在这层复制任何类型知识。

**主题切换只改 `color-scheme`。** 配色建立在 CSS 系统色（`Canvas` / `CanvasText` / `ButtonFace` …）之上，故 `theme` 只需映射到 `color-scheme`（`dark` / `light` / `light dark`）并同步 `data-theme` 供测试与调试观察，不需要第二套颜色变量。

**外观改动走 CodeMirror `Compartment` 原地重配**（行号 / 自动换行 / 缩进），保留撤销历史与滚动位置；字体族 / 字号通过 `.cm-content` 的 CSS 变量（`--editor-font-family` / `--editor-font-size`）下发，比较模式多窗格共用同一变量。

**默认键位用 `mod` 令牌。** 注册表默认键位写 `mod('s')`，模块加载时按平台解析成 `ctrl`（win/linux）或 `meta`（mac）。若写字面 `ctrl+s`，macOS 的 ⌘S / ⌘F 会静默失效——这是对第八阶段之前两处内联监听（`e.ctrlKey || e.metaKey`）的行为回退。

**`settings.json` 只存快捷键覆盖项**（三态：缺键＝默认 / 空串＝显式解绑 / 非空＝覆盖），默认键位唯一来源是前端注册表；「恢复默认」只需删键，不必把默认表复制到后端。

**规格 §11.2 的 `tauri-plugin-global-shortcut` 未采用**：那是系统级全局热键（应用不在前台也触发）。本阶段做的是应用内**命令分发器**（键位 → 命令 id → handler + `enabled` 守卫），并内置「系统保留键」黑名单（`Alt+F4` / `Alt+Tab` / macOS ⌘Q 等）在分配时拒绝。

### 10.8 稳定性收口落地结构（第九阶段）

| 模块 | 职责 |
|------|------|
| `store/toastStore.ts` | Toast 队列（纯状态层，可 node 直测）：`push` / `dismiss` / `clear`；四级别（`info` / `success` / `warn` / `error`）；默认停留 4s、**错误 8s**；同屏上限 4 条（超出丢最旧）；空消息不入队（沿用旧横幅「空串 = 不显示」的调用习惯） |
| `components/ToastHost.tsx` | 渲染容器：右下角堆叠，挂在 `App` 根部、`z-index: 200`（高于对话框遮罩 `100`，所以对话框里触发的提示也看得见）；`error` 用 `role="alert"`、其余 `role="status"`；每条自己管自动关闭定时器 |
| `core/session.rs` | 会话类型 + `load` / `save` / `clear`（以及 `*_from` / `*_at` 测试入口）；原子写；坏文件留 `.bad` 并**逐标签**恢复 |
| `commands/session.rs` | `session_load`（**永不失败**）/ `session_save`（回执实际落盘值）/ `session_clear` |
| `commands/app.rs` | `startup_metrics`（同步命令）/ `app_version` |
| `components/HelpDialog.tsx` | 帮助页：快捷键一览由 `COMMANDS` + 当前绑定渲染，附使用提示与「关于」 |
| 契约 | `tests/stage9_contract.rs` 10 项：会话形状 / camelCase / 逐标签往返 / 按需保存（`content: null`）/ 缺文件不报错 / 坏文件留备份 / 单坏标签不牵连 / 越界值纠正与回执 / 清除幂等 / 启动指标形状 |

**会话正文「按需保存」。** 会话里每个标签都记 id / 路径 / 编码 / 行尾 / 光标，但正文只在**磁盘上还原不出来**时才落盘（`dirty` 或从未保存过）。已保存的标签启动时从磁盘重读——文件可能已被外部改动，以磁盘为准；同时「打开十个大文件、一个字没改」的会话只有几 KB。前端对应逻辑集中在 `App.tsx` 的 `toSessionState`。

**`sessionReady` 闸门。** 会话装载完成前**禁止回写**，否则启动瞬间会拿空的 store 覆盖磁盘上的会话（等于清空用户会话）；恢复完成后才开始 300ms 防抖落盘。

**启动指标只量后端。** `setupMs` 的口径是 `run()` → `setup` 完成，**不含前端加载**（前端资源与 dev server 的快慢不该混进这条指标）。指标带 `debugBuild`，因为 dev 构建实测约 1.5s、发布构建才显著更低，「启动 < 1.5s」这条线只对发布构建成立。

**Toast 换掉单槽横幅但保留调用形状。** 旧实现是两个 `useState`（`error` / `notice`）渲染成的单条横幅，后一条会顶掉前一条；现在接到队列上即可堆叠。`setError` / `setNotice` 改为**模块级**函数：它们不依赖组件状态，既保持几十处调用点不变，也不必让各处 `useCallback` 依赖数组都去列它们。

**单实例必须第一个注册。** `tauri-plugin-single-instance` 要求在所有插件之前 `init`；回调只做「取消最小化 + 显示 + 聚焦」——`argv` / `cwd`（启动参数打开文件）留给后续，不在这里做半成品。

### 10.2 TextPro 数据（开放文本格式兼容包）

TextPro 的专属 `.dat` 数据文件已全部逆向并转换为开放文本格式（见[数据字典](./06-data-dictionary.md)），随包分发的是转换产物而非原始二进制：

| 文件 | 用途 | 使用方 |
|------|------|--------|
| `src-tauri/data/legacy/fc1.txt` | 完全等同异体字组表（1003 组） | F-06 文件比较"完全等同"档 |
| `src-tauri/data/legacy/fc2.txt` | 部分等同异体字组表（10579 组） | F-06 文件比较"部分等同"档 |

**不打包**：
- `s2t.dat`/`t2s.dat`（简↔繁单字表，与 OpenCC 词库同质，按 v0.3 决策由 OpenCC 取代）。
- `u2b1.dat`/`u2b2.dat`（BIG5 异体字/组字式回退表，按 v0.5 决策弃用）——编码互转改用 GitHub 上的 [`encoding_rs`](https://github.com/encoding-rs/encoding_rs)（WHATWG Encoding Standard 参考实现），原生支持 UTF-8、UTF-16、GBK、GB2312、GB18030、Big5、ISO-8859-1 等全部编码；不可编码字符按标准以 `&#xNNNN;` 数字字符引用写出。

### 10.3 解析器

- OpenCC 词典由 `opencc-sys` 内部托管，**自写 Rust 侧不参与解析**。
- TextPro 开放文本表加载器在 `src-tauri/src/core/data_tables.rs`，**独立可单测**——纯文本解析（UTF-8 BOM + CRLF + TSV/组行），无需任何二进制逆向逻辑。
- 所有词表打包时通过 `tauri.conf.json` 的 `bundle.resources` 列入安装包。

### 10.4 版权与归属

- OpenCC 词典版权：Copyright (C) Carbo Kuo et al. Apache License 2.0。
- TextPro 数据文件版权：Copyright (C) TextPro 作者 / 佛典网。继承兼容使用。
- 自定义替换表：用户自负责。

---

## 十一、平台差异

| 功能 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 启动参数 | `argv` | `RunEvent::Opened` | `argv` |
| 单实例 | `tauri-plugin-single-instance` | 同 | 同 |
| 打印 | WebView2 打印面板 | 原生 `NSPrintOperation` | CUPS / 打印到 PostScript |
| 文件关联 | 注册表 | LaunchServices | .desktop + xdg-mime |
| 字体 | Segoe UI / 宋体 | PingFang / 苹方 | Noto |
| TTS | `tauri-plugin-tts` | 系统 SpeechSynthesizer | `espeak` / `spd-say` |

---

## 十二、代码规范

- **Rust**：`rustfmt` + `clippy`（deny `unwrap_used`）。
- **TS**：`eslint` + `prettier`，强制 `strict: true`。
- **命名**：前端 kebab-case 文件名、Rust snake_case。
- **提交**：Conventional Commits（`feat:`、`fix:`、`docs:`）。

---

## 十三、依赖清单（初稿）

```toml
[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-shell = "2"
tauri-plugin-single-instance = "2"

serde = { version = "1", features = ["derive"] }
serde_json = "1"

encoding_rs = "0.8"
chardet = "0.3"
chardetng = "0.1"

aho-corasick = "1"
regex = "1"
memchr = "2"

rayon = "1"
tokio = { version = "1", features = ["full"] }
tokio-util = "0.7"
walkdir = "2"
notify = "7"

unicode-segmentation = "1"
hashbrown = "0.15"
similar = "2"

# 简繁转换引擎：OpenCC 1.4.2 静态链接（编译期嵌入词典）
# 锁定到包含 OpenCC 1.4.2 的 opencc-sys 版本（不自动跟 latest）
opencc-sys = "0.5"

tracing = "0.1"
tracing-subscriber = "0.3"
anyhow = "1"
thiserror = "2"

[dev-dependencies]
proptest = "1"
tempfile = "3"
```

---

## 十四、里程碑与版本计划

| 版本 | 周期 | 内容 |
|------|------|------|
| v0.5 | 第 1-3 周 | 项目骨架 + 编辑器 + 多编码 I/O + **OpenCC 集成与简繁** |
| v0.7 | 第 4-5 周 | **自定义替换表（独立 + OpenCC 内联）** + 中文正则 + 全部工具集 |
| v0.9 | 第 6-7 周 | 文件比较 + 文件合并 + 批处理（**含 OpenCC 步骤**） |
| v1.0 | 第 8 周 | 设置 / 快捷键 / 安装包 / 测试收口 / **OpenCC 17 种转换全部落地** |
| v1.1 | 第 9-10 周 | 自定义工具栏 + 打印 + 自动分段 |
