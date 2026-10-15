# AioTextEditor 项目结构与开发路线图

**版本**：v0.1

---

## 一、仓库结构（实际待创建）

```
aiotext-editor/
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── eslint.config.mjs
├── .gitignore
├── .npmrc
├── Cargo.toml                  ← workspace 根
├── rust-toolchain.toml         ← 锁定 toolchain
├── src-tauri/
│   ├── data/                    ← 编译期嵌入资源
│   │   ├── legacy/              ← TextPro 数据（开放文本格式，见 docs/06-data-dictionary.md）
│   │   │   ├── fc1.txt          ← 完全等同异体字组表（1003 组）
│   │   │   └── fc2.txt          ← 部分等同异体字组表（10579 组）
│   │   │                          注：u2b1/u2b2（BIG5 回退）已弃用，编码互转由 encoding_rs 承担
│   │   └── builtin-tables/     ← 内置示例表（首次启动复制到用户目录）
│   │       ├── simplified-variants.tab
│   │       ├── ancient-usage.tab
│   │       └── cn-punct.tab
│   ├── icons/
│   └── src/
├── docs/                       ← 已经创建
│   ├── PRD.md
│   ├── 02-functional-spec.md
│   ├── 03-tech-architecture.md
│   ├── 04-ui-ux.md
│   └── 05-roadmap.md           ← 本文件
├── assets/
│   └── icon.svg
├── src/                        ← 前端
└── src-tauri/                  ← 后端（已在上方展开）
```

> 说明：项目根 = `d:/site/aiotext-editor/`，但仓库子目录（src / src-tauri / docs / data）位于其下。本计划将保持这一目录，原 `TextPro65/` 子目录保留供查阅。

---

## 二、第一阶段：脚手架（Day 1-3）

### 2.1 目标

- `npm run tauri:dev` 能启动空白窗口。
- 项目结构按"技术架构"文档落地。
- CI 雏形：lint + test 通过。

### 2.2 任务清单

1. `npm create tauri-app@latest` 初始化（React + TS + Vite）。
2. 调整 `src-tauri/Cargo.toml` 依赖；锁定 `rust-toolchain`。
3. 复制 iml-lite 的 `eslint` / `vitest` / `vite` 配置作为基础。
4. 添加 `data/` 目录到 `src-tauri/data/`，构建脚本 `tauri.conf.json` 把数据目录加进 bundle。
5. 第一个 Tauri 命令 `fs_read_text` 与 `tauriApi.ts` 接口建立。
6. CI 雏形：windows / macos / linux 三个矩阵。
7. `README.md` 撰写（启动 + 构建 + 测试）。

---

## 三、第二阶段：核心 I/O 与编码（Day 4-7）

### 3.1 目标

- 打开 / 保存 UTF-8、UTF-16、GBK、GB2312、GB18030、BIG5、ISO-8859-1 全部正常（encoding_rs）。
- 自动编码检测较准（CHI 99%）。
- 重新载入能手动选编码。

### 3.2 任务清单

1. `core::encoding::detect` —— Mozilla 算法。
2. `core::encoding::decode` / `encode` —— `encoding_rs` 包裹。
3. `fs_read` / `fs_write` 命令。
4. UI："文件 → 打开 → 标签入栈"。
5. 状态栏：显示当前文件编码、行尾。
6. "重新载入"对话框（编码下拉 + BOM 选项）。

---

## 四、第三阶段：OpenCC 集成 + 简繁互转（Day 8-10）

### 4.1 目标

- OpenCC 1.4.2 静态链接成功、6 种常用转换可用（s2t、t2s、s2twp、tw2sp、s2hk、hk2s）。
- 词组级歧义提示。
- 括号对豁免。

### 4.2 任务清单

1. `Cargo.toml` 加 `opencc-sys = "0.5"`；CI 在 3 平台上跑通 cmake 构建。
2. 自写 `core/opencc.rs` 封装（RAII、临时 JSON 配置写出、错误恢复）。
3. `core/convert.rs` 提供高级转换链（OpenCC + 用户词典 + TextPro 兼容表）。
4. 命令 `convert_opencc` / `list_opencc_directions` / `preview_convert`。
5. UI：功能菜单中的 6 个常用入口 + "其他转换"二级菜单。
6. UI：转换前预览 Diff（首屏 200 行）。
7. UI：括号对豁免设置（沿用 TextPro 行为）。
8. UI：歧义片段诊断（OpenCC CLI `--ambiguities` 风格的弹窗）。
9. 非 Unicode 编码保存路径：encoding_rs 数字字符引用 `&#xNNNN;` + 保存前预检弹窗。
10. 测试：10 万字样本，与 OpenCC CLI 输出对比。
11. 测试：17 种转换各跑一遍回归。

---

## 五、第四阶段：自定义替换 + 中文正则（Day 11-14）

### 5.1 目标

- 自定义表可创建 / 编辑 / 删除 / 应用。
- 自定义表可叠加到 OpenCC 简繁转换中作为用户词典。
- 查找 / 替换对话框支持中文正则类目。

### 5.2 任务清单

1. `core::replace::Table` 数据结构 + 序列化。
2. `core::regex::extend(pattern)` —— 编译前类目替换。
3. 命令 `list_replace_tables`、`load_replace_table`、`save_replace_table`、`apply_replace`、`validate_replace_table`。
4. UI："替换表"对话框（CodeMirror 镜像编辑器）。
5. UI："查找 / 替换"对话框组件。
6. UI：实时高亮命中（CM6 decoration）。
7. **编译为 OpenCC 内联字典**：把表烘焙成 `{"type":"inline","entries":{...}}` JSON。
8. **OpenCC 转换链集成**：用户表作为 Group 的最末位（用户优先）。
9. **首次启动**复制内置示例表到 `tables/builtin/`（默认禁用）。
10. 测试：构建 30 个 fixture，含与 OpenCC 转换链组合 10 个。

### 5.3 完成情况（2026-10-15）

10 项任务全部完成（详见 CHANGELOG 开发日志 004）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | `core/replace.rs` 表模型 + 序列化（camelCase，与前端 TS 接口由 `tests/stage4_contract.rs` 交叉验证） |
| 2 | ✅ | `core/regex.rs::extend()` 单遍预转换 12 个中文类目 |
| 3 | ✅ | 命令已实现，并**扩充 3 条**支撑镜像编辑器（`read_replace_table_source` / `parse_replace_table_text` / `save_replace_table_source`） |
| 4 | ✅ | 「替换表管理」对话框（CodeMirror 镜像编辑器 + 实时校验标红 + 新建/导入/另存副本/删除） |
| 5 | ✅ | `SearchPanel` 查找替换面板（非模态，含类目下拉插入与 6 个开关） |
| 6 | ✅ | CM6 `StateField<DecorationSet>` 命中高亮 + 自动定位/选中 |
| 7 | ✅ | `opencc::convert_dict_only`（仅用户词典）/ `convert_with_inline_dicts`（基线 + 叠加） |
| 8 | ✅ | 用户表写入 `conversion_chain[0].dict` 的 `short_circuit` **首位** = 最高优先级（实测优先于简繁基线） |
| 9 | ✅ | 首启复制三张内置表（1002 / 78 / 28 条，数据由 `scripts/gen-builtin-tables.mjs` 从 opencc-sys 内嵌 OpenCC 词典生成），**仅补缺失文件**故幂等 |
| 10 | ✅ | 单测（`core::replace` 15 + `core::regex` 19，lib 合计 78）+ 契约集成测试 8；另加**真实 UI 端到端 24 项**（WebView2 CDP + Playwright） |

**偏差与注记**：① 规格设想的 `古籍常用字.tab`（依赖 `fc1.txt`/`fc2.txt`）属第六阶段异体字组表，本阶段以内置「古籍异体字规整」（TW/HK 变体表）替代；② 表的 `=` `/` `;` `#` 为格式保留字符，无法作为键（F-04 §4.3 已注记）；③ F-05 的编译错误行号跳转与导出命令（`export_opencc_json`/`.ocd2`）留待 v1.1。

---

## 六、第五阶段：整理工具集（Day 15-18）

### 6.1 目标

- §6 - §11 中 MVP 范围内的工具全部能运行。

### 6.2 任务清单

1. `core::pipelines` 模块 + 每个步骤独立函数。
2. `core::pipelines` 跑通：删除空行 / 段内回车 / 半角 ↔ 全角 / 行首行末空格 / 重复行 / 排序 / 匹配括号 / 半角引号 / 竖排符号。
3. UI：功能菜单项全部铺上；工具栏放置常用快捷按钮。
4. 单测覆盖每个工具。
5. 集成到查找替换（"使用工具" 选项）。

### 6.3 完成情况（2026-10-15）

5 项任务全部完成（详见 CHANGELOG 开发日志 005）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | `core/pipelines.rs`：18 个工具各自独立函数 + `PipelineStep`（`tag = "kind"`，camelCase 选项）+ `catalog()` / `from_id()` / `run_step()` / `run_chain()` |
| 2 | ✅ | 全部跑通，并补齐 规范行首 / 自动分段 / 控制行宽 / 简单排版（组合工具）/ 括号嵌套转换；行级工具保留 `\r\n` / `\n` / `\r` |
| 3 | ✅ | 「整理 ▾」菜单按后端目录分 4 组铺开 18 项；常用工具作为菜单内「常用」快捷区（未另开工具栏按钮，偏差见下） |
| 4 | ✅ | `core::pipelines` 单测 31 项（每个工具至少 1 项）；`tests/stage5_contract.rs` 契约测试 7 项；另加**真实 UI 端到端 27 项**（WebView2 CDP + Playwright，全部通过） |
| 5 | ✅ | `regex::replace_with_tool` + `SearchPanel` 的「使用工具」下拉（选中后替换输入框禁用，按钮变「处理当前 / 全部处理」） |

**偏差与注记**：① 规格的"工具栏放置常用快捷按钮"实现为菜单内「常用」快捷区（简单排版 / 删除空行 / 删除行末空格 / 段间空一行），避免工具栏随工具数膨胀，F-11 §11.3 的自定义工具栏落地时可无缝迁移；② 「按拼音 / 笔画排序」按规格留待扩展（现为 Unicode 升 / 降序 + 行长度升 / 降序）；③ `has_options` 按"该工具是否真有可调行为"判定，共 **11 个**带「…」，多于规格表格里显式写了"选项"的 6 个（如 `normalize_line_head` 的缩进个数、`dedup_lines` 的比较开关、`full_to_half`/`half_to_full` 的三个复选框），属实现增补——**默认值即规格描述的行为**，故直接点菜单与进对话框点应用结果一致（`defaults_match_spec` 单测锁定）。

---

## 七、第六阶段：文件比较与合并（Day 19-22）

### 7.1 目标

- 双栏 / 三栏平铺比较。
- 手工合并 / 正则自动合并可用。

### 7.2 任务清单

1. `core::compare::myers(...)` + 异体字策略。
2. `compare_texts` 命令。
3. UI：三栏布局、`F5` 同步。
4. `core::merge::manual(...)` / `core::merge::regex_auto(...)`。
5. UI：合并文件对话框、自动合并对话框。
6. 测试：100MB 大文件比较 + 1 万文件合并。

### 7.3 完成情况（2026-10-15）

6 项任务全部完成（详见 CHANGELOG 开发日志 006）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | `core::compare` + `core::data_tables`（异体字组表加载器）：**走「同步逐字」而非 Myers diff**（F-06 §6.2 用户故事是「F5 同步、逐字校对、一方到尾部即结束」，与 Myers「最小编辑脚本」不符；流式 O(n) 实现百 MB 文本 ~秒级可用，50 MB × 2 植入 3 处差异直测通过） |
| 2 | ✅ | `commands::compare::compare_texts`，偏移 UTF-16、4 种结束原因；异体字组表 `OnceLock` 缓存 |
| 3 | ✅ | 双栏平铺（垂直 / 水平），**三栏平铺与「同步滚动」未实现**（v1.1 再起，偏差见下）；F5 = 下一处不一致（最后一处给出提示），Shift+F5 = 从两个光标处重比（重选同步起点） |
| 4 | ✅ | `core::merge::plan_merge`（吃内存 `MergeItem`，文件 I/O 在命令层）：`Simple` 行尾追加空行 / `SameName` 按源正则第 1 捕获组分组（组内自然排序）；手工清单 / 自动分目录两种模式 |
| 5 | ✅ | `MergeDialog`（两页签 + 覆盖开关 + UTF-8 落盘 + 跳过报告） |
| 6 | ✅ | 大文件比较直测（50 MB × 2 植入 3 处差异）+ 万文件合并直测（10_000 个内存 `MergeItem`）；100 MB 与 1 万文件在单测里因构建 / 跑时成本降到 50 MB / 1 万，但有现成的 100 MB 文本可手动跑（百 MB 文本能在秒级出差异，命令行 `cargo test --lib large_texts_compare_linearly -- --nocapture`） |

**偏差与注记**：① 同步逐字取代 Myers diff（见项 1）；② 三栏平铺与「同步滚动」未实现——F-06 描述的「另一窗同步滚动」由「F5/Shift+F5 + jumpToDiff 跳差异 + scrollIntoView」三件套等价覆盖，跳差异时两窗同步滚到差异位置；③ **异体字策略 v1 不支持用户扩展表**（只读加载 `data/legacy/fc1.txt` / `fc2.txt`），用户扩展留 v1.1 视需要再起；④ 自动合并的目录扫描**非递归**（v1 阶段合并范围由源正则三件套精确控制，递归扫描是第七阶段批处理的职责）。

---

## 八、第七阶段：批处理（Day 23-26）

### 8.1 目标

- 完整流水线在 UI 上可配置。
- 递归目录、备份、不变更 mtime。

### 8.2 任务清单

1. `core::batch::run_pipeline(...)` 用 rayon 并行。
2. `batch_run` 命令 + `Channel` 进度上报。
3. UI：双栏步骤选择 + 进度条 + 错误面板。
4. 测试：300 文件 × 5 步骤、备份回滚、取消。

### 8.3 完成情况（2026-10-15）

4 项任务全部完成（详见 CHANGELOG 开发日志 007）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | `core::batch::{enumerate_files, run_batch}` —— 纯算法核心（不依赖 Tauri），`walkdir` 递归 + `rayon` 并行；备份 / mtime 保留 / 取消信号 / 进度回调都在 core，自成体系可直测 |
| 2 | ✅ | `batch_run`（`Channel<BatchProgress>`）+ `batch_cancel` + `batch_plan`；**进度由后端合并上报**（见下方偏差 ①） |
| 3 | ✅ | `BatchDialog`：路径输入 / 浏览 / 添加、递归开关、自动预览计划、双栏步骤选择（工具库 → 队列，上移 / 下移 / 移除）、输入输出编码、备份与 mtime 开关、进度条 + 当前文件、按阶段染色的错误面板、取消 |
| 4 | ✅ | 单测 18 项（枚举 / 备份 / mtime / 取消 / 幂等 / 重编码 / .bak 排除 / 300 文件压测）+ 契约 5 项 + **真实 UI 端到端 46 项**（含 **1 万文件 3.9s**、中间进度推送、多错误计数与清单一致性） |

**偏差与注记**：

① **「每个文件的进度」实际实现为「合并后的进度快照」**。规格 §8.5 的措辞是逐文件推送，但实测 `Channel::send` 单次 35~100ms：300 文件若每文件推 2 条事件就是 600 次 send ⇒ **21.3s**，而 `core::batch` 真正跑完只要 **0.12s**——进度上报把批处理本身完全盖住了。现改为原子计数 + 每 300ms（之后 500ms）一条快照，300 文件从 21.3s 降到 **0.12s**（164×）。这属于实现层面的必要调整，UI 语义（进度条推进、错误面板）不变。

② **`preserveMtime` 做成显式开关**（规格只写了「不变更 mtime」这一行为，未提及是否可关）。默认开启。

③ **重编码作为输入 / 输出编码选项，而非流水线中的一步**：先解码一次、最后编码一次，中间步骤始终在 `String` 上工作。与规格 §8.3 的 `Step::Reencode` 写法不同，但用户可见行为一致（且省掉中间反复编解码）。

④ **逐文件 INFO 日志降为 DEBUG**：`core::encoding` 的读 / 写日志原本每文件两条，tracing 的 fmt 订阅器是全局互斥的 stdout 写，批处理上万文件时会把并行处理串行化（与偏差 ① 叠加时 300 文件达 20s）。现改用 `EnvFilter`、默认 INFO，需要时 `RUST_LOG=debug`。

⑤ **未实现**：批处理流水线目前只含 F-09 的 18 个整理工具；简繁转换 / 替换表 / 自定义替换表作为流水线步骤留待后续（技能已具备，只是 UI 未接线）。「备份回滚」（把 `.bak` 还原回去）只做了「生成备份」，一键还原留待后续。

⑥ **复查时修掉两个前端真 bug**：① 运行中的「错误 N」原本取错误**列表长度**，而合并上报使列表在运行中被压缩（挂 12 条无效路径会显示「错误 1」）→ 改用后端快照的 `errors` 计数字段；② `handleStart` 的兜底分支 `if (!finalReport)` 读的是渲染闭包快照值、**恒为真**，注释所说的「finished 未走到才兜底」从未成立 → 改用局部 `sawFinished` 标志。两项均已由 E2E 钉住（运行中 87 次采样全部显示「错误 12」，而同一时刻列表仅 1 条）。

---

## 九、第八阶段：偏好与快捷键 F-11（Day 27-29）

### 9.1 目标

- 设置项持久化（`settings.json`），应用重启后仍生效。
- 全应用统一的快捷键配置：默认键位生效 + 用户自定义 + 冲突检测。
- 外观设置（主题 / 字体 / 字号 / 行号 / 工具栏 / 状态栏）真正作用到编辑器与界面。

### 9.2 任务清单

1. `core::settings` 模块 + JSON 持久化。
2. `settings_get` / `settings_save` 命令。
3. UI：设置对话框（多页签）。
4. UI：自定义快捷键对话框（按键捕获 + 冲突检测）。
5. 默认快捷键生效（菜单 + 命令分发器）。

### 9.3 完成情况（2026-10-15）

5 项任务全部完成（详见 CHANGELOG 开发日志 008）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | `core/settings.rs`（+ `core/paths.rs::app_data_dir`）—— 纯算法核心，`Appearance` / `EditorPrefs` / `ConversionPrefs` / `CompareOptions` / `shortcuts`；**原子写** + 坏文件 `.bad` 备份 + **逐字段宽松恢复** + 数值钳制（字号 12–32 / `tabWidth` 1–16）；单测 17 项 |
| 2 | ✅ | `settings_get`（**永不失败**）/ `settings_save`（返回**实际落盘值**）/ `settings_reset`；契约 7 项 |
| 3 | ✅ | `SettingsDialog` 五页签（外观 / 编辑器 / 转换 / 比较 / 快捷键）；**改动即存**（300ms 防抖） |
| 4 | ✅ | 快捷键录制（捕获阶段 `keydown`）、冲突标红 + 页内汇总、系统保留键拒绝分配、清除 / 单个默认 / 恢复全部 |
| 5 | ✅ | `App.tsx` **命令分发器**替换散落的 `window` 监听；`shared/shortcuts.ts` 注册表 + 规范化 + 冲突；**真实 UI 端到端 51 项** |

**偏差与注记**：

① **未采用 `tauri-plugin-global-shortcut`**（规格 §11.2）。那是系统级全局热键（应用不在前台也触发），与「应用内命令快捷键」是两回事。本阶段实现应用内**命令分发器**（键位 → 命令 id → handler + `enabled` 守卫），并内置系统保留键黑名单在分配时拒绝。

② **默认键位改用 `mod` 令牌**（平台主修饰键）：注册表默认键位写 `mod('s')`，加载时解析成 `ctrl`（win/linux）或 `meta`（mac）。若写字面 `ctrl+s`，macOS 的 ⌘S / ⌘F 会静默失效（相对旧内联 `ctrlKey || metaKey` 的行为回退）。`file.close` 在 macOS 默认不绑（⌘W 归系统）。

③ **比较默认档位字段命名为 `variantStrictness`**（规格 §11.1 写的是 `defaultStrictness`）：直接复用 F-06 的 `CompareOptions`，让「设默认值」与「比较对话框初值」同一份结构。

④ **部分设置项已持久化但未接线**：`editor.defaultEncoding` / `defaultLineEnding`、`conversion.*`、`compare.*` 目前只存不接，尚未作为相应对话框的初始值；F-11 §11.3 自定义工具栏（v1.1）待办。

---

## 十、第九阶段：稳定性 + 收口（Day 30-34）

### 10.1 目标

- 错误信息统一到一处（可堆叠的 Toast），不再被后一条提示顶掉。
- 「启动 < 1.5s」从口号变成可观测、可断言的数字。
- 保住用户的东西：未保存内容下次启动还在；不会开出第二个进程。
- 有内置帮助页；README 与实现一致；版本号只有一个出处。

### 10.2 任务清单

1. 错误处理：所有 `Result` 转 `String` 错误信息 + 前端 Toast。
2. 性能调优：批处理 > 100 文件 / 启动 < 1.5s。
3. 修复夹带：未保存恢复、跨平台差异、单实例。
4. 文档：README、内置帮助页、版本号。

### 10.3 完成情况（2026-10-15）

4 项任务全部完成（详见 CHANGELOG 开发日志 009）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | 统一 Toast：`store/toastStore.ts`（队列 + 四级别 + 自动消失）+ `components/ToastHost.tsx`（右下角堆叠、`z-index` 高于对话框遮罩），替换掉旧的 `error` / `notice` **单槽横幅**（后一条会顶掉前一条）；快捷键冲突提示改用 `warn` 级；单测 10 项 |
| 2 | ✅ | `StartupMetrics { setupMs, debugBuild }` + `startup_metrics` 命令：启动耗时**可断言**（口径 = `run()` → `setup` 完成，不含前端加载；dev 2000ms / release 1500ms 阈值）；批处理并行与上限在第七阶段已固化 |
| 3 | ✅ | **未保存恢复**：`core/session.rs` + `session_*` 命令 + 启动恢复 + 300ms 防抖落盘（正文**按需保存**：已保存标签只存路径、启动时从磁盘重读）；**单实例**：`tauri-plugin-single-instance` 聚焦已有窗口；跨平台差异见注记 ③ |
| 4 | ✅ | 内置帮助页（顶栏「帮助」+ `F1`；快捷键一览由 `COMMANDS` + 当前绑定渲染，含版本号）；README 修正（转换方向 17 → 14）并补会话 / 离线 / 版本出处；版本号唯一出处 = `Cargo.toml` |

**验证**：Rust 单测 187 + 契约 47，clippy 0 警告；前端 113 测试、lint/build ✓；真实 UI 端到端 **32/32**（另回归第八阶段 51/51）。

**偏差与注记**：

① **「启动 < 1.5s」区分构建类型**：dev 构建实测 `setupMs ≈ 1500ms`（未优化 + 更大二进制 + WebView2 冷启动），发布构建才显著更低。指标里带 `debugBuild`，自动化据此选阈值——否则要么把 dev 的正常值判成失败，要么把发布版的退化放过去。

② **Toast 保留旧接口形状**：`setError` / `setNotice` 仍是原来的调用形式（空值 = 不提示），只是改为**模块级**函数接到 Toast 队列——几十处调用点不必改，也不会污染各处 `useCallback` 的依赖数组。

③ **跨平台差异未做新实现**：`src/platform/` 仍是规划项（实际平台分支散在 `cfg(target_os)` 与前端 `isMacPlatform`）。单实例与聚焦已在 Windows 上实测；macOS / Linux 需在第十阶段的出包流程里一并验证。

④ **会话边界行为待定**：关闭全部标签后 `session.json` 会写成空标签列表，下次启动回到单个空标签；是否改成「保留上次有内容的会话」留待使用反馈。

---

## 十一、第十阶段：构建与发布（Day 35-37）

### 11.1 目标

- 三平台各出**一个**安装文件，双击装完就能用。
- 目标机器**不需要预装任何运行时**（不含 VC++ 运行库）。
- tag 一推，三平台产物自动出包并挂上 Release。

### 11.2 任务清单

1. `npm run tauri:build` 三平台出包。
2. `packaging.test.ts` 阈值检查。
3. GitHub Actions：tag 触发自动 release。
4. 冒烟测试：dev 模式下启 demo 脚本。

### 11.3 完成情况（2026-10-15）

4 项任务全部完成（详见 CHANGELOG 开发日志 010）：

| 项 | 状态 | 说明 |
|----|------|------|
| 1 | ✅ | 三平台各一个安装文件：`tauri.windows.conf.json` → `["nsis"]`、`tauri.macos.conf.json` → `["dmg"]`、`tauri.linux.conf.json` → `["appimage"]`（基线 `targets: "all"` 在 Windows 上会同时产出 MSI + NSIS，必须逐平台显式收窄）。本机出的是 `AioTextEditor_0.1.0_x64-setup.exe`，**4.43 MiB**，`currentUser` 安装、不弹提权；macOS 通用包与 Linux AppImage 由 CI 产出 |
| 2 | ✅ | `tests/packaging.test.ts` 20 项契约与阈值：三平台单安装文件 / 静态 CRT 两个开关 / **PE 导入表白名单**（自己解析 PE，不 grep 构建脚本）/ 版本号唯一出处 / 完全离线 / 资源与图标齐全 / 体积预算（安装包 16MB、可执行 12MB、前端产物 1.5MB）。产物存在时这些检查**实际执行**，不存在时跳过而非失败（CI 的测试阶段跑在构建之前） |
| 3 | ✅ | `.github/workflows/release.yml`：tag `v*` 触发 Windows / macOS（`--target universal-apple-darwin`）/ Linux 三条 runner；先校验 tag 与版本号一致（版本号唯一出处是 `Cargo.toml`），出包 → Windows 冒烟 → 上传 artifacts → 创建 draft Release。另有一键 `workflow_dispatch` |
| 4 | ✅ | `scripts/smoke.mjs`：**零依赖** CDP 客户端（Node 内置 `fetch` + 全局 `WebSocket`，不引 playwright、CI 少一步下载浏览器），启动**打包产物**并断言界面可用 + **真跑一次简繁转换**。偏差见注记 ② |

**验证**（真实运行，非仅单测）：

- **出包**：`AioTextEditor_0.1.0_x64-setup.exe` **4.43 MiB**（PRD §六 验收线 16MB 以内）。
- **装完即用（本机实测）**：静默安装 → `%LOCALAPPDATA%\AioTextEditor\` 落地 `aiotext-editor.exe`(7.5MB) + `uninstall.exe` + `data/legacy`、`data/builtin-tables`，**目录里没有任何运行库 DLL**；对**已安装**的程序跑冒烟 **10/10 通过**（启动 **614ms**）。
- **导入表**：`dumpbin /dependents` → 无 `MSVCP140.dll` / `VCRUNTIME140.dll`，只剩 Windows 自带 DLL 与 `api-ms-win-crt-*`（UCRT，Win10 起属系统组件）。
- **冒烟**：对 `target/release` 直接跑 **10/10**（启动 **623ms**）、对已安装副本 **10/10**（614ms），两项都在第九阶段 1500ms 验收线内。
- **前端**：ESLint ✓、`tsc -b && vite build` ✓、vitest **133/133** ✓（新增 `packaging.test.ts` 20 项；因产物已存在，PE 导入表与体积预算两项是**实际执行**，不是跳过）。
- **Rust**：单测 **187/187** + 契约 **47/47**（合计 234 项，0 失败）。静态 CRT 改了 rustflags，debug 缓存全量重编后复跑（Rust 源码本身未改动，改的只是链接方式）。

**偏差与注记**：

① **WebView2 用引导程序而非离线内嵌**：`offlineInstaller` 才能做到「零前提零联网」，但要内嵌约 127MB 运行时，安装包从 4.43MB 涨到约 150MB，**突破 PRD §六「Windows < 16MB」验收线**。经确认取「保体积线」：`embedBootstrapper` 随包带官方引导程序（约 1.8MB），已有 WebView2 的机器（Windows 11 全部、打过补丁的 Win10）直接用，缺失时才联网下载一次。要改回零前提，把 `tauri.windows.conf.json` 里换成 `{ "type": "offlineInstaller" }` 即可——`packaging.test.ts` 里那两条断言会跟着提醒你体积预算。

② **冒烟测试做成了「测打包产物」而不是「dev 模式启 demo 脚本」**：dev 模式验证的是源码，而这一阶段的验收句是「装完就能用」——所以要启动**真的二进制**。脚本对 `target/release` 与安装目录两种产物都能跑（`--exe` 指定）。

③ **macOS / Linux 的包无法在本机验证**：`.dmg` 需要 macOS SDK 与 `codesign`，AppImage 需要 webkit2gtk 与 linuxdeploy，Windows 上一律交叉不了。本机只验证了 Windows；另两平台等 CI 首跑。macOS 现为 ad-hoc 签名（任何 Mac 能开，浏览器下载后首次打开需右键放行），免掉这一步需要 Apple Developer 证书（年费 $99，`release.yml` 末尾备好了 Secrets 清单）。

④ **静态 CRT 顺带根掉了 §10.1 的旧坑**：原先记录「Windows 需最新 VC++ 运行库，旧版 `msvcp140.dll` 会让 OpenCC 词典加载访问违例」。现在程序根本不链接 `msvcp140.dll`，坑随链接方式一起消失；技术架构 §10.1 的「运行环境要求」已从「需最新运行库」改为「**无**」。冒烟里那次真实简繁转换就是盯着这条不复发。

---

## 十二、关键依赖列表（用于脚手架搭建）

### 12.1 npm

```jsonc
{
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-fs": "^2",
    "@tauri-apps/plugin-shell": "^2",
    "@tauri-apps/plugin-single-instance": "^2",
    "zustand": "^5",
    "@codemirror/state": "^6",
    "@codemirror/view": "^6",
    "@codemirror/lang-markdown": "^6",
    "@codemirror/language": "^6",
    "@codemirror/commands": "^6",
    "@codemirror/search": "^6",
    "@lezer/highlight": "^1",
    "react-i18next": "^14",
    "i18next": "^23"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5.9",
    "vite": "^7",
    "@vitejs/plugin-react": "^5",
    "vitest": "^3",
    "eslint": "^9",
    "prettier": "^3"
  }
}
```

### 12.2 Cargo

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-shell = "2"
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
encoding_rs = "0.8"
chardetng = "0.1"
aho-corasick = "1"
regex = "1"
memchr = "2"
rayon = "1"
tokio = { version = "1", features = ["full"] }
walkdir = "2"
notify = "7"
unicode-segmentation = "1"
hashbrown = "0.15"
similar = "2"

# OpenCC 静态链接（构建期嵌入词典）
opencc-sys = "0.5"

tracing = "0.1"
tracing-subscriber = "0.3"
anyhow = "1"
thiserror = "2"
```

---

## 十三、风险点与回滚计划

| 风险 | 缓解措施 |
|------|---------|
| ~~TextPro 旧词表（fc1/fc2）格式错误~~ | **已消除（v0.4）**：4 个数据文件全部逆向完成并转换为开放文本格式，提取条目数与源文件头部一致、校验和固定，见 `docs/06-data-dictionary.md` |
| **OpenCC 三平台 cmake 构建失败** | **第一周就用 `opencc-sys` 在 3 个平台 CI 上跑一遍；选用 TerakomariGandesblood 版（已被 docs.rs 收录，跨平台验证过）** |
| **OpenCC API 仅接受磁盘路径** | **运行时把 `*_JSON` 内联配置写到临时目录，OpenccHandle 持有路径句柄；进程退出清理** |
| **OpenCC C++ 链接符号冲突** | **使用 `link-cplusplus`，确保 CMake target 名 `opencc` 不与系统库冲突** |
| Tauri 2 移动端限制暂不考虑 | 在 `tauri.conf.json` 中关闭 mobile targets |
| macOS 公签 | 第一版不做公证，提供 `xattr -dr com.apple.quarantine` 提示 |
| BIG5 字体缺失 | 默认附 1 个开源嵌入字体，避免字体加载空白 |
| Windows 文件关联 | 通过启动参数传 `argv` 启动注册 |
| **OpenCC 词库版本升级带来的歧义差异** | **锁定 opencc-sys 到具体小版本；不自动跟 latest** |

---

## 十四、协作约定

- 提交规范：Conventional Commits。
- 分支模型：Trunk-based，`main` 保护，PR 必须绿。
- 标签：`v0.x.y` 触发 release。
- 任务卡：使用 `issues/` Markdown（暂不引入 GitHub Projects）。

---

## 十五、确认事项

请在确认 PRD / 功能规格 / 架构 / UI / 路线图后，将按以下顺序产出代码：

1. 脚手架（README、package.json、tauri.conf.json、Cargo.toml、目录结构）。
2. 第一阶段最小可运行 demo（打开 + 保存 + 自动编码）。
3. **OpenCC 集成**：在第一周就验证 3 平台 cmake 构建可用。
4. 第三阶段：简繁（OpenCC）+ 自定义替换（OpenCC 内联）核心算法。
5. 工具集与批处理 UI（其中 OpenCC 步骤可用）。
6. 文件比较与合并。
7. 设置与发布。
