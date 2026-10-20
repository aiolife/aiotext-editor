# AioTextEditor 文档修订记录

> 每次重大变更在此记录，便于追溯。

---

## v0.6 — 2026-10-18

### 主要变更：视图 / 编辑 补格 + 统计口径 + 批处理白底

用户实测续提 3 条：视图菜单要在「自动换行」下加 **不可见字符三开关 + 三个统计**；编辑菜单要在「查找」前加 **撤销 / 重做 / 跳转**；批处理面板**不要灰底**，要白底黑字带外包框。

#### 1. 视图 → 显示空格字符 ☑ / 显示行尾字符 ☑ / 显示换段符 ☑

三个开关（持久化到 `appearance.showSpaces` / `showLineEnds` / `showParagraphMarks`，默认关闭）由 CodeMirror 的 **decoration** 画出：`·`（空格）、`→`（制表符）、`¬`（行尾）、`¶`（段落最后一行）。

符号**不进文档**：是 `Decoration.replace`（空白位）+ `Decoration.widget`（行尾）画出来的一层装饰，编辑、选中、复制、保存、字数统计一律按真实字符走。同一个位置同时存在时**优先画 `¶`**（换段符），避免两个符号叠成一团。

#### 2. 视图 → 字数统计 / 统计选定文字出现的次数 / 显示段落数

口径（写在 `src/shared/textStats.ts`，有单测锁定）：

| 指标 | 口径 |
|------|------|
| 字数 | 不计空格（含全角空格 `U+3000`）与控制符；**代理对算 1 个字符**（用 `Array.from` 而不是 `.length`，否则 `𩅯` 会数成 2） |
| 段落数 | 非空行数——与整理工具「段间空一行」（每段 = 一个非空行）**同口径**，不能各说各话 |
| 选定文字出现次数 | 全文范围内**不重叠**计数；没选中文字时给提示而不是返回怪值（空串返回 0） |

结果用一个通用的 `StatDialog` 展示（多行数塞状态栏会挤成一团）。

#### 3. 编辑 → 撤销 / 重做 /（分隔）跳转…

- 撤销 / 重做：撤销历史在 CodeMirror 的 view 里，只有 `view.dispatch` 能动，所以 App 只**发意图**（`EditorCommand` + 自增 nonce），由 `Editor` 执行一次。**刻意不给默认键位**——`Mod+Z` 已由 `historyKeymap` 处理，再绑一份会一次撤销两步。
- 跳转（`Ctrl+G`）：`GotoDialog` 输入行号 → 滚动到视口居中并**选中整行**（比只挪光标醒目）。

#### 4. 批处理面板：白底黑字 + 外包框

原来面板背景跟着系统画布色（`canvas`），深色 / 深灰主题下整块发灰、和后面的半透明遮罩糊在一起。现在把它**固定成白底黑字**（连带输入框、下拉、列表一起），并补上 `border` + `box-shadow` 作为外包框。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | §3.5 菜单表：编辑行加「撤销 / 重做 / 跳转…」，视图行加 3 个不可见字符开关 + 3 个统计项 |
| `04-ui-ux.md` | §2.2 编辑表标注「转到某行」已落地；§2.3 视图补齐 6 项 + 不可见字符说明 + 统计口径表 |
| `CHANGELOG.md` | 本条目 |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src-tauri/src/core/settings.rs` | `Appearance` 新增 `show_spaces` / `show_line_ends` / `show_paragraph_marks`（默认 false），单测 `defaults_match_spec` 加断言 |
| `src/platform/tauriApi.ts`、`src/store/settingsStore.ts` | `AppearanceSettings` 与前端默认值同步三个字段 |
| `src/components/Editor.tsx` | 新增 `invisibleCompartment` + `SymbolWidget` / `buildInvisible` / `invisibleExt`（viewport 内逐个换空格、行尾画符号）；新增 `EditorCommand` 意图通道（撤销 / 重做 / 跳转）并按 nonce 执行一次 |
| `src/shared/textStats.ts`（新增） | `countTextStats` / `countOccurrences`：码点计数、忽略空白与控制符、段落 = 非空行、不重叠计数 |
| `src/shared/textStats.test.ts`（新增） | 10 个用例锁定上述口径（代理对、全角空格、空文档、CRLF、重叠计数等） |
| `src/shared/shortcuts.ts` | 命令表新增 `edit.undo` / `edit.redo` / `edit.goto`（`Ctrl+G`）、`view.toggleSpaces` / `view.toggleLineEnds` / `view.toggleParagraphMarks`、`doc.stats` / `doc.countSelected` / `doc.paragraphCount` |
| `src/components/StatDialog.tsx`（新增）、`GotoDialog.tsx`（新增） | 统计结果对话框（通用 rows）、跳转到行对话框（行号校验 + 回车确认） |
| `src/components/MenuBar.tsx` | 视图菜单插 3 个勾选 + 3 个统计；编辑菜单头部插 撤销 / 重做 / 分隔 / 跳转…；新增 `invisible` props |
| `src/App.tsx` | 新增 `sendEditorCommand`、`handleDocStats` / `handleCountSelected` / `handleParagraphCount`；handlers 注册 9 条新命令；`Editor` 传 `commandRequest`；渲染两个新对话框 |
| `src/styles/global.css` | `.cm-invisible*`（符号配色）、`.doc-stats*`（统计表）、`.dialog-narrow`；`.batch-dialog-textpro` 改白底黑字 + 外包框（连内部控件一起） |
| `scripts/smoke.mjs` | 新增 3 条断言：视图菜单 6 项在位且勾选项 7 个、编辑菜单头部 撤销 / 重做 / 跳转、批处理面板 `getComputedStyle` 背景为 `rgb(255,255,255)`、文字为 `rgb(0,0,0)` |

### 决策

1. **不可见字符用 decoration 而不是改文档**：改文档会让复制、保存、字数统计全被污染；装饰层零副作用。
2. **撤销 / 重做不绑默认键**：`Mod+Z` 本来就是 `historyKeymap` 的，菜单也能点就够了，重绑会双触发。
3. **统计口径与工具对齐**：段落数按「非空行」，与 `insert_blank_between` 一致——否则「工具插了 9 个空行、这边说只有 3 段」自相矛盾。
4. **批处理白底写死而不是跟主题**：它是功能面板不是内容区，需求明确要白（校对/对照时和深色编辑器形成反差反而难读，故保持系统色的是编辑器）。

### 验证

`cargo test` **237 全过**；`npm run test` **152/152**（含新增 10 个统计用例）；`npm run build` 通过；`eslint src` **0 问题**；`npm run smoke` **22/22**——其中「显示空格字符」是新加的**真实渲染断言**（CDP 灌入 `a b\nc` → 勾选后 `.cm-invisible-space` 由 0 个变 1 个），批处理白底则用 `getComputedStyle` 断言背景 `rgb(255,255,255)`、文字 `rgb(0,0,0)`。

---

## v0.9 — 2026-10-18

### 主要变更：菜单重整 + 排版类工具 + 启动加速 + 空白页

用户一口气提了五条：菜单要按用途分开、「功能」改名「排版」并补五个排版能力、打开要快、
关掉所有标签后别再显示一堆文字。其中「先验证再改」是这次的流程要求，故先出方案、
确认口径后再动手（见文末「决策」）。

#### 1. 顶栏：`文件 编辑 简繁 排版 视图 帮助`

- **「简繁」**（新增，位于「编辑」与「排版」之间）：只装简繁转换 —— 6 个方向直接点用
  （无二级菜单）+ 「转换预览…」。能力没变，只是从原「功能」菜单里搬出来单独立门户。
- **「排版」**（原「功能」改名）：只露出 **5 个排版类工具 + 6 个高频直点项**。
- 顺手删掉了 `ConvertMenu.tsx`（早已无人引用，且引用着已删除的 `direction.common` 字段）。

#### 2. 「排版」菜单：18 项 → 11 项，能力一条没删

原先 18 个细项平铺，找功能要翻半天。现在：

```
排版
  ┌ 排版规范 ─────────────────
  │ 规范标点…    网文排版…    中文文案…
  │ 技术文档…    片段处理…
  ├ 常用（直接点用）──────────
  │ 删除行首行末空格   删除空行   段间空一行
  │ 全角转半角…        半角转全角… 简单排版…
  └───────────────────────────
```

其余 13 个步骤**不再各占一个菜单项**，而是收进「规范标点」「片段处理」的选项里
（括号检查、排序、去重、删半角、合并段内回车…）。它们仍然可被 `from_id` 构造，
批处理（F-08）的流水线照旧选得到 —— 单测 `internal_steps_are_still_constructible`
与契约测试专门盯这件事，防止「菜单不露出」被误做成「能力被删掉」。

#### 3. 五个排版类工具

| 工具 | 规则来源 | 做什么 |
|------|---------|--------|
| 规范标点 | GB/T 15834-2011 | 引号体系（大陆 “”‘’ / 港澳台 「」『』 / 不动）、省略号统一 `……`、破折号统一 `——`、中文语境里的半角标点转全角、竖排符号横转、括号配对检查与嵌套改写 |
| 网文排版 | `vscode-pangu2` | 中英文 / 中数之间补空格（**跳过 URL 与行内代码**）、去掉全角标点旁的多余空格、清理行尾空格、段首缩进 |
| 中文文案 | `chinese-copywriting-guidelines` | 中英空格 + 标点后不留空格 + 重复标点合并（`！！`→`！`）+ 省略号 / 破折号 + 数字与单位补空格（`100kg`→`100 kg`） |
| 技术文档 | `Snippet-Scripts` + 常见中文技术写作约定 | Markdown：标题空格、列表符号统一 `-`、代码围栏前后补空行、行尾去空格、围栏外的中英空格、末尾补换行；**围栏内一律不动** |
| 片段处理 | `Snippet-Scripts` | 行级批处理：去两端空格 / 删空行 / 段间空一行 / 去重 / 排序（4 种）/ 删半角 / 合并段内回车 —— 原菜单细项收在这里 |

三条共同约束：

1. **幂等**：任意规则组合跑两遍结果不变（每个工具都有 `*_is_idempotent` 单测）。
2. **有选项就有预览**：全部走既有的「配置 → 实时预览 → 应用到整篇或选区」，结果可 `Ctrl+Z`。
3. **不该动的地方不动**：URL、行内代码、Markdown 代码围栏内部一律跳过。

#### 4. 启动加速（四项）

| # | 问题 | 做法 | 实测 |
|---|---|---|---|
| ① | 会话恢复**串行**读盘（`for … await fsRead`） | 改 `Promise.all` 并发，顺序仍按会话原序还原 | 5 个 1.4MB 文件：**串行 ~150ms → 并发 ~71ms** |
| ② | Rust `setup` 里**同步**复制内置替换表，压在建窗之前 | 挪到后台线程（复制本就幂等，命令层 `ensure_replace_tables` 还会同步兜一次） | 首次启动不再为几十个文件的拷贝付建窗前的等待 |
| ③ | 首屏 bundle 无分割（CodeMirror + 全部对话框同包） | 7 个对话框改 `React.lazy`（编辑器**不拆**，它是启动后立刻要用的） | 主包 **624KB → 571KB**，拆出 7 个 chunk |
| ④ | 设置是异步读的 → 主题 / 字号「先默认值再跳一下」 | 上次生效的设置缓存进 localStorage，首帧即用，`load()` 回来后再校正 | 深色主题用户不再看到浅色闪一帧 |

端到端（发布构建，热启动，同机 3 轮中位数）：**双击到编辑器可用 ≈ 870ms**，
后端 `setup` ≈ 590ms。冷启动（首次 / 杀毒扫描）会明显更高——冒烟里那个
`setupMs` 数字受机器负载影响大，别拿单次值下结论。

#### 5. 关掉所有标签后是**空白**

`App.tsx` 里那段欢迎语 + 功能介绍（含 `<code>` 的几行）整块删掉，只留一个空容器。
冒烟新增断言盯着它：`关掉所有标签后编辑区留白（不显示任何文字）`。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | §3.5 菜单表：新增「简繁」行、「功能」→「排版」；T-7 验收改为两条菜单的结构断言 |
| `04-ui-ux.md` | 菜单归并表：§2.5「功能」拆成「简繁 / 排版」两条 |
| `02-functional-spec.md` | F-09 新增 6 个步骤的说明表，并写明「菜单露出 11 项、其余步骤仍可构造」 |
| `CHANGELOG.md` | 本条目 |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src-tauri/src/core/pipelines.rs` | 新增 5 组选项结构与 6 个 `PipelineStep` 变体；实现 `normalize_punctuation` / `web_novel_layout` / `chinese_copywriting` / `tech_doc_layout` / `snippet_process` / `trim_both`；`catalog()` 由 18 项收成 11 项；新增 11 个单测（含 5 个幂等测试） |
| `src-tauri/src/lib.rs` | 内置替换表复制移到后台线程 |
| `src-tauri/tests/stage5_contract.rs` | 契约测试改为「11 项 + 5 个排版工具必在目录 + 内部步骤仍可构造」 |
| `src/components/MenuBar.tsx` | 「功能」拆成 `convertMenu`（简繁）与 `layoutMenu`（排版），菜单数组改为六条 |
| `src/components/ToolOptionsDialog.tsx` | 新增 5 个工具的表单字段（声明式 schema） |
| `src/platform/tauriApi.ts` | `ToolId` +6、`ToolOptions` 字段 + 默认值表 |
| `src/App.tsx` | 会话恢复并行化；7 个对话框改 `lazy` + `Suspense`；空白页去掉文字 |
| `src/store/settingsStore.ts` | 设置缓存（首帧用上次值） |
| `scripts/smoke.mjs` | 菜单断言改写（简繁 6 方向 / 排版 11 项 2 组）、新增空白页断言、**新增 6 条排版工具端到端断言**（菜单 → 选项 → 预览 → 应用，逐字比对编辑器里的最终结果） |
| `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` | 版本号 `0.1.0` → **`0.9.0`**（三处统一；此前只有文档写 v0.9，安装包仍叫 `AioTextEditor_0.1.0_x64-setup.exe`） |
| `src/platform/tauriApi.test.ts` | 工具默认值表同步到 24 项并锁住排版类工具的默认值 |

另删除死代码 `src/components/ConvertMenu.tsx`。

### 决策

1. **先量再改，改完复测**：启动优化没有「凭感觉调参」，串行 / 并行的收益是页面内同条件
   各跑一遍量出来的（150ms vs 71ms），包体变化看构建产物，端到端取 3 轮中位数。
2. **菜单收短 ≠ 删能力**：13 个步骤从菜单消失，但全部保留为可构造步骤，并用单测 + 契约测试
   把「还能用」这件事钉住。
3. **编辑器不拆包**：`lazy` 只用于「可能不会打开」的对话框；编辑器拆了只会把「能打字」往后推。
4. **规则都要幂等**：排版类工具会被反复点、也会被串进批处理流水线，跑两遍结果变了就是 bug。
5. **不为了统一而误伤**：URL / 行内代码 / Markdown 代码围栏内部一律跳过 —— 把
   `https://…` 打散成 `https: // …` 比不改更糟。

### 验证

`cargo test` **249 全过**（新增 11 项）；`npm run test` **156/156**；
`eslint src scripts` **0 问题**；`npm run tauri:build` 通过（**4.45 MiB**）；
`npm run smoke` **36/36**（新增 3 条菜单断言 + 1 条空白页断言 + **6 条排版端到端断言**）。

菜单结构只能证明「入口在」，所以最后在**真实应用里把五个工具各点了一遍**
（菜单 → 选项对话框 → 预览 → 应用），并把这条路径固化成了冒烟断言，以后每次打包都会重跑：

```
✓ 排版端到端：规范标点     他说"你好",真的吗? → 他说“你好”，真的吗？
                          等等... → 等等……   他--走了 → 他——走了   甲︐乙 → 甲，乙
✓ 排版端到端：网文排版     第1章 起点 → 　　第 1 章 起点
                          见 https://a.com/x?y=1 不动 ← URL 未被打散
✓ 排版端到端：中文文案     中文， abc！！重量100kg → 中文，abc！重量 100 kg
✓ 排版端到端：技术文档     #标题 → # 标题   * 项目 → - 项目
                          ``` 前后补空行，围栏内的 code中文 原样不动
✓ 排版端到端：片段处理     "  b  \n  a  \n\nb" → "b\na\nb"
✓ 排版端到端：常用项：删除行首行末空格（不弹对话框，直接应用）
✓ 关掉所有标签后编辑区留白（不显示任何文字）  [空白区文字 0 字]
```

整轮界面操作下来**页面运行时错误 0 条**。

---

## v0.8 — 2026-10-18

### 主要变更：打开 / 编辑的运行速度

用户反馈「打开及正常编辑文件的运行速度」。先量再改，结果定位到一个**上一轮自己引入的热路径**：

v0.7 把状态栏计数换成 `countTextStats`（汉字 / 单词 / 字节）之后，这个函数就成了**每次改文档都要跑一遍全文**的热点 ——
而它原先是「点一次菜单算一次」的写法，没有为热路径优化过。1 MB 文档上一次扫描 256 ms，打字肉眼可见地卡。

#### 1. `countTextStats`：一次扫描、零分配

原实现有两处大开销：

- `Array.from(text)`：先复制出一个几百万元素的数组，再遍历它；
- 逐字符 `\p{L}` 正则：每个字符一次正则调用，几百万次下来占了大头。

改成：

- 直接扫 UTF-16 code unit，遇到代理对**就地合成码点**（`𩅯` 仍然算 1 个字符）；
- UTF-8 字节数按码点宽度累加，不再 `TextEncoder.encode` 出一份完整 buffer；
- 分类先查表：ASCII 走快路径，汉字 / 中文标点 / 常见字母区（假名、谚文、拉丁扩展…）用码点范围判断，
  **只有表外的陌生字符**才退化到 `\p{L}` 正则。

实测（`vitest run` 里同一份基准脚本，Windows / Node 24）：

| 文本规模 | 改前 | 改后 | 提速 |
|---|---|---|---|
| 200 K 字符 | 54.4 ms | 4.4 ms | 12× |
| 1 M 字符 | 256.0 ms | 22.7 ms | 11× |
| 4 M 字符 | 972.2 ms | 73.1 ms | 13× |

口径没变：13 个统计单测（代理对、全角空格、CRLF、混排归类、两种段落口径…）原样全过。

#### 2. 状态栏计数不再跟打字抢 CPU

`StatusBar` 改为 `useDeferredValue` + `useMemo`：

- ≤ 20 万字符**就地算**（这个量级只要几毫秒，没必要让数字迟钝一拍）；
- 更大的文档走**延迟值**：数字滞后一帧，把 CPU 让给正在输入的人。

#### 3. 端到端实测（同口径对比）

「输入一个字 → 状态栏真正刷新」的时间，文档规模都是 ≈160 K 字符：

| | 改前 | 改后 |
|---|---|---|
| 单次输入延迟 | **41.8 ms**（超过 2.5 帧，肉眼可感） | **6.8 ms** |

#### 关于「一次性插入 2000 行约 12 秒」（诚实说明）

冒烟里顺手量了这个数字，但**它不代表应用的编辑速度**：同一趟用 `PerformanceObserver` 记录
大于 50 ms 的长任务，**总和是 0 ms** —— 主线程几乎没在干活，那 12 秒是 CDP `Input.insertText`
合成 36 K 字符的成本（真实粘贴 / 打开文件在 CodeMirror 里是一次 transaction）。
所以这一项只作为信息输出，**不做断言**，免得以后有人拿它当性能基线。

#### 顺手做的两件事

- **`smoke.mjs` 跑完抹掉 `session.json`**：冒烟会往文档里灌几十 K 字符并留下未保存标签，不该污染用户的下次启动。
- 顺带确认了**不可见字符开关不是瓶颈**：同一趟大块插入，三个符号开关全开 11.9 s / 全关 12.5 s，
  差异在噪声内（之前担心 decoration 拖慢编辑，实测没有）。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `04-ui-ux.md` | §4.2 状态栏：说明大文档的计数会滞后一帧的原因，以及三项计数的口径出处 |
| `CHANGELOG.md` | 本条目 |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src/shared/textStats.ts` | 重写 `countTextStats` 为单次零分配扫描（码点合成 + 查表分类 + 按宽度累加字节数）；API 与返回值不变 |
| `src/shared/textStats.test.ts` | 口径单测保持 13 个，全部通过（未放宽任何断言） |
| `src/components/StatusBar.tsx` | 计数改 `useDeferredValue` + `useMemo`；≤20 万字符即时算，更长的文档延迟算 |
| `scripts/smoke.mjs` | 新增「性能预算」测量：页面内用 `MutationObserver` 记「`beforeinput` → 状态栏 DOM 更新」的真实延迟；三条断言（空文档 <20 ms、160 K 文档 <15 ms）；`PERF_AB=1` 时可打印长任务诊断 |

### 决策

1. **先量再改**：一边 Perry 猜热点，一边用 `vitest` 基准 + 页面内计时把数字摆出来；改完用同一套数字复测。
2. **不为了快牺牲口径**：13 个单测一条没放宽，代理对 / 全角空格 / CRLF 的行为全部保持。
3. **热路径零分配原则**：面向「点一次菜单」的函数可以不讲分配，面向「每敲一个字」的不行——
   `Array.from` 与 `TextEncoder` 这两处大分配拿掉后，剩下的就是查表和整数运算。
4. **不给「明明是工具开销」的数字做断言**：`Input.insertText` 那 12 秒跟应用无关，写成断言只会让大家不停地为别人的开销买单。

### 验证

`cargo test` **237 全过**；`npm run test` **155/155**；`npm run build` 通过；`eslint src scripts` **0 问题**；`npm run smoke` **27/27**。

```
✓ 性能：空文档里单次输入到状态栏刷新 < 20ms        [3ms]
✓ 性能：大文档（≈160K 字符）里单次输入 < 15ms      [6.8ms · 文档汉字 5 → 60005]
   · 性能实测：单次输入 3ms（空文档） / 6.8ms（160K 字符文档）
```

---

## v0.7 — 2026-10-18

### 主要变更：批处理 18px 留白 / 字数统计多维度 / 不可见字符开关搬家并默认勾选

用户实测续提 3 条，随后又追加 1 条（共 4 条）：

1. 批处理对话框**四周要留 18px 空白**；
2. 字数统计要给出**多维度**（汉字、中文标点、字母、单词、英文标点、数字、数字组、三种字符数口径、段落数、非空行数、字节数）；
3. 不可见字符三开关搬到 **选项 → 编辑器** 里，**默认勾选**；
4. 状态栏右侧的计数改成 **汉字 / 单词数 / 字节数**（原来是「N 字符（M 码元）」）。

#### 1. 批处理面板：四边 18px 留白

18px 统一加在面板外层（`padding: 18px`），header / `.batch-section` / footer 的**横向** padding 归零——
否则会和原来的 `16px` 叠成 `34px`。全局 `* { box-sizing: border-box }` 保证面板总宽仍是 760px（内容区收窄），
横向 Guardrail：`px: 18 18 18 18`。

#### 2. 字数统计：13 项多维度

新增维度（口径在 `src/shared/textStats.ts`，单测锁定）：

| 维度 | 口径 |
|------|------|
| 中文字数（汉字） | CJK 主区 + 扩展区 + 兼容表意文字，`々` `〇` 也算 |
| 中文标点 | `、` `。` `「」` `【】` `……` `——` 及全角形标点（不含全角空格 `U+3000`） |
| 字母个数 | 所有 Unicode 字母；汉字不计入（否则 `\p{L}` 会把汉字当字母） |
| 单词个数 | 连续字母/数字为一词（可含 `'` `-`）；**汉字不算词** |
| 英文标点 | ASCII 标点 |
| 数字个数 / 数字组 | 十进制数字符个数 / 连续数字为一组的组数 |
| 段落数 / 非空行数 | **两个口径分列**：段落 = 空行分隔的连续非空行块；非空行数 = trim 后非空的行数 |

> 「段落数」与「非空行数」不再同义：统计描述的是**当前文本**（`甲\n乙` 是 1 段 2 个非空行），
> 而「段间空一行」**工具**把每个非空行当作一段（它会给它们插空行）——两者用途不同，
> 对话框里在各自的 hint 里写清楚了。

#### 4. 状态栏计数：汉字 / 单词 / 字节

状态栏右端原来显示 `1234 字符（1234 码元）`——码元（UTF-16 code unit）是给调试看的，
用户扫一眼真正关心的是**写了多少汉字、多少个词、多少字节**。现改为：

```
汉字 42 · 单词 3 · 128 字节
```

用的是**同一个 `countTextStats`**（和「视图 → 字数统计」一致），所以两处数字永远对得上；
tooltip 里重复一遍并补上「UTF-8」。状态栏只放这三项，13 项完整统计仍在字数统计对话框里。

#### 3. 不可见字符三开关：移入「选项 → 编辑器」并默认勾选

视图菜单里的三个勾选项撤掉，改成 `SettingsDialog` 编辑器页的三个 `Row`（`appearance.showSpaces` /
`showLineEnds` / `showParagraphMarks`），**默认全勾**（后端 `Appearance::default()` 同步改 true，
Rust 单测 `defaults_match_spec` 加了断言）。命令 `view.toggleSpaces` 等三个仍保留在注册表里，
想在菜单外切换可以去「自定义快捷键」给它们绑键。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | §3.5 视图菜单行：撤掉三个勾选项，注明开关在「选项 → 编辑器」 |
| `04-ui-ux.md` | §2.3 重写：统计多维度口径表 + 不可见字符开关的新位置与默认值 |
| `CHANGELOG.md` | 本条目 |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src/shared/textStats.ts` | `TextStats` 扩到 13 项；新增汉字 / 中文标点 / 单词 / 数字组分类（`isHan`、`isChinesePunct`、`countRuns`）；`paragraphs` 改为「空行分隔的块」，另加 `nonEmptyLines` |
| `src/shared/textStats.test.ts` | 新增 4 个用例（混排归类、连字符断词、代理对汉字、两种段落口径） |
| `src/App.tsx` | `handleDocStats` 输出 13 项并两列显示；`handleParagraphCount` 加「非空行数」；`StatCtx` 增 `columns` |
| `src/components/StatDialog.tsx` | 新增 `columns?: 1 \| 2` 与 `.dialog-wide` |
| `src/components/SettingsDialog.tsx` | 编辑器页新增三个 `Row`（显示空格 / 行尾 / 换段符） |
| `src/components/MenuBar.tsx`、`src/App.tsx` | 视图菜单撤掉三个勾选项与 `invisible` props（开关改在设置里） |
| `src-tauri/src/core/settings.rs` | `Appearance::default()` 三开关改 `true`；单测断言改为「默认勾选」 |
| `src/store/settingsStore.ts` | 前端默认值同步为 `true` |
| `src/styles/global.css` | `.batch-dialog.batch-dialog-textpro { padding: 18px }` + header/section/footer 横向 padding 归零；`.doc-stats-2col`、`.dialog-wide` |
| `src/components/StatusBar.tsx` | 右侧计数由 `countChars`（码点 / 码元）换成 `countTextStats` 的 `汉字 N · 单词 M · B 字节`，tooltip 补「UTF-8」 |
| `scripts/smoke.mjs` | 断言改为：视图菜单 4 个勾选项且不含三个开关、**默认勾选下**符号就画出来、选项 → 编辑器三个开关默认勾选、字数统计 ≥13 项且关键维度在位、状态栏显示 `汉字 N · 单词 M · B 字节`、批处理 `padding: 18 18 18 18` |

### 决策

1. **18px 加外层、内层横向归零**：直接给 header/section/footer 各加 18px 会不一致（它们原本 16px / 12px），也会和外层叠成 34px。
2. **段落数与非空行数分列**：用户点名要这两项并列，说明预期两个数不同；若沿用「段落 = 非空行」就会显示两个一样的数字。
3. **单词不含汉字**：`\p{L}` 会把 `汉字` 判成字母，不排除的话 `汉字，abc` 会被数成 2 个词。
4. **三个命令保留不删**：虽然菜单里没了，`view.toggleSpaces` 等仍在注册表，用户可在「自定义快捷键」里绑回去（删掉会让既有绑定失效）。

### 验证

`cargo test` **237 全过**（含「默认勾选」断言）；`npm run test` **155/155**（统计用例 13 个）；`npm run build` 通过；`eslint src` **0 问题**；`npm run smoke` **25/25**。

关键几条实测输出（都在这个新打的 exe 上跑的）：

```
✓ 视图菜单：3 个统计项在位，不可见字符开关已移走      [4 个勾选项 · 缺失：无 · 残留开关：无]
✓ 不可见字符默认勾选：空格 / 行尾 / 换段符都画出来    [空格 64 个 · 行尾 3 个 · 换段 2 个]
✓ 选项 → 编辑器：三个不可见字符开关在位且默认勾选    [空格=true 行尾=true 换段=true]
✓ 字数统计：多维度（14 行，含汉字 / 标点 / 单词 / 数字组 / 段落 / 字节）
✓ 状态栏：计数改为 汉字 / 单词 / 字节                [汉字 408 · 单词 50 · 1644 字节]
✓ 批处理面板：白底黑字 + 外包框 + 四边 18px 留白     [rgb(255,255,255) / rgb(0,0,0) / padding=18px 18px 18px 18px]
```

「批处理 padding」这条是 `getComputedStyle` 的实测值；「默认勾选」这条则是 CDP 灌入 `a b\nc`
后直接数 `.cm-invisible-space` / `.cm-invisible-line-end` / `.cm-invisible-paragraph`。

---

## v0.5 — 2026-10-18

### 主要变更：修保存 + 补齐编码能力 + 两处菜单扩展 + 批处理重排

**背景**：用户实测报了 6 条——段间空行无效 / 编辑加「自定义替换 ▸」/ 文件加「编码转换 ▸」/ 重新载入加按编码打开 / 保存总失败 / 批处理样式照 TextPro 重排。

#### 1. 保存失败（截图里的 `unknown variant 'utf-8'`）

`SaveOptions.encoding` 走 serde 派生，`Encoding` 靠 `#[serde(rename_all = "lowercase")]` 生成的变体名是 `"utf8"` / `"utf16le"` / `"latin1"`；而前端 `ENCODING_OPTIONS` 用的 `label()` 是 `"utf-8"` / `"utf-16le"` / `"iso-8859-1"`。于是 `fs_write` 在**反序列化参数阶段**就被 tauri 拒掉：`invalid args 'opts' for command 'fs_write': unknown variant 'utf-8'`——和磁盘、权限、路径都无关。

改法：每个变体显式 `#[serde(rename = "…")]`，与 `label()` 严格一致；旧名保留 `alias`（`utf8` / `utf16le` / `latin1`），旧会话与旧请求仍能打开。加了两道锁：Rust 单测 `save_options_deserialize_frontend_json`（用前端真实 JSON 形状）+ 冒烟里真调一次 `fs_write` 断言 `bytesWritten > 0`。

#### 2. 段间空行无效

原实现把「段」定义成**连续非空行**，只在遇到真空行时才切段——`甲\n乙` 被算成 1 段，一个空行都不插。改成**每个非空行 = 一段**：缺的空行补上、多余的连续空行合并成一个，行尾风格（LF/CRLF）沿用原文。`insert_blank_between`、其单测与 `stage5_contract` 的链路断言同步更新。

#### 3. 编辑 → 自定义替换 ▸

直接列出「替换表管理」里的表名（带条数），点一下就对正文跑那张表（与替换表对话框的「应用到正文」同一条路径）；没有表时子面板显示「（暂无）」。

#### 4. 文件 → 编码转换 ▸

内容一个字符不改，按目标编码重写文件——所以 GBK ⇄ BIG5 任意互转（不是先转简体再转繁体那种绕路）。目标编码表示不了的字符走与保存同一套决策（询问 / 数字字符引用 / 改存 UTF-8）。新增 `tabsStore.reencode`，成功后把标签的 `encoding` 更新为**实际写出**的编码。

#### 5. 重新载入 ▸ 按编码打开

原「重新载入…」变成一个二级菜单：第一项「自动探测…」（原来的编码选择对话框），其后 GBK / GB18030 / BIG5 / UTF-8 / UTF-16LE / UTF-16BE / **NFO(437)** 七项按指定编码硬重读。

CP437 不在 WHATWG 编码表里（`encoding_rs` 不提供），故新增 `Encoding::Cp437` + 自带 256 项映射表（`mod cp437`）：解码按表查、编码不可表示时写 `?` 并置 `had_errors`（保存前的不可映射预检照常能拦）。CP437 只认显式指定，不参与自动探测。

#### 6. 批处理改成 TextPro 布局

「需处理文件」表格（勾选 / 文件名 / 路径）+ 右侧六键（文件… / 全选 / 全不选 / 选择 / 不选 / 清空）、「建立后备文件」、「可选择的处理」与「需进行的处理」双栏 + `>>` `<<`、输入/输出编码下拉、底部 退出 / 处理。勾选状态**真的决定请求的 `inputs`**（启动前过滤），不是只有视觉效果；「需进行的处理」每行带 ↑ ↓ ×，用来调顺序 / 删除。

#### 7. 保存默认 UTF-8、.txt

新标签编码固定 `utf-8`；另存为对话框的默认文件名缺扩展名时补 `.txt`，并给出「文本文件 (*.txt)」过滤器。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | §3.5 菜单表：文件行补「重新载入 ▸」「编码转换 ▸」，编辑行补「自定义替换 ▸」 |
| `04-ui-ux.md` | 新增 §2.4a「文件 / 编辑 里的二级菜单」（含 CP437 说明） |
| `02-functional-spec.md` | F-07「段间空一行」语义改为「每个非空行 = 一段」；F-02 补 CP437 与编码转换 / 重新载入口径 |
| `CHANGELOG.md` | 本条目 |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src-tauri/src/core/encoding.rs` | `Encoding` 每个变体显式 `#[serde(rename)]` + 旧名 `alias`（修保存）；新增 `Cp437` 变体与 `mod cp437`（256 项表、懒构建反查表）；`decoder()` 改 `Option`，CP437 走自带解码/编码；新增 `save_options_deserialize_frontend_json`、`cp437_decode_and_encode` 等测试 |
| `src-tauri/src/core/pipelines.rs` | `insert_blank_between` 重写为「每个非空行 = 一段」（补空行 + 合并多余空行），单测与 `stage5_contract` 同步 |
| `src/store/tabsStore.ts` | 新增 `reencode(id, encodingLabel, askUser)`：按目标编码重写文件、更新标签编码；不可映射时走与保存相同的决策 |
| `src/components/MenuBar.tsx` | 新增二级菜单组件 `submenuItem`（`▸`、hover 展开、主项 + 子面板同容器不误收起）；文件菜单加「重新载入 ▸」「编码转换 ▸」，编辑菜单加「自定义替换 ▸」；新增 `tables` / `hasActiveTab` / `hasFilePath` props |
| `src/App.tsx` | 新增 `handleApplyTable` / `handleConvertEncoding` / `handleReloadWith`，并向菜单传替换表与三个 action |
| `src/platform/tauriApi.ts` | `pickSaveFile` 补 `.txt` 与文本过滤器；新增 `ENCODING_CONVERT_TARGETS`（4 项）与 `REOPEN_ENCODINGS`（7 项） |
| `src/components/BatchDialog.tsx` | 按 TextPro 布局重排（文件表 + 六键 / 双栏 + `>>` `<<` / 编码下拉 / 退出·处理）；勾选决定实际 `inputs`；步骤行带 ↑ ↓ × |
| `src/styles/global.css` | 新增 `.menu-sub` / `.menu-sub-panel`（二级菜单浮层）与 `.batch-*` 一整套（文件表、双栏列表、队列行） |
| `scripts/smoke.mjs` | 新增 4 条断言：编码转换 4 项 / 重新载入 8 项（含 437）/ 自定义替换列出表 / `fs_write` 真写成功 |

### 决策

1. **编码标识以后端 `label()` 为唯一真源**：serde 名与 `label()` 对齐，前端不再维护第二套拼写；旧名用 `alias` 兜住，不牺牲兼容。
2. **CP437 自己实现而不是找替代编码**：`encoding_rs` 严格实现 WHATWG 表，里面没有 437；用 windows-1252 糊过去会把方块字符全译错，NFO 文件就没法看了。
3. **「编码转换」= 重写同一个文件，不是另存为**：用户要的是"把这个文件改成 BIG5"，不是"再存一份"；预检与决策流程复用保存那一套，避免两条路径两套行为。
4. **批处理的勾选必须真生效**：后端只认 `inputs`，所以「不选」的项在请求前就被过滤掉，UI 不做假动作。

### 验证

`cargo test` **237 项全过**；`npm run test` **142/142**；`npm run build` 通过；`eslint src` **0 问题**；`npm run smoke` **18/18**（含编码转换 / 重新载入 / 自定义替换 / 真写一次 UTF-8 / 批处理对话框渲染；热启动 551ms，冷启动首跑 1545ms 会被 1500ms 线卡一次，复跑即过）。

---

## v0.4 — 2026-10-17

### 主要变更：顶栏改为纯文字菜单栏

**背景**：顶栏堆着「AioTextEditor」品牌文字 + 七个文件按钮 + 查找/替换 + 功能 ▾ + 整理 ▾ + 比较/合并/批处理 + 设置 ▾ + 帮助，按钮只增不减。按 iml-editor-lite 的形态收口成 `文件 编辑 功能 视图 帮助` 五条纯文字菜单；品牌文字删除（窗口标题栏已经写着它）。「功能」保持一级：常用 6 个转换方向**直接点用**，18 个整理工具按后端目录分 4 组铺在它下面。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | v0.4 → **v0.5**；§3.5 由「七个按钮收进『文件 ▾』」改写为「四条纯文字菜单栏」——目标形态、四个菜单的完整条目表、`T-1`~`T-6`、落地口径（菜单项从命令注册表现取）；§5 风险行与 §6 验收项同步改写 |
| `04-ui-ux.md` | §1 布局总览：去掉图标工具栏与 7 个顶级菜单的旧示意，改为四条文字菜单；§2 新增「顶级菜单归属」映射（搜索 / 功能 / 设置 并入编辑与视图）；§2.3「工具栏」开关 →「菜单栏」；§3.5 设置页勾选项与兜底说明同步 |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src/components/MenuBar.tsx` | **新增**：文件 / 编辑 / 功能 / 视图 / 帮助五条菜单；命令项的标签、键位提示、禁用态全部从 `COMMANDS` + 命令分发器 + 当前绑定现取；**「功能」菜单**：6 个常用转换方向直接点（**其余 11 种彻底不提供**，连「其他转换」分组一起删）+ 转换预览… + 18 个工具按后端目录分 4 组（组间分隔线，限高滚动）；**「视图」菜单**在「行号 ☑」下新增「自动换行 ☑」（`view.toggleWrap`）；「替换表管理…」按用户要求放「编辑」；已展开时鼠标划过别的入口自动切换；点外部 / `Esc` 收起 |
| `src/App.tsx` | 载入方向列表时**只留 `common` 的 6 种**（`.then((list) => setDirections(list.filter((d) => d.common)))`）——过滤放在数据源头，菜单与「转换预览…」对话框因此都只剩 6 种，不留第二个入口；新增 `view.toggleWrap` 命令处理（切 `editor.wrap`）；MenuBar 增传 `wrap` |
| `src/shared/shortcuts.ts` | 命令表新增 `view.toggleWrap`（「显示 / 隐藏自动换行」，默认不绑键，可在自定义快捷键里绑） |
| `scripts/smoke.mjs` | 新增 3 条断言：展开「功能」菜单 → 转换方向 **6 个**且直接可点、整理工具分 **4 组**、菜单内 `.menu-sub` 为 **0**（盯住「不再套二级菜单」不回退） |
| `src/App.tsx` | 删除品牌文字、全部平铺按钮、`设置 ▾` 与「帮助」下拉（连同 `settingsMenuOpen` 状态与外部点击 effect），顶栏只渲染 `<MenuBar>` |
| `src/components/ConvertMenu.tsx`、`src/components/ToolMenu.tsx` | **删除**：内容并入 `MenuBar`，不留两套菜单实现 |
| `src/styles/global.css` | 新增 `.menubar` / `.menubar-trigger`（无边框、悬停浅底）、`.menu-item-row`（两端对齐）、`.menu-item-check`（勾选列）、`.menu-sub-panel-tall`（二级菜单限高滚动）、`.menu-item:disabled`；`.app-header` 内边距收紧、删除 `.app-title` |
| `src-tauri/src/core/opencc.rs` | **引擎侧删除 8 种低频方向**：`Direction` 枚举只留 `S2T` / `T2S` / `S2TWP` / `TW2SP` / `S2HK` / `HK2S` / `Custom`；删掉 `config_name` / `id` / `label` / `embedded_config` 的对应分支、`is_common()`（不再有「常用 / 其他」之分）、`all_standard()` 由 14 个降为 6 个；`family()` 的两族各由 4 个降为 3 个（歧义诊断语义不变）；`all_data()` 不再写出这 8 个配置 JSON（词典仍全量写出） |
| `src-tauri/src/commands/convert.rs` | `DirectionMeta` 去掉 `common` 字段——6 种就是全部，不需要再区分 |
| `src-tauri/tests/convert_contract.rs` | 前端常量由 14 个降为 6 个；新增 `REMOVED_DIRECTION_IDS`，断言这 8 个 id **反序列化失败**（盯住引擎侧不回退） |
| `src/platform/tauriApi.ts` | `OpenccDirectionMeta` 去掉 `common`（注释写明只有 6 种） |
| `src/shared/shortcuts.ts` | `view.toggleToolbar` 标签改为「显示 / 隐藏菜单栏」 |
| `src/components/SettingsDialog.tsx` | 「显示工具栏」→「显示菜单栏」 |

### 关键技术决策

1. **菜单不另写一套行为**：命令项的标签、键位提示、禁用条件全部取自命令分发表与当前绑定，和快捷键同一份数据——不会出现「菜单写着 `Ctrl+Shift+A` 但按键不生效」的漂移，用户改键位后菜单立刻跟着变。
2. **其余低频方向从引擎侧彻底删除**（不是"UI 不显示"）：`Direction` 枚举删掉 8 个变体（`s2tw` / `tw2s` / `t2tw` / `tw2t` / `t2hk` / `hk2t` / `t2jp` / `jp2t`），它们的 id 反序列化会失败，前端即便手搓一个 `invoke('convert_opencc', { direction: 't2jp' })` 也会被拒。前端侧的 `.common` 字段与过滤逻辑因此一并删除——6 种就是全部，没有"常用 / 其他"之分了。`family()` 由 4 元降为 3 元，歧义诊断（同族方向差分）照样工作。需要这些方向的用户走 `Custom` 配置。
3. **18 个整理工具按后端 catalog 的顺序分 4 组铺开**（行处理 / 空格与全半角 / 标点与括号 / 排版与分段），组间分隔线、组内顺序由后端决定，前端不重排。
4. **「自动换行」进视图菜单**：它是「看的方式」，和行号 / 状态栏同类，不该埋在「选项 → 编辑器」里；勾选态与选项对话框里那个复选框是同一个 `editor.wrap`，两侧永远一致。
5. **顶级菜单定为五条**：搜索并入「编辑」（含比较 / 合并 / 批处理）、设置并入「视图」，转换与整理合到「功能」。
6. **品牌文字删除**：窗口标题栏已有 `AioTextEditor`，顶栏重复一遍只是噪音。
7. **「显示菜单栏」留兜底**：关掉顶栏后 `Ctrl + ,` 仍能打开选项恢复；这条写进 `04-ui-ux §3.5`，防止以后改成不可恢复。

### 验证

`cargo test` **234 项全过**（含新增的「已删除方向反序列化失败」断言）；`npm run build`（`tsc -b` + vite）通过；`npm run test` **140/140**；`npm run lint` 对 `src/` **0 问题**（残留的 16 个 `no-undef` 仍全部出自 `d:\site\aiotext-editor\aiotext-editor\` 这份未清理的旧克隆）。

---

## v0.3 — 2026-10-17

### 主要变更：标签关闭与未保存处理

**背景**：用户反馈「打开文件只有保存、取消，没有『关闭文件不保存』，也没有『全部关闭标签页』」。勘察后确认缺口比反馈更大——store 里没有任何批量关闭动作、标签栏没有右键菜单（规格写了但从未落地）、「全部保存 / 全部关闭」的键位早在 `04-ui-ux` 菜单表承诺过却没实现。故先在 PRD 立项（新增 §3.4），再落地。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | 版本升到 v0.3；§1.6 设计哲学由三条规矩改为四条（新增第 3 条「丢也是用户在决定」，并把第 1 条的自动恢复限定为**意外丢失**）；§2 功能全景表新增 4 行；§3.1 MVP 新增第 16 条；**新增 §3.4**（需求与验收标准 C-1~C-9、入口键位表、会话语义决议）；§5 风险表新增 3 行；§6 验收标准新增 4 条 |
| `02-functional-spec.md` | F-01 §1.2 的「关闭确认」由一句话扩展为三选语义 + 批量行为 + 退出拦截顺延说明；文件操作条目补齐「关闭其他 / 全部关闭 / 全部保存」 |
| `04-ui-ux.md` | §4.1 标签：右键菜单由「关闭/保存/另存为」扩到「关闭 / 关闭其他标签 / 全部关闭 / 保存 / 另存为…」——该菜单此前只存在于规格 |
| `05-roadmap.md` | 第九阶段注记 ④「会话边界行为待定」由 PRD §3.4 决议收口（全部关闭 → 空会话 → 下次启动回到单个空白标签，维持现状） |

### 代码实现

| 文件 | 变更 |
|------|------|
| `src/store/tabsStore.ts` | 新增 `closeTabs(ids)` / `closeOthers(id)` / `closeAll()`；把 `activeTabId` 收敛规则抽成 `nextActiveAfterClose`（当前标签被关则落右侧最近幸存者，右侧没有则最后一个；不在关闭名单里则原地不动），`closeTab` 改为共用同一实现 |
| `src/store/tabsStore.test.ts` | 新增 7 项批量关闭单测（总数 10 → 17） |
| `src/components/ConfirmCloseDialog.tsx` | **新增**：三选对话框；单文件按文件名措辞、多文件一次汇总；`Esc` = 取消、默认焦点在「取消」 |
| `src/components/TabBar.tsx` | 新增右键菜单（关闭 / 关闭其他标签 / 全部关闭 / 保存 / 另存为…）与双击关闭 |
| `src/shared/shortcuts.ts` | 命令表新增 `file.saveAll`（`Ctrl+Shift+A`）、`file.closeAll`（`Ctrl+Shift+W`）、`file.closeOthers` |
| `src/App.tsx` | 删除硬编码的 `window.confirm`，改为 `askClose` + `requestClose` 决策层；工具栏新增「全部保存」「全部关闭」 |
| `src/styles/global.css` | 新增 `.dialog-danger`（橙色的「不保存」）、`.dialog-list`、`.tabbar-menu` |

### 关键技术决策

1. **「不保存」= 真正丢弃**：选 `discard` 时标签从 store 摘除，而会话 `session.json` 是由当前标签派生落盘的，标签不在 → 会话里也不再有它 → 下次启动不会复活。否则「明明点了不保存，内容又回来了」会让这个按钮形同虚设（PRD §1.6 第 3 条）。
2. **批量关闭只问一次**：N 个脏标签连弹 N 次，用户会机械地一路点掉，反而比一次问清更容易误丢内容。
3. **保存失败就不关闭**：只有保存成功的标签才进关闭名单，失败或取消保存的留在原地，并用 Toast 列出是哪几个。
4. **C-8（退出应用拦截）顺延 v1.1**：它是唯一要动 Rust（`WindowEvent::CloseRequested` + `prevent_close`）的部分，且 macOS `Cmd + Q`、Linux 窗口管理器两条路径在 Windows 上无法验证，留到能用真机 / CI 验证时再做；过渡期仍靠会话兜底。

### 验证

前端单测 **140/140**（新增 7 项）；`npm run lint` 对本次改动的文件 **0 error 0 warning**（仓库里残留的 16 个 `no-undef` 全部来自 `d:\site\aiotext-editor\aiotext-editor\` 这份未清理的旧克隆副本，与本次变更无关）；`npm run build`（含 `tsc -b`）通过。

---

## v0.2 — 2026-10-14

### 主要变更：引入 OpenCC 作为简繁转换引擎

**背景**：用户要求繁简转换部分参考 OpenCC（[BYVoid/OpenCC](https://github.com/BYVoid/OpenCC)），同时保留自定义替换功能。

### 改动的文档

| 文档 | 变更 |
|------|------|
| `PRD.md` | §1.5 新增"繁简转换引擎：OpenCC"段落；与 OpenCC CLI 对比；新增 17 种转换说明 |
| `PRD.md` | §2 功能优先级表加入 OpenCC 台湾 / 香港双向转换 |
| `PRD.md` | §3.1 MVP 范围：第 3、4、16 条扩充到 OpenCC 实现 |
| `02-functional-spec.md` | **F-03 简繁互转**整段重写：基于 OpenCC 1.4.x，支持 17 种标准转换方向；保留 TextPro 不转换括号对行为；保留 `fc1/fc2.dat` 作为可选佛经/古文补充表 |
| `02-functional-spec.md` | **F-04 自定义替换表**整段重写：保留 TextPro 风格的 `A/B=目标` UI，但后端把表编译为 OpenCC **inline dictionary** 接入转换链；三种使用模式（独立 / 叠加 OpenCC / 批处理） |
| `02-functional-spec.md` | F-04 新增"内置示例表"（首次启动复制到用户目录） |
| `03-tech-architecture.md` | 技术栈表格新增"OpenCC 1.4.1"行（静态构建、嵌入词典） |
| `03-tech-architecture.md` | `src-tauri/core/` 目录新增 `opencc.rs` 模块 |
| `03-tech-architecture.md` | Cargo 依赖新增 `opencc-sys = "0.5"` |
| `03-tech-architecture.md` | §十 词库与数据迁移重写为 §10.1~§10.4，明确 OpenCC 为"主力词库嵌入二进制"，TextPro 旧词表为"兼容保留" |
| `03-tech-architecture.md` | 里程碑在每个版本上都标注 OpenCC 相关能力 |
| `05-roadmap.md` | 第三阶段改名"OpenCC 集成 + 简繁互转"，任务清单重新拆分 |
| `05-roadmap.md` | 第四阶段增加"编译为 OpenCC 内联字典"、"OpenCC 转换链集成"两条任务 |
| `05-roadmap.md` | 仓库结构 `src-tauri/data/` 拆分为 `legacy/`（TextPro 旧词表）和 `builtin-tables/`（内置示例表） |
| `05-roadmap.md` | 风险点表加入 4 条 OpenCC 相关风险与缓解措施 |
| `05-roadmap.md` | 确认事项清单加入 "OpenCC 集成" 在第 1 周就验证 cmake 跨平台构建 |

### 关键技术决策

1. **OpenCC 集成方式**：使用 `opencc-sys` crate（TerakomariGandesblood 版，docs.rs 0.5.2+1.4.1）**静态链接 OpenCC C++**。JSON 词典**编译期嵌入 Rust 二进制**，无需在安装包携带 .ocd2 文件。
2. **API 差异处理**：OpenCC C API 的 `opencc_open` 仅接受磁盘路径。我们在 `core/opencc.rs` 中按需把生成的 JSON 配置写到 `%TEMP%/aotext-cc-XXXX.json`，OpenccHandle 持有文件句柄直到 `Drop` 时清理。
3. **自定义替换表的实现选择**：保留 TextPro 6 风格的 `A/B=目标` 文件格式与 UI 体验，但**后端把这些条目编译为 OpenCC 内联字典**（`{"type":"inline","entries":{...}}`）作为转换链的最末位，确保"用户表优先级最高"。
4. **TextPro 旧词表的处理**：`fc1/fc2/s2t/t2s.dat` 不抛弃，作为"古文/佛经补充表"存放在 `src-tauri/data/legacy/`，用户在设置里显式启用。优先级：OpenCC > 用户自定义表 > TextPro 兼容表。
5. **不转换括号对**：保留为 OpenCC 转换链的"前处理"步骤（按用户设置的 `[]` 等字符对在转换前屏蔽相应区域）。
6. **歧义片段诊断**：参考 OpenCC CLI 的 `--ambiguities` 模式，UI 弹窗标记"一对多"区段供人工校对。

### 变更前后对照

| 能力 | v0.1 | v0.2 |
|------|------|------|
| 简繁转换引擎 | 自写 + TextPro `fc1/fc2.dat` | **OpenCC 1.4.1（嵌入二进制）** + 可选 `fc1/fc2.dat` |
| 转换方向 | 2 种（s2t、t2s） | **17 种标准方向 + 自定义** |
| 台湾 / 香港地方化繁体 | ❌ | ✅ |
| 自定义替换 UI 格式 | TextPro 风格 | **TextPro 风格**（保留） |
| 自定义替换后端 | Rust `Aho-Corasick` | **Rust `Aho-Corasick`（独立）/ OpenCC inline dictionary（叠加）二选一** |
| 异体字支持 | TextPro `u2b1.dat` | **OpenCC `HKVariants/JPVariants/TWVariants` + TextPro `u2b1.dat`（兜底）** |
| 歧义片段诊断 | ❌ | **OpenCC `--ambiguities` 风格** |
| 词典维护方 | TextPro 维护者 | **OpenCC 社区（持续更新）** |
| 安装包大小 | < 12 MB | **略增**（OpenCC C++ 静态链接约 +1 MB；词库已经嵌入无需额外） |

### 待确认事项（已于 v0.3 全部确认，见下方）

---

## v0.3 — 2026-10-14（用户确认 5 项决策）

### 确认结果

| # | 问题 | 确认结果 |
|---|------|---------|
| 1 | OpenCC 词库版本 | **锁定到 opencc-sys 当前 OpenCC 1.4.2**（2026-08-22 发布）；使用 TerakomariGandesblood 版本 |
| 2 | TextPro 旧词表处理 | **选项 A**：保留作为可选"古文/佛经补充表" |
| 3 | 台湾/香港地方化转换 UI 入口 | **选项 A**：常用 6 种入主菜单"功能"，其余 11 种入二级菜单 |
| 4 | 歧义片段诊断 | **选项 A**：转换后自动弹窗列出前 100 处歧义 |
| 5 | 自定义替换表导入导出 | **导入 TextPro `.tab`（v1.0 兼容）+ 导出 OpenCC `.json` / `.ocd2`（v1.1）** |

### 文档同步修改

| 文档 | 变更 |
|------|------|
| `PRD.md` | §1.5、§3.1 中 OpenCC 版本 1.4.1 → **1.4.2** |
| `02-functional-spec.md` | F-03 引擎版本 1.4.1 → **1.4.2**；F-04 §4.9 明确导入（v1.0，含 TextPro V6 前空格分隔 / V6 后 `=` 分隔的自动识别）与导出（v1.1，OpenCC JSON / .ocd2）；F-04 §4.6 新增 3 个 Tauri 命令：`import_textpro_tab`、`export_opencc_json`、`export_opencc_ocd2` |
| `03-tech-architecture.md` | 技术栈、§10.1、Cargo 依赖注释中 1.4.1 → **1.4.2**；依赖注释明确"锁定到包含 OpenCC 1.4.2 的 opencc-sys 版本（不自动跟 latest）" |
| `05-roadmap.md` | 第三阶段目标 1.4.1 → **1.4.2** |
| `04-ui-ux.md` | §2.5 功能菜单重写：常用 6 种 OpenCC 转换入主菜单（含各自配置名）+ "其他转换"二级菜单（11 种）；新增"简繁转换子对话框"与"歧义片段弹窗"原型图；§8.1 流程改为 OpenCC 转换链；§8.2 BIG5 保存流程加入 OpenCC `HKVariantsRev/JPVariantsRev/TWVariantsRev` 第一级回退 |
| `README.md` | 顶部标注当前基线 v0.3 |

### 状态

- 文档基线已冻结为 **v0.3**。
- 用户选择"先继续打磨文档，暂不编码"；待用户复核 v0.3 文档后再进入开发阶段。

---

## v0.4 — 2026-10-14（数据字典：TextPro 数据文件逆向 + 开放格式转换）

### 背景

用户要求：**提取 `fc1/fc2/u2b1/u2b2.dat` 内容，改用任何通用编辑器都能打开的开放格式，不再使用专属格式。**

### 逆向结果（4 个文件全部破解）

| 源文件 | 格式 | 产物 | 条目数 |
|--------|------|------|--------|
| `fc1.dat`（8580 B） | 每字节 XOR 0x20 + UTF-16LE + CRLF | `data-extracted/fc1.txt` | 1003 组 |
| `fc2.dat`（127198 B） | 同上 | `data-extracted/fc2.txt` | 10579 组 |
| `u2b1.dat`（63678 B） | TEXTPRO 容器：`u32 键长 \| u32 键码 \| u32 值长 \| 值 \| u16 填充` | `data-extracted/u2b1.tsv` | 2122 条 |
| `u2b2.dat`（49598 B） | 同上（值为组字式字符串） | `data-extracted/u2b2.tsv` | 995 条 |

产物均为 **UTF-8 with BOM 纯文本**；提取条目数与源文件头部 count 完全一致；SHA-256 校验和见数据字典 §1.3。

### 重要语义澄清（修正 v0.2/v0.3 的错误假设）

经内容验证（典型简繁对"万萬/后後/云雲/里裡"等 10 组 0 命中）：

- **`fc1/fc2` 是文件比较（F-06）的异体字组表**（完全等同 / 部分等同），**不是简繁转换词组表**。
- v0.2/v0.3 中"fc1/fc2 作为佛经/古文简繁补充表叠加在 OpenCC 之后"的设计**有误，已撤销**。
- **`s2t/t2s.dat`** 才是简↔繁单字表（未提取；其内容与 OpenCC 词库同质，按 v0.3 决策由 OpenCC 取代，不打包）。

### 文档同步修改

| 文档 | 变更 |
|------|------|
| `06-data-dictionary.md`（新增） | 数据字典：源格式逆向规格、开放格式规范、验证记录、遗留事项 |
| `PRD.md` | §1.5"不抛弃 TextPro 特性"改为异体字组表 + BIG5 回退表；新增"已废弃的 TextPro 数据"；§3.1 MVP 第 3 条删除 fc1/fc2 补充表；§4 亮点第 3 条修正 |
| `02-functional-spec.md` | F-02 §2.5 数据文件表改为 4 个开放文本文件；F-03 转换链删除"TextPro 兼容补充"步骤；`ConvertRequest` 删除 `apply_legacy_supp`、`ConvertReport` 删除 `legacy_unmatched`；§3.5 重写为"已废弃"；F-06 §6.5 异体字查表改为 fc1.txt/fc2.txt；§九 附录重写 |
| `03-tech-architecture.md` | §10.2 重写为"开放文本格式兼容包"（4 文件 + 不打包清单）；§10.3 解析器改为纯文本加载器；目录树 `data_tables.rs` 注释更新 |
| `04-ui-ux.md` | §2.5 简繁转换子对话框删除"使用 TextPro 古文/佛经补充表（fc1/fc2）"复选框 |
| `05-roadmap.md` | 仓库结构 `data/legacy/` 改为 4 个开放文本文件；第三阶段删除"佛经/古文补充表通道"与相关测试任务；风险表"TextPro 旧词表格式错误"标记为已消除 |

### 新增产物

```
data-extracted/
├── fc1.txt    # 1003 组，8,780 B
├── fc2.txt    # 10579 组，126,979 B
├── u2b1.tsv   # 2122 条，19,101 B
└── u2b2.tsv   # 995 条，16,663 B
scripts/extract-textpro-data.ps1   # 可重复运行的提取工具（输出校验和与本条目一致）
```

### 简繁转换链（修正后）

```
括号对豁免 → OpenCC（标准词库） → 用户自定义表（OpenCC 内联字典） → 歧义片段诊断
```

BIG5 保存回退链：OpenCC 异体字词典 → `u2b1.tsv` → `u2b2.tsv`（组字式） → 询问改存 UTF-8。

### 状态

- 文档基线更新为 **v0.4**。
- 产品不再依赖任何 TextPro 专属二进制格式；`core::data_tables` 从二进制解析器简化为纯文本加载器。

---

## v0.5 — 2026-10-14（弃用 u2b1/u2b2 BIG5 回退表，改用 encoding_rs 编码互转）

### 背景

用户决策：**弃用 TextPro 旧词表兼容包中的 `u2b1.dat`（Unicode → BIG5 异体字回退）与 `u2b2.dat`（组字式回退），替换为 GitHub 上现成的编码转换代码**，要求支持 UTF-8、UTF-16、GBK、GB2312、GB18030、Big5、ISO-8859-1 等多种编码格式的相互转换。

### 技术选型

选定 [`encoding_rs`](https://github.com/encoding-rs/encoding_rs)（Mozilla 出品，WHATWG Encoding Standard 的 Rust 参考实现，技术栈 §2 原有依赖，零新增依赖）：

- 原生支持 **UTF-8、UTF-16 LE/BE、GBK、GB2312（按 WHATWG 以 GBK 解析）、GB18030、Big5、ISO-8859-1（映射 windows-1252）**，另含 Shift_JIS、EUC-JP、EUC-KR、KOI8-R 等全部 WHATWG 编码。
- 不可编码字符按标准以**数字字符引用 `&#xNNNN;`** 写出（不丢字），产品在交互式保存前增加预检（`fs_check_mappable`）与弹窗（改存 UTF-8 / 以引用继续 / 取消）。
- 编码探测继续用 `chardet`。

### 文档同步修改

| 文档 | 变更 |
|------|------|
| `PRD.md` | §1.5 u2b1/u2b2 移入"已废弃"并注明取代方案；功能表改"多编码读写与互转"与"非 Unicode 编码保存兜底"；MVP 第 2 条编码清单扩充；风险表"异体字/组字式表覆盖不全"替换为 encoding_rs 方案 |
| `02-functional-spec.md` | F-02 用户故事/行为/契约全面重写：`Encoding` 枚举加 `Gb2312`/`Gb18030`，新增 `UnmappablePolicy`（Ask/CharRef/ToUtf8）与 `fs_check_mappable` 命令，`SaveReport.char_refs_written` 取代回退字段；§2.5 数据文件仅剩 fc1/fc2；§3.6 重写；设置项 `big5UseVariants`/`big5UseIdeographDesc` 移除；§九 附录改为"沿用两项" |
| `03-tech-architecture.md` | 技术栈 `encoding_rs` 说明扩充；`data_tables.rs` 注释只含 fc1/fc2；§10.2 表删除 u2b1/u2b2 行，"不打包"清单加入并说明 encoding_rs 取代方案 |
| `04-ui-ux.md` | §8.2 流程重写为"保存为非 Unicode 编码"：预检 → 弹窗（改存 UTF-8 / `&#xNNNN;` 引用 / 取消）→ encoding_rs 写出 |
| `05-roadmap.md` | 仓库结构 `data/legacy/` 仅剩 fc1.txt/fc2.txt；第二阶段目标编码清单扩充；第三阶段任务 9 改为 encoding_rs 路径 |
| `06-data-dictionary.md` | §1.2/§3.3/§3.4/§3.5/§五/§六/§七 标注 u2b1/u2b2"已弃用，仅存档"；`CharMap`/`load_char_map` 从加载器接口移除；遗留事项 #2 关闭 |

### 弃用清单（不打包、不加载）

- `u2b1.dat` → `u2b1.tsv`（2122 条异体字回退）——提取档案保留在 `data-extracted/`。
- `u2b2.dat` → `u2b2.tsv`（995 条组字式回退）——同上。
- （此前 v0.3 已弃用：`s2t.dat` / `t2s.dat`。）

随产品打包的 TextPro 数据仅剩 **`fc1.txt` / `fc2.txt`**（F-06 文件比较的异体字组表）。

### 状态

- 文档基线更新为 **v0.5**。
- 产品内 BIG5 保存行为从"OpenCC 异体字 → u2b1 → u2b2 → 询问"三级回退，简化为"预检 → 弹窗 → `encoding_rs` 数字字符引用"单一标准路径。

---

## v0.6 — 2026-10-15（删除「更新检查 / 自动更新」，应用完全离线）

### 背景

用户决策：**删除「自动检查最新版本」功能，应用不自动更新版本**。

### 变更

自此 AioTextEditor **不发起任何网络请求**——启动时不查询 GitHub Releases，不检查新版本，不下载或安装更新，也没有「帮助 → 检查更新」入口与设置里的「自动检查」开关。升级由用户自行获取新版本安装包完成。

### 文档同步修改

| 文档 | 变更 |
|------|------|
| `PRD.md` | §1.6 设计哲学第 3 条改为「没有任何网络请求」（原文为「唯一的网络行为是检查更新」）；功能全景表删除「检查更新」行；§3.1 MVP 清单删除「检查更新（GitHub Releases）」（原第 15 条）并重编号 |
| `02-functional-spec.md` | 目录删除 F-12 条目；**整节删除 F-12 更新检查**（含 §12.1 行为、§12.2 安全），功能编号止于 F-11 |
| `03-tech-architecture.md` | §3.1 目录结构删除 `commands/update.rs`；§十三 依赖清单删除 `tauri-plugin-updater` |
| `04-ui-ux.md` | §2.7 帮助菜单删除「检查更新…」 |
| `05-roadmap.md` | §十一 第十阶段任务删除「`tauri-plugin-updater` 接入」并重编号；§12.1 npm 与 §12.2 Cargo 依赖清单删除 `@tauri-apps/plugin-updater` / `tauri-plugin-updater` |
| 依赖清单（两处） | 一并移除 `tauri-plugin-global-shortcut`——第八阶段已改用应用内命令分发器，该插件最终未采用 |

### 状态

- 文档基线更新为 **v0.6**。
- 该功能从未进入编码阶段（第八阶段 F-11 已完成的设置项中本就没有「自动检查更新」开关），故仅涉及文档，无代码改动。

---

## 开发日志 001 — 2026-10-14（第一阶段：脚手架 + 关键风险验证，全部完成）

### 已交付

| 项 | 结果 |
|----|------|
| 工具链 | Node 24.20.0 / Rust stable 1.99.0（msvc）/ VS 2022 Build Tools（MSVC 14.44 + Win SDK 26100）/ CMake 4.4.4 / LLVM 23.1.3 / VC++ 运行库 14.51 |
| 脚手架 | Tauri 2 + React 19 + Vite 7.3 + TS 5.9 + Zustand 5 + CodeMirror 6（依赖就位） |
| 工程文件 | 根 Cargo workspace、`src-tauri/Cargo.toml`（按阶段渐进引依赖）、`tauri.conf.json`（含 bundle.resources）、capabilities、icons（程序生成占位）、`.github/workflows/ci.yml`（三平台矩阵：lint+test+build / fmt+check+test）、README、`data/legacy/`（fc1/fc2）+ `data/builtin-tables/`（3 个示例 .tab） |
| 第一个全链路命令 | `fs_read`（Tauri 命令）→ `core::encoding`（encoding_rs：BOM→UTF-8 严格→GB18030 兜底 + 行尾统计）→ 前端 `platform/tauriApi.ts` |
| 验证 | Rust 单测 8/8 ✓；前端 vitest 5/5 ✓（含增补平面代理对回归）；ESLint ✓；`tsc -b && vite build` ✓；`cargo fmt --check` ✓；`tauri dev` 启动空白窗口 ✓（MainWindowTitle=AioTextEditor） |

### opencc-sys 前置验证（路线图最大技术风险，已消除）

- **静态链接成功**：opencc-sys 0.5.2（内嵌 OpenCC 1.4.2）在 Windows MSVC 完整构建（cmake 编译 libopencc + bindgen 生成 FFI + 静态链接）。
- **功能验证通过**（探针实测 3 项）：
  1. s2t：「汉字简繁转换测试：头发，发展。皇后在后面。」→「漢字簡繁轉換測試：頭髮，發展。皇后在後面。」（歧义字全对）
  2. t2s：反向转换 ✓
  3. **F-04 inline 用户词典叠加**：自定义配置 JSON 中 `{"type":"inline","entries":{"软件":"軟體"}}` 放 short_circuit 组首位，「软件的发展」→「軟體的發展」✓
- **数据机制确认**：`opencc_sys::S2T_JSON` / `ST_CHARACTERS_OCD2` 等内嵌常量 → 写临时目录 → `opencc_open()`，与官方 opencc-rs 同机制。
- **opencc-rs 高层 crate 评估**：0.5.2 尚依赖 opencc-sys 0.4.3（OpenCC 1.3.1）且 Config 枚举封闭（无法自定义配置），维持原架构决策——自研 `core/opencc.rs` 封装 opencc-sys 0.5.2。

### 过程中发现并解决的三个环境问题（已写入文档）

1. **`opencc-sys` 构建还需 LLVM/libclang**（bindgen）——此前文档只写了 cmake+MSVC，已补（03-tech §10.1、README、CI 注释）。
2. **旧版 VC++ 运行库导致 OpenCC 必崩**：本机 `msvcp140.dll` 停在 14.29（与编译器 14.44 不匹配）→ 词典加载阶段访问违例（0xC0000005），连官方 CI 组合也崩；更新到 14.51 后全部通过。运行库要求已写入文档；打包阶段（第十阶段）需随安装器分发最新运行库。
3. **Vite 不得监视 Rust target 目录**：cargo 链接时锁定 DLL，chokidar watch 加锁文件会 EBUSY 崩溃（Windows 特有），已在 `vite.config.ts` 配置 `server.watch.ignored`。

### 下一步

进入第二阶段：核心 I/O（F-01/F-02 完整版）——CodeMirror 编辑器、多标签、chardetng 编码探测、保存路径 + `fs_check_mappable`、行尾/BOM 保持。

---

## 开发日志 002 — 2026-10-15（第二阶段：核心 I/O 与编码，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/encoding.rs` | 编码探测完整版：BOM → UTF-8 严格 → **chardetng 统计探测**（GBK/Big5/UTF-16/1252 映射，未支持编码回落 GB18030，符合 F-02 §2.2 顺序）；`encode`/`check_mappable`（定位不可编码字符）/`apply_char_refs`（`&#xNNNN;` 替换+计数）/`write_file`（BOM 前缀、行尾展开、三策略 Ask/CharRef/ToUtf8）；读入归一 LF、写出按选项还原 |
| `error.rs` | 新增 `AppError::Unmappable { encoding, count }`（Ask 策略下有不可编码字符时结构化报错） |
| `commands/fs.rs` | 四件套：`fs_read`（自动探测）、`fs_read_with`（手选编码重载）、`fs_check_mappable`（保存前预检）、`fs_write`（`SaveReport` 返回） |
| 前端 `platform/tauriApi.ts` | 全部命令封装 + `pickSaveFile` + `ENCODING_OPTIONS` + `isUnicodeEncoding` |
| 前端 `store/tabsStore.ts` | Zustand 多标签：新建/打开（同路径复用）/激活/关闭/编辑标 dirty/光标/按编码重载/保存（预检→弹窗→三策略）/另存为 |
| 前端组件 | `Editor`（CodeMirror 6：行号、历史、折行；光标列号按字符数计）、`TabBar`（未保存圆点、中键关闭）、`StatusBar`（编码/行尾/BOM/行列/字符统计）、`ReloadDialog`（编码下拉）、`UnmappableDialog`（列出不可编码字符 + 码点 + 三选） |
| `App.tsx` | 工具栏（新建/打开/保存/另存为/重新载入）+ Ctrl+O / Ctrl+S / Ctrl+Shift+S + 关闭未保存确认 |

### 验证

- Rust：`cargo fmt --check` ✓、`cargo check` 零警告 ✓、单测 **23/23** ✓（新增：chardetng GBK/Big5 探测、编码回环、BOM 前缀、check_mappable 定位、三策略写盘、UTF-16 手工编码）
- 前端：vitest **15/15** ✓（新增 tabsStore 10 用例：mock invoke 覆盖保存三策略与取消）、ESLint ✓（接入 `eslint-plugin-react-hooks`，并修 target/ 误扫）、`tsc -b && vite build` ✓
- 集成：`tauri dev` 窗口正常拉起，新建/打开/编辑/保存/重载链路可用

### 过程中发现并解决的两个问题

1. **`encoding_rs` 的 UTF-16 encoder 不可用**：`UTF_16LE.encode()` 实测返回原 UTF-8 字节而非 UTF-16 字节（回环成韩文乱码）。已在 `core/encoding.rs` 对 UTF-16 LE/BE 手工转换（`encode_utf16` + 字节序），并加回环测试锁定。
2. **eslint 误扫 Rust 构建产物**：Tauri 生成的 `target/debug/build/*/out/*.js` 触发 lint 报错；`ignores` 补 `target/**`（workspace 根 target）。

### 待后续阶段

- 会话恢复（session.json，F-01 §1.3）、拖放打开、超大文件仅查看模式
- GBK 0x80 孤立字节的「可疑区域标注」（F-02 §2.6 边界）
- 中文正则、自定义表、简繁互转（第三阶段起）

---

## 开发日志 003 — 2026-10-15（第三阶段：简繁互转，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/opencc.rs` | OpenCC 1.4.2 封装：内嵌数据（16 配置 JSON + 22 词典）懒展开到 `%TEMP%/aiotext-opencc-<pid>/`、退出清理；`Direction` 14 种标准方向 + `Custom`；RAII `OpenccHandle`（含 `(opencc_t)-1` 陷阱处理）+ 转换器池（按配置路径缓存，避免反复加载词典）；`convert_with_inline_dicts`（用户词典叠加，写入 short_circuit **首位**保证最高优先级） |
| `core/convert.rs` | 转换链：括号对豁免分段（栈式嵌套、未闭合保护到末尾、引号对支持）→ 引擎转换 → 变更计数（码点口径）→ 歧义诊断；`parse_table`（F-04 `A=B` / `A/B=C` / 注释 / 元数据）；`preview` 输出前 200 个差异行（含行内差异区间） |
| `commands/convert.rs` | `list_opencc_directions` / `convert_opencc` / `preview_convert`（重活走 `spawn_blocking`） |
| 前端 | `ConvertMenu`（功能菜单：6 常用 + 「其他转换」二级 + 「转换预览…」）、`ConvertDialog`（方向下拉 / 8 组括号对豁免 / 诊断开关 / 预览 Diff / 应用）、转换结果提示条、`tauriApi` 契约类型 |
| 选区支持 | 编辑器上报选区 → 有选区只转换选区（提示「（选区）」），否则整篇（F-03 §3.7） |
| CI | rust job 增加 LLVM（`kylemayes/install-llvm-action`）+ `LIBCLANG_PATH`（Windows=bin，Linux/macOS=lib）+ Linux cmake；新增 `cargo clippy --all-targets -- -D warnings` |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy -D warnings` ✓（0 警告）、单测 **45/45** ✓、前后端契约集成测试 **5/5** ✓
- **前端**：vitest **21/21** ✓、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright 驱动运行中的应用，非 mock）：
  - `list_opencc_directions` → 14 个方向 / 6 个常用 ✓
  - 输入「头发发展，鼠标和软件」→ 菜单「简体 → 繁体」→ **「頭髮發展，鼠標和軟件」**，提示「已转换 5 个字符（整篇）」、状态栏转 ● 未保存 ✓
  - 对话框切 `s2twp` + 勾选 `[ ]` 豁免 → 预览「差异 1 / 1 行 · 变更 3 字符」→ 应用 → **「頭髮發展，滑鼠和軟體」** ✓
  - `Ctrl+A` 全选 → 「繁体 → 简体」→ **「头发发展，滑鼠和软体」**，提示「已转换 5 个字符（**选区**）」✓
  - invoke 直调歧义诊断：`屏幕上的鼠標和軟件` ← s2twp `螢幕上的滑鼠和軟體`（start 5 / end 14）✓

### 关键决策与发现

1. **seal 三种方向不可用**：规格 F-03 §3.2 列出 17 种配置，但 `opencc-sys` 0.5.2 内嵌数据只有 16 个配置 JSON（无 `t2seal` / `seal2t` / `s2seal`）与对应词典 → **本阶段实现 14 种标准方向**（内含 16 个 JSON 中未直接暴露为标准方向的组合亦通过 `Custom` 支持）。偏差已注记于 F-03 §3.2。
2. **歧义诊断实现方式**：OpenCC C API 不暴露内部 Segments（CLI `--ambiguities` 用的是私有 C++ 接口），故采用**同族方向差分**——`s2t` / `s2tw` / `s2twp` / `s2hk` 互为同族，逐行比对用字差异即为「地区用字歧义」。语义对用户等价（都能提示"此处有别的合理写法"），机制与 CLI 不同，已在 F-03 §3.8 注记。
3. **修复第二阶段遗留缺陷**：`Editor` 的 `updateListener` 闭包捕获挂载时的 tab，切标签后仍用旧 id → 会把新标签内容写回旧标签并误标 dirty。已改为始终取 `tabRef.current.id`，并引入「程序性替换抑制标志」区分用户编辑与同步替换（真实 UI 测试已验证：转换后 dirty 正确、切标签不再串写）。
4. **`opencc-sys` 首次编译约 2 分钟**（cmake 编译 OpenCC C++ 全库）；Windows 上若 `target/` 被 `tauri dev` 占用，重跑 cargo 会偶发 cmake 构建脚本冲突 → 验证前先停 dev 实例。

### 待后续阶段

- F-04 自定义替换表的**表管理与独立查找替换 UI**（后端解析与内联叠加已就绪）
- F-05 中文正则；F-06 文件比较；批处理等

---

## 开发日志 004 — 2026-10-15（第四阶段：自定义替换表 + 中文正则，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/replace.rs` | F-04 表模型（`ReplaceTable` / `ReplaceEntry` / `ReplaceRules` / `TableMeta`）、TextPro 风格解析（`A=B`、`A/B=C`、`;`/`#` 注释、`#name:`/`#desc:`/`#rules:` 元数据、`\n`/`\t`/`\\` 转义、**源行号级诊断**）、校验报告、用户表目录管理（列表 / 载入 / 保存 / 另存副本 / 删除，**表名接受文件名或 `#name:` 显示名**）、**独立替换引擎**（Aho-Corasick `LeftmostLongest`，整词边界可选）、OpenCC 内联词典导出、**内置示例表首启复制**（幂等） |
| `core/regex.rs` | F-05 中文增强正则：`extend()` 单遍预转换 `\c[GBK]` 等 12 个类目 + `\a` `\d` `\n` `\t` `\x...`；`\c[GBK]`/`\c[BIG5]` 按**实际码表**逐字符解码为精确字符集；忽略回车 / 半角空格 / 标点三开关（移除被忽略字符再匹配 + 边界回映射）；UTF-16 偏移口径；`\1` 与 `$1` 捕获组引用 |
| `commands/replace.rs` | 11 条命令（含为镜像编辑器新增的 `read_replace_table_source` / `parse_replace_table_text` / `save_replace_table_source`），重活经 `spawn_blocking` |
| `commands/regex.rs` | `regex_categories` / `regex_find` / `regex_replace`（`skip`+`limit` 支持「替换当前这一个」与「全部替换」） |
| 前端 | `SearchPanel`（查找替换：类目下拉插入、6 个开关、上/下/替换/全部替换、命中计数）、`ReplaceTableDialog`（表清单 + CodeMirror 镜像编辑器 + 实时校验标红 + 新建/导入 TextPro `.tab`/另存副本/删除/应用到正文）、`TableSourceEditor`、`Editor` 新增 **CM6 命中高亮 StateField** 与外部选区请求、转换对话框叠加用户表勾选（F-04 模式 B）、`Ctrl+F` 与工具栏入口 |
| 数据 | `scripts/gen-builtin-tables.mjs` 从 opencc-sys 内嵌 OpenCC 词典生成三张内置表：异体字校正（兼容区）1002 条、古籍异体字规整 78 条、中文标点修正 28 条；生成后按解析器规则**回读校验条目数**（防静默丢行） |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy --all-targets -- -D warnings` ✓（0 警告）、单测 **78/78** ✓、F-03 契约集成测试 5/5 ✓、**F-04/F-05 契约集成测试 8/8** ✓（`tests/stage4_contract.rs` 交叉验证 serde 形状、模式枚举取值、行号、UTF-16 偏移）
- **前端**：vitest **34/34** ✓、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright 驱动运行中的应用，**24/24 通过**）：
  - 首启复制：`list_replace_tables` 返回 3 张内置表（1002 / 78 / 28 条）且文件落在 `%APPDATA%/AioTextEditor/tables/builtin/`；**重启后 `copied=0`**（幂等）
  - 表管理：对话框列出 3 表并标内置徽标 → 载入源文本（36 行，保留注释）→ 添加裸文本行 → **错误行标红 + 报告「第 36 行第 29 条缺少 `=`」+ 保存按钮禁用** → 修正后恢复可保存
  - 模式 A：内置「中文标点修正」→「应用到正文」→ `中文测试,句号.问号?结束` ⇒ **`中文测试，句号。问号？结束`**，提示条给出按词统计（`,×1、?×1、.×1`）
  - 新建/保存：模板 → 改名「阶段四测试表」→ 保存 → 文件落盘 `%APPDATA%/AioTextEditor/tables/阶段四测试表.tab`、列表出现用户表
  - 查找：`\c[天干]` 命中 3 字（1 个当前高亮）并**自动选中**第一个命中「甲」
  - 忽略开关：默认搜「关键词」对「关 键\n词 出现」**无命中**；勾选忽略回车 + 忽略半角空格后命中 1 处，高亮区间为「关 键\n词」（不含尾随空格）
  - 替换：「甲-甲-甲」→「替换」⇒「X-甲-甲」（只改当前一处）→「全部替换」⇒「X-X-X」
  - 模式 B：转换对话框列出用户表（含内置徽标）→ 勾选「阶段四测试表」→ 预览「我的鼠标垫」⇒「我的滑鼠墊」（用户词典优先于简繁基线）

### 关键决策与发现

1. **真实 UI 回归抓出一个真缺陷（已修）**：忽略开关的偏移回映射原先把「命中终点」映射为下一个字符的起点，导致命中吞掉尾随的被忽略字符——`关 键 词 ` 里命中 `关键词` 会连带尾随空格，替换也会误删空格。改为**起点/终点双规则**（起点=字符起始；终点=前一个命中字符末尾），并补单测 `match_end_does_not_swallow_trailing_ignored_chars` 锁定。
2. **生成脚本抓出第二个数据缺陷（已修）**：`cn-punct.tab` 中 `;=；` 与 `#=＃` 两行被解析器当注释吞掉（表却声称覆盖半角标点）。已把两键从生成列表移除、在表头 `#注意:` 说明「`=` `/` `;` `#` 无法作为键」，并让脚本按解析器规则**回读校验条目数**，不一致即报错。
3. **模式 B 的语义**：`apply_user_tables` 经 `opencc::convert_dict_only` / `convert_with_inline_dicts` 写入 `short_circuit` **首位**（最高优先级，实测「鼠标垫」⇒「滑鼠墊」而非「滑鼠垫」）；模式 A 则完全走自有引擎（Aho-Corasick），两条路径共用同一张表，UI 上分别落在「转换预览…」与「应用到正文」。
4. **表名与文件名解耦**：`#name:` 是显示名（UI 列表与模式 B 勾选都用它），文件名另有其名 → `resolve_table_path` 先按文件名精确匹配、再按显示名扫描（用户目录优先），避免「内置表按显示名载入失败」。
5. **镜像编辑器以源文本为唯一事实来源**：保存写回**原始文本**（保留注释与排版），保存前由后端解析并把**源行号**带回 UI 标红；内置表另存时一律落到用户目录并自动追加 ` (2)`，不覆盖既有表。
6. **`=` 无法作为键**是格式的硬约束（与 TextPro 一致）：如需替换字面 `=` 或 `/`，目前须借助 F-05 正则替换（`\x{3D}`）——已记入 F-04 §4.3。

### 待后续阶段

- F-05 §5.5 的**编译错误行号跳转**（现为文本诊断）与 v1.1 的表导出（`export_opencc_json` / `.ocd2`）
- 第五阶段：整理工具集（删除空行 / 段内回车 / 半角↔全角 / 行首行末空格 / 重复行 / 排序 / 匹配括号 / 竖排符号）
- 第六阶段：文件比较与合并（`fc1.txt` / `fc2.txt` 异体字组表将在此启用）

---

## 开发日志 005 — 2026-10-15（第五阶段：文本整理工具集 F-09，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/pipelines.rs` | **18 个工具 = 18 个独立函数**：删除行首空格 / 删除行末空格 / 删除空行 / 段间空一行 / 按行排序 / 删除重复行 / 删除半角字符 / 全角转半角 / 半角转全角 / 竖排符号横转 / 半角引号转全角 / 匹配括号（只检查）/ 括号嵌套转换 / 规范行首 / 删除段内回车 / 自动分段 / 控制行宽 / 简单排版。`PipelineStep`（`#[serde(tag = "kind")]` + camelCase 选项）既是「工具目录」也是「流水线步骤」；`catalog()` 给出菜单元信息（label / group / hint / hasOptions / inspectsOnly），`from_id()` 构造默认选项步骤，`run_step()` / `run_chain()` 执行；`StepOutcome{text, changed, notes, bracketIssues}` 统一回执 |
| `core/regex.rs` | 抽出 `replace_generic(…, render)` 公共内核，新增 `replace_with_tool()`：对每个命中调用整理工具、再拼回正文（F-09 的「对每个命中套用工具」） |
| `commands/pipelines.rs` | `pipelines_catalog` / `apply_pipeline_step` / `apply_pipeline_chain`；`commands/regex.rs` 增 `regex_replace_with_tool`；重活一律 `spawn_blocking` |
| 前端 | `ToolMenu`（「整理 ▾」：按后端目录分组、`hasOptions` 显示「…」、`inspectsOnly` 标「仅检查」、菜单内「常用」快捷区）、`ToolOptionsDialog`（声明式 `TOOL_FIELDS` schema 生成表单 + 250ms 防抖实时预览 + 整篇 / 选中文本作用范围）、`SearchPanel` 增「使用工具」下拉（选中后替换框禁用，按钮变「处理当前 / 全部处理」） |
| 契约 | `src-tauri/tests/stage5_contract.rs` 7 项：锁定 `ToolMeta` / `StepOutcome` / `BracketIssue` 键名与前端 TS 接口一致、`PipelineStep` 的 JSON 形状（含省略选项时取默认值）、串联顺序、`RegexReplaceReport` 形状 |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy --all-targets -- -D warnings` ✓（0 警告）、单测 **110/110** ✓（`core::pipelines` 31 项，每个工具至少 1 项，另含行尾符保真与幂等性）、契约集成测试 **20/20** ✓（stage3 5 + stage4 8 + stage5 7）
- **前端**：vitest **40/40** ✓（新增 F-09 接口 6 项）、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright 驱动运行中的应用，**27/27 通过**）：
  - 菜单由目录驱动：4 分组（行处理 / 空格与全半角 / 标点与括号 / 排版与分段）+ 18 项 + 4 个常用快捷入口；1 个「仅检查」、11 个带「…」
  - 无选项工具点一下即应用：`甲一 ␊␊　␊乙二  ␊` →「删除空行」⇒ `甲一 ␊乙二  ␊`（提示「删除 2 个空行」）→「删除行末空格」⇒ `甲一␊乙二␊`
  - 有选项工具 + 选区：选中前两行后打开「删除段内回车」，作用范围**默认「选中文本」**，应用 ⇒ `甲一甲二␊乙一␊乙二`，提示标「（选区）」；`Ctrl+Z` 精确回退
  - 实时预览：控制行宽默认 40 不折行 → 改 15 ⇒ 预览按 7 字折行、提示「按 15 个半角宽折行，新增 1 行」→ 应用后正文折行
  - 自动分段：`甲一。甲二！␊「对话。」乙。` ⇒ `　　甲一。␊　　甲二！␊「对话。」␊　　乙。`（对话行不缩进、收尾引号不另起行）
  - 匹配括号：`甲（乙␊丙）␊丁」` 只报「未闭合 / 多余」共 3 处，**正文零改写**
  - 括号嵌套：`（甲（乙（丙）））` ⇒ `（甲「乙『丙』」）`；竖排 `﹁甲﹂` ⇒ `「甲」`；半角 `"乙"` ⇒ `“乙”`
  - 快捷入口「简单排版」一次完成删除空行 + 删除行末空格 + 规范行首，提示条分步列出各步结果（「删除 2 个空行；清理 2 行行末空格；规范 1 行行首」）
  - 查找替换「使用工具」：`[ab]` 命中 2 处 →「全部处理」⇒ `ａ甲 ｂ甲 c`（只动命中），信息条「已用工具处理 2 处」，替换输入框在「使用工具」下禁用

### 关键决策与发现

1. **`fix_brackets` 的幂等性设计**：同款嵌套要按 `（）→「」→『』` 阶梯改写，但已规范的 `（甲「乙『丙』」）` 不能再被改写。因此把括号分两族——**「改写」族**（半 / 全角圆括号 `(` `（` / `)` `）`）与**「跟踪」族**（`「」『』` 等阶梯括号，只用于计算嵌套深度）。单测 `fix_brackets_is_idempotent_on_ladder_styles` 锁定。
2. **默认缩进必须写进 `Default`**：「简单排版 / 规范行首 / 自动分段」缺省缩进 2 个全角空格。`SimpleLayoutOptions` 不能 derive `Default`（会得到 0），改为手写 `impl Default`，并加 `defaults_match_spec` 单测把「菜单里直接点一下」的效果钉死。
3. **全半角互转共用一个函数**：`half_full_convert(text, opts, to_full)`，偏移 `+0xFEE0` 双向对称；默认只动字母数字与空格，**避免把中文标点 `，。` 变成 `,.`**（要转标点需显式打开）。
4. **`changed` 的语义按工具而定**（删除行数 / 转换字符数 / 折行数…），一律在 `notes` 里给出人类可读说明由 UI 直接显示，不做统一含义的强行约定。
5. **真实 UI 回归又抓出一个真缺陷（已修）**：`ToolOptionsDialog` 在 `useEffect` 中同步 `setBusy(true)` 触发 `react-hooks/set-state-in-effect` 规则，改为在防抖回调内部置位。
6. **E2E 夹具必须保真（本轮排查的关键）**：CodeMirror 的 Enter（`insertNewlineAndIndent`）会改写 `page.keyboard.type` 输入的多行文本；`innerText` 又会吃掉行末空格、凭空多出空行。真实 UI 脚本因此改用 `keyboard.insertText` 写入、拼接 `.cm-content > .cm-line` 读取，才与后端拿到的文本严格一致——「删除空行提示 3 个而非 2 个」的根因就在输入侧，而非工具实现。
7. **残留对话框会让后续点击全部超时**：上一轮异常退出留下的 `.dialog-overlay` 会拦截整页指针事件，脚本已加入自助清理（先按「取消 / 关闭」再兜底 `Escape`）。

### 待后续阶段

- 「拼音 / 笔画排序」（F-09 表内注明"扩展可拼音 / 笔画"）与 F-11 §11.3 的自定义工具栏
- 第六阶段：文件比较与合并（`fc1.txt` / `fc2.txt` 异体字组表在此启用）；`apply_pipeline_chain` 已就绪，供第七阶段批处理复用

---

## 开发日志 006 — 2026-10-15（第六阶段：文件比较与合并 F-06 / F-07，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/data_tables.rs` | TextPro 异体字组表加载器：`fc1.txt`（1003 组，完全等同） + `fc2.txt`（10573 组，部分等同）；UTF-8 with BOM 行解析、首次出现组生效；`OnceLock` 进程内缓存 |
| `core/compare.rs` | **同步逐字比较**：O(n) 流式规范化（跳过忽略项 + 异体字组折叠为「组键」）→ 双指针逐字推进，**失配处两侧各进一步**（TextPro 逐字口径）；偏移始终是原文 UTF-16 码元；差异清单上限 5000 + `truncated` 标志；4 种结束原因（`bothEnded` / `aEnded` / `bEnded` / `truncated`） |
| `core/merge.rs` | 文件合并规划器（纯函数，吃内存 `MergeItem`）：`Simple`（行尾追加空行）/ `SameName`（按源正则第 1 捕获组分文件，组内自然排序）；排序为**自然排序**（`2` < `10`），键相同时按文件名次排序、没给排序关键字时保持用户挑选顺序；模板 `\1.txt` 渲染；`plan_merge` 可万级直测 |
| `commands/compare.rs` | `compare_texts(a, b, opts)`，异体字组表从资源目录加载并缓存 |
| `commands/merge.rs` | `merge_files(req)`：`Manual`（多文件清单 + 输出文件）/ `Auto`（目录 + 正则三件套，输出落源目录）；读源**跳过并在报告里说明**；输出已存在时**默认跳过**，可勾选覆盖 |
| 前端 | 「比较…」对话框（对照标签 / 忽略项 / 异体字策略 / 平铺方向）；`Editor` 增 `readOnly` + `SelectionRequest.focus`；双栏平铺 A/B 窗（A 可编辑，B 只读不抢焦点）；`CompareBar`（差异计数 + 上一处 / 下一处 / 从光标重比 / 退出）；F5 跳下一处、Shift+F5 从两个光标处重比；「合并…」对话框（手工清单 / 正则自动，覆盖开关，UTF-8 落盘） |
| 契约 | `tests/stage6_contract.rs` 5 项：锁定 `CompareOptions` / `CompareReport` / `CompareEnd` / `Difference` / `MergeRequest` / `MergeReport` / `MergedOutput` 的 serde 形状与前端 TS 接口一致；`MergeRequest` 用 `tag + flatten` 拼出平铺 JSON |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy --all-targets -- -D warnings` ✓（0 警告）、单测 **138/138** ✓（`core::compare` 12 项含 50 MB 大文本直测、`core::merge` 11 项含 1 万文件直测、`core::data_tables` 4 项）、契约集成测试 **25/25** ✓（stage3 5 + stage4 8 + stage5 7 + stage6 5）
- **前端**：vitest **47/47** ✓（新增 F-06 / F-07 接口 7 项）、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright，**23/23 通过**）：
  - 标签数控制入口：1 个标签时「比较…」禁用，2 个可用（跨轮 E2E 沿用 dev 实例的清理）
  - 双栏平铺（A 可编辑、B 只读 + 标"只读"+ `contenteditable=false`） + CompareBar（差异 1/1、双方字符、状态栏"发现 1 处不一致"）
  - F5 在最后一处给出提示（"已到最后一处；改动后可按 Shift+F5 从两个光标处重新比较"）；退出比较恢复单窗格
  - 忽略半角空格：相同文本（带空格 vs 不带空格）`0` 差异 + "两文一致"
  - 异体字策略：`伪` ≡ `偽`（fc1：伪偽僞）按 `fullEq` 视为相同、按 `strict` 报差异；从光标重比沿用上次选项
  - Shift+F5 从两个光标处重比（重选同步起点）
  - 自动合并：源正则 `(\d+)_(\d+)\.txt` + 模板 `\1.txt` + 排序 `\2` 写出 `1.txt`（1_2、1_10 按自然排序拼接）、`2.txt`（2_1），无关文件被静默过滤；未勾覆盖时再次合并→「跳过 2 项…已存在」；勾覆盖后正常写出
  - 缺目录时合并按钮给出表单提示「请先选择源目录」

### 关键决策与发现

1. **比较采用 TextPro「逐字同步」而非 Myers diff**：规格 §6.5 提到的 `similar` / Myers 方案是实现提示，但 F-06 的用户故事是「F5 同步、逐字校对、一方到达尾部即结束」，Myers 求的是最小编辑脚本——在失配处两侧各退一步会与 TextPro 的「两侧各进一步」行为不符。改用流式 O(n) 同步逐字实现，**百 MB 文本单核 ~秒级**就能跑完（50 MB × 2 内嵌 3 处差异的直测），无需为百 MB 用例引入额外依赖；实现偏差已记录在 F-06 实现注记。
2. **比较偏移统一为 UTF-16 码元**：与 CodeMirror / regex 阶段一致，前端零换算；位置指向**原文坐标**（不受忽略项过滤影响）——这是单测 `positions_are_original_offsets_despite_ignored_chars` 锁定的关键不变量。
3. **差异清单上限 5000 + `truncated`**：百 MB 全异文本不至于生成上亿条目，UI 提示「仅显示前 N 处」。
4. **结束原因四种**：A/B 双栏平铺时，UI 需要据 `aEnded` / `bEnded` / `truncated` / `bothEnded` 给出「B 窗多出 N 字」「差异已截断」等不同提示；`CompareEnd` 直接对应到 UI 字符串。
5. **异体字策略是「叠加」关系**：`FullEq` 只用 fc1（伪＝偽）；`PartialEq` 优先 fc1 再叠加 fc2（达＝達），即「部分等同」是「完全等同」的超集——`variant_partial_eq_stacks_fc2_on_fc1` 单测锁定。
6. **自然排序 vs 字典序**：文件名 `1_2` / `1_10` 按字典序 `1_10 < 1_2`，按自然序 `1_2 < 1_10`。后者是「(\d+)_(\d+)\.txt 这类文件名」唯一合理的选择；为避免用 `2` 排在 `10` 前这类错位结果，直接做了**数字段按数值比较**的 `natural_cmp`，**数字段后的字符仍参与比较**（bug 修复：原 `from_fn` 闭包会把分隔符当数字段的非匹配字符吞掉，重写为基于 `Peekable` 的 `take_digits`）。
7. **`MergeRequest` 的 tag + flatten 平铺 JSON**：内部带 `mode` 判别的请求若用「结构体里嵌一个 internally-tagged 枚举字段」，前端要发嵌套 JSON `{"mode":{"mode":"manual","files":…},"strategy":…}`，丑且易错。改用「顶层 `MergeRequest` 枚举 + `#[serde(flatten)] shared` 共用字段」，前端就是干净的平铺对象 `{"mode":"manual","files":[…],"strategy":"simple",…}`，TS 判别联合直接对应。
8. **排序的平局策略**：`sort_by_key` 在**给了排序关键字**时按「键名 → 文件名」自然序两轮比较，`1_10` 排在 `2_10` 前，与文件管理器一致；**没给排序关键字**时保持用户挑选的输入顺序（`no_sort_key_keeps_input_order` 锁定）。
9. **覆盖开关在命令层**：`overwrite: bool` 显式在请求里；不勾时跳过并在 `MergeReport.skipped` 写明「输出文件已存在（未勾选覆盖）」，让用户在通知里看到、而不是被静默覆盖。
10. **真实 UI 又抓到两个真问题**：
    - **CodeMirror 在无 DOM 焦点时不渲染 `cm-selectionBackground`**——E2E 早期用 `.cm-selectionBackground` 计数验证「两窗都跳差异」总为 0；改用 `window.getSelection()` 检查「差异字符之一被选中」（B 窗只读不抢焦点，DOM 选区自然落在 A 窗），更准确地反映实际行为。
    - **dev 实例状态会跨 E2E 轮次残留**——上一轮留在 `compare` 会让本轮的「比较…」按钮一直禁用。脚本里加了启动清理：检测 `.compare-bar` 主动退出、多余 `.tabbar-item` 主动关（注册 `dialog` 处理器接受原生 confirm，让脏标签走「不保存」分支），这是 E2E 自身稳定性、不是被测功能的 bug，已沉淀为约定。

### 待后续阶段

- 第七阶段：批处理（`apply_pipeline_chain` 已就绪供复用）
- v1.1：自定义工具栏（F-11 §11.3）+ 比较模式的三栏平铺（对照窗）、「同步滚动」（规格 §6.5 提到的另两条扩展）
- 「拼音 / 笔画排序」与 F-11 §11.3 自定义工具栏同期

---

## 开发日志 007 — 2026-10-15（第七阶段：批处理 F-08，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/batch.rs` | **纯算法核心（不依赖 Tauri，可直测）**：`enumerate_files`（`walkdir` 递归，`depth=1` 非递归，`*.bak` 一律排除）、`run_batch`（`rayon` 并行 + 取消信号 `&AtomicBool` + 进度回调 `Fn(BatchFileEvent)`）、`run_one_file`（读 → `run_chain` → 判「是否需要写出」→ 备份 → 写 → 恢复 mtime）；`BatchRequest` / `BatchSummary` / `BatchFileError` / `BatchPhase` / `EncodingOrAuto`（手写 serde，裸字符串） |
| `commands/batch.rs` | `batch_run(req, progress: Channel<BatchProgress>)`、`batch_cancel()`、`batch_plan(req)`；`ProgressThrottle` 把高频回调**合并**成低频快照（见关键决策 1）；`tauri::async_runtime::spawn_blocking` 承载重活 |
| `core/encoding.rs` | 逐文件读 / 写日志由 INFO 降为 **DEBUG**（见关键决策 2） |
| `lib.rs` | 日志改用 `EnvFilter`（`RUST_LOG` 可放开 DEBUG）+ `.manage(BatchCancel)` + 注册 3 个新命令 |
| 前端 | `BatchDialog`（路径输入 / 浏览… / 添加、递归开关、自动预览「将处理 N 个文件」、双栏步骤选择：工具库按组 → 队列 + 上移 / 下移 / 移除、输入输出编码、备份与 mtime 开关、进度条 + 当前文件、按阶段染色的错误面板、取消 / 完成）；`tauriApi` 增 `batchRun`（走 Tauri 2 `Channel<BatchProgress>`）/ `batchCancel` / `batchPlan`；App 顶栏「批处理…」 |
| 契约 | `tests/stage7_contract.rs` 5 项：`BatchRequest` camelCase + `EncodingOrAuto` 裸字符串 + `BatchPhase` 小写 + `BatchSummary` 键名 + 端到端 `run_batch` 回执 |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy --all-targets -- -D warnings` ✓（0 警告）、单测 **156/156** ✓（`core::batch` 18 项：枚举 / 递归 / 非递归 / 备份 / mtime / 取消 / 幂等 / 重编码 / `.bak` 排除 / 300 文件 × 5 步骤 / 无效路径入报 / 非 UTF-8 输入 / serde 形状）、契约集成 **30/30** ✓（stage3 5 + stage4 8 + stage5 7 + stage6 5 + stage7 5）
- **前端**：vitest **50/50** ✓（新增 F-08 接口 3 项）、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright，**46/46 通过**）：
  - 入口与对话框：工具库按组铺开、**不含「仅检查」的匹配括号**、路径添加 / 移除、预览计划
  - 双栏步骤选择：加入顺序 → 上移 → 下移 → 移除 → 再加回，全部与预期一致
  - 预览计划：非递归 5 个文件（`深度=1`）→ 开递归 6 个（`深度=∞`）→ 关回 5 个
  - 运行落盘：`甲␣␣\n\n\n` 经「删空行 + 规范行首 + 删行末空格」⇒ `　　line 0\n`；`.bak` 内容为**改写前原文**；子目录文件未被动
  - 幂等 + mtime：目录里已混入上一轮 `.bak`，预览仍报 5 个（`.bak` 被排除）；第二次 0 改写、mtime 未动、未产生 `.bak.bak`
  - 错误面板：无效路径记为 `enumerate` 阶段「路径不存在」，其余 5 个文件照常处理
  - 编码互转：GBK 输入 → UTF-8 输出，正文未变也照样写出（重编码算改写）
  - 300 文件 × 5 步骤：**114ms**（改造前 21320ms）
  - 1 万文件 × 3 步骤：**3.9s**，且运行中确实出现中间进度（首个采样 740/10000）
  - **多错误计数**：1 万文件任务额外挂 12 条无效路径，运行中 87 次采样都显示「错误 12」，而同一时刻错误**列表**只有 1 条——直接钉住「计数用后端快照、不用列表长度」（见关键决策 12）
  - 多错误清单：10 条无效路径 + 3 个有效文件，结束后汇总「错误 10」且面板恰好列出 10 条、全部标 `enumerate`，有效文件仍全部处理
  - 取消：2000 文件任务在 109/2000 处取消，汇总标「已取消」、改写数远小于总数

### 关键决策与发现

1. **进度必须合并上报（本阶段最重要的实测结论）**。规格 §8.5 写的是「把每个文件的进度推到前端」，但实测 `Channel::send` 单次 **35~100ms**（VM 内 WebView2 的 IPC 往返）：

   | 做法 | 300 文件（core 内部计时） |
   |------|--------------------------|
   | 每文件 2 条事件（Started + Done） | **21.3s** |
   | 后端合并为快照（每 100ms 一条） | 5.8s |
   | 首次延迟 300ms、间隔 500ms | **0.12s** |

   而 `core::batch` 真正跑完 300 文件 × 5 步骤只需 **0.12s**——**进度上报把批处理本身完全盖住了**（164×）。改为 `ProgressThrottle`：计数用原子量累加、至多每 300ms / 500ms 发一条快照、收尾补 `Finished`；**短任务因此完全不报中间进度**。前端也顺势简化（不再累加计数，直接写 state）。
2. **逐文件 INFO 日志会串行化并行批处理（第二个 164×）**。`core::encoding` 原本对每个文件的读、写各打一条 INFO，而 tracing 的 fmt 订阅器是**全局互斥**的 stdout 写——批处理是 `rayon` 并行的，所有 worker 抢同一把日志锁，且 stdout 被重定向到文件时每次写都不便宜。实测 300 文件因此从 0.12s 退化到 **20.3s**。现降为 DEBUG（`lib.rs` 改用 `EnvFilter`，`RUST_LOG=debug` 可开），批处理只留一条收尾汇总。
3. **「是否需要写出」的判定必须包含重编码**：输入 GBK、输出 UTF-8 时，即使流水线一个字没改也要写出，否则「编码互转」在正文无变化时被静默跳过（E2E 抓到的真 bug）。
4. **`*.bak` 不得作为输入**：否则第二次运行会产出 `x.txt.bak.bak`，「备份」语义也随之破坏（E2E 抓到的真 bug）。枚举阶段一律跳过——显式把 `.bak` 当单个输入传入也跳过。
5. **`EncodingOrAuto` 手写 serde 而非 `untagged`**：`untagged` 下单元变体 `Auto` 会序列化成 `null` 而非 `"auto"`（单测抓到的真 bug）。手写后前端发裸字符串，未知编码直接报错而非静默回退。
6. **无效路径不致命**：单个输入不可访问（不存在 / 权限不足 / 网络盘掉线）→ `enumerate_files` 静默跳过、`run_batch` 统一记入 `Enumerate` 阶段错误，其余文件照常处理。这样「一个笔误的路径毁掉整批任务」不会发生。
7. **取消不做半途中断**：`batch_cancel` 只置位 `Arc<AtomicBool>`，`run_batch` 在每个文件**开始前**查一次——已启动的文件跑完，避免写出半个文件。
8. **`preserveMtime` 做成显式开关**（默认开）：规格只写了「不变更 mtime」这一行为，没提是否可关；但「只处理、时间戳照常更新」（让下游同步工具感知变化）也是真实需求。
9. **重编码放在输入 / 输出编码选项，而不是流水线里的一步**：先解码一次、最后编码一次，中间步骤始终在 `String` 上工作；用户可见行为与规格 `Step::Reencode` 一致，且省掉反复编解码。
10. **E2E 的新约定**：批处理不经编辑器，故不涉及 CodeMirror 的输入 / 读取坑；但**原生目录选择对话框无法自动化**——最初只给了「选择目录…」按钮，脚本无法驱动。改为「路径输入框（可键入 / 粘贴）+ 浏览… + 添加」，既便于自动化也更适合粘贴长路径。另：dev 实例状态跨轮次残留的清理约定继续沿用。
11. **修掉一处自己引入的文档缺陷**：插入开发日志 006 时误删了 005 的标题行，导致 005 正文成了 006 的孤儿段落，已补回。
12. **错误「计数」与错误「列表」是两回事**（本轮复查抓到的真 bug）。后端为省 IPC 把进度合并成快照（关键决策 1），每个快照只带「本次新增的**最后一条**错误」，所以前端手里的错误列表在运行中被压缩过。原实现用 `errors.length` 当错误总数显示——挂 12 条无效路径时运行中会显示「错误 1」。快照里本来就有准确的 `errors` 计数字段，现改为 `errorCount`（计数字段）+ `errors`（仅展示，运行中为最近若干条、结束后以 `report.errors` 全量覆盖），并在列表少于总数时明示「结束后显示完整清单」。
13. **别拿 state 当「本次调用内是否已发生」的标志**（同轮复查抓到的真 bug）。`handleStart` 里的兜底分支写成 `if (!finalReport)`，而 `finalReport` 是该次渲染闭包里的快照值、事件回调里的 `setState` 不会回写它，判断**恒为真**——注释所说的「finished 事件没走到才兜底」从未成立。改用局部 `let sawFinished = false` 标志，由事件回调置位，语义才与注释一致。
14. **清理脚手架不能连正在用的文件一起删**：把 dev 启动脚本放在仓库根目录，收尾清理时连同 `dev-stdout.log` / `dev-stderr.log` 一起删掉，导致 `tauri dev` 的 watcher 重启失败（日志末行「找不到批处理文件。」），dev 实例直接挂掉。现启动脚本与日志一律放仓库外的临时目录。

### 待后续阶段

- 第八阶段：偏好设置（F-11）与快捷键配置
- 批处理流水线扩展：把简繁转换 / 替换表 / 自定义替换表也作为步骤接进流水线（技能已具备，UI 未接线）
- 「备份回滚」：目前只生成 `.bak`，一键还原留待后续

---

## 开发日志 008 — 2026-10-15（第八阶段：偏好与快捷键 F-11，全部完成）

### 已交付

| 层 | 内容 |
|----|------|
| `core/settings.rs` | **纯算法核心（不依赖 Tauri，可直测）**：`Settings`（`appearance` / `editor` / `conversion` / `compare` / `shortcuts`）、`Appearance`、`EditorPrefs`、`ConversionPrefs`、`Theme`（`System` / `Light` / `Dark`，含 `label` / `from_label` / `next` 循环切换）；`load` / `load_from` / `save` / `reset` / `reset_at`；**原子写**（同目录临时文件 + `rename`）；坏文件先备份为 `settings.json.bad` 再回落；`sanitize` 钳制（字号 12–32、`tabWidth` 1–16、空白字体回落默认）；`clean_shortcuts`（去空键 / trim，**保留空值**＝显式解绑） |
| `core/paths.rs` | 抽出 `app_data_dir()`（`%APPDATA%/AioTextEditor` / macOS / linux），让 settings 不再依赖 `replace`；`replace.rs` 用 `pub use` 保持既有路径 |
| `core/encoding.rs` | `EncodingOrAuto` 从 `batch` 迁入（手写 serde，前端发裸字符串 `"auto"`）；`core/batch.rs` 以 `pub use` 转发保持既有路径 |
| `commands/settings.rs` | `settings_get`（**永不失败**）/ `settings_save`（返回**实际落盘值**）/ `settings_reset`；`error.rs` 增 `Settings(String)` 变体；`lib.rs` 注册 |
| `src/shared/shortcuts.ts` | 快捷键引擎（三层纯函数）：**命令注册表** `COMMANDS`（id / 显示名 / 分组 / 默认键位——「默认键位」的唯一事实来源）、**键位规范化**（`normalizeKey` / `keyFromEvent` / `formatKey`）、**绑定解析与冲突**（`resolveBindings` / `buildIndex` / `findConflicts` / `conflictsWith` / `reservedReason` / `shouldHandleKey`） |
| `src/store/settingsStore.ts` | `useSettingsStore`（`load` / `update` 改动即存 / `reset` / `flush` / `applyServerValue` 回执灌回）+ **300ms 防抖落盘**；`useBindings` 供分发器消费 |
| `src/components/SettingsDialog.tsx` | 五页签对话框（外观 / 编辑器 / 转换 / 比较 / 快捷键）；快捷键**录制**（捕获阶段 `keydown` + `stopPropagation`）、冲突标红 + 页内汇总、清除（显式解绑）/ 单个默认 / 恢复全部默认 |
| `App.tsx` | **命令分发器**替换散落的 `window` keydown 监听（`handlers` 映射 + `enabled` 守卫 + `shouldHandleKey` 让位输入框）；设置下拉（选项… / 自定义快捷键… / 恢复默认设置）；**外观设置真正生效**（`color-scheme` + `data-theme` + CSS 变量 + CodeMirror `Compartment` 原地重配） |
| 契约 | `tests/stage8_contract.rs` 7 项：默认形状 / camelCase / `Theme` 小写 / `shortcuts` 映射 / 原子读写往返 / 坏文件恢复 / `reset` |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy --all-targets` ✓（0 警告）、单测 **173/173** ✓（新增 `core::settings` 17 项：默认值 / 原子写 / 往返 / 坏文件回落 / 逐字段恢复 / 数值钳制 / `null` 边界 / 空串解绑）、契约集成 **37/37** ✓（stage3 5 + stage4 8 + stage5 7 + stage6 5 + stage7 5 + stage8 7）
- **前端**：vitest **103/103** ✓（5 文件；新增 `shortcuts.test` 键位规范化 / 事件 / 显示 / 三态覆盖 / 冲突 / 保留键 / `mod` 平台解析 / 分发器守卫，`settingsStore.test` 载入 / 防抖 / 回执灌回 / 失败 / 恢复默认）、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright，**51/51 通过**）：
  - 设置下拉：选项… / 自定义快捷键… / 恢复默认设置；点空白收起；「选项…」标出 `Ctrl+,`
  - 选项对话框：五页签齐全，默认落外观页；「自定义快捷键…」直达快捷键页
  - 默认快捷键生效：`Ctrl+,` 开设置、`Ctrl+F` / `Ctrl+H` 分别聚焦查找 / 替换框、`F3` / `Shift+F3` 前后跳命中、`Ctrl+Alt+F` 转全角、`Ctrl+Alt+H` 转半角
  - 外观：主题切 dark（`color-scheme` + `data-theme` 同步）、字号 21px / 字体 Georgia 作用到正文、行号 / 工具栏 / 状态栏开关（**设置入口不能被自己关掉**）
  - 持久化：改动即存 → 磁盘 `settings.json` 有值 → 重载页面后仍生效
  - 录制改绑：`file.new` 录成 `Ctrl+Alt+N` → 真能新建标签；冲突检测（两行标红 + 页内汇总 + 全局提示条）
  - 清除（显式解绑）后冲突消失；「默认」恢复单个默认；「恢复全部默认」把主题 / 字号回位

### 关键决策与发现

1. **默认键位用 `mod` 令牌，而不是字面 `ctrl`**。第八阶段之前两处内联监听写的是 `e.ctrlKey || e.metaKey`（两个都触发）。若注册表把默认键位写成字面 `ctrl+s`，macOS 的 ⌘S / ⌘F 会**静默失效**——这是行为回退。故 `COMMANDS` 的默认键位统一写 `mod('s')`，模块加载时按平台解析成 `ctrl` 或 `meta`（`IS_MAC` / `MOD`）；用户在设置里录制的本就是解析后的形式，两侧一致。`file.close` 在 macOS 默认不绑（⌘W 归系统）。
2. **「默认键位」只有一份事实来源**。后端 `settings.json` 只存**覆盖项**（三态约定：缺键 = 默认、空串 = 显式解绑、非空 = 覆盖）。「恢复默认」只需删键，而不必把默认表复制一份到后端——避免前后端两份默认表漂移。
3. **宽松读取：让 serde 当裁判，逐字段恢复**。最初想用「默认 JSON 与小节 JSON 合并」实现宽容，但 `merge_onto` 只按 JSON 类型判断——`"fluorescent"`（字符串）与默认 `"system"` 同型，非法值被留下，导致整段 `from_value` 失败、**一个坏字段陪葬一整节**。改为 `recover_section::<T>`：把候选对象**逐字段**喂给 `T` 的 serde 反序列化，坏的丢、好的留。
4. **主题 = `color-scheme`**。本项目配色建立在 CSS 系统色（`Canvas` / `CanvasText` / `ButtonFace` …）之上，故切主题只需切 `color-scheme`（`dark` / `light` / `light dark`），无需维护第二套颜色变量。
5. **外观改动走 CodeMirror `Compartment` 原地重配**（行号 / 自动换行 / 缩进），保留撤销历史与滚动位置；字体 / 字号通过 `.cm-content` 的 CSS 变量（`--editor-font-family` / `--editor-font-size`）下发，比较模式多窗格共用同一变量。
6. **「设置入口不能被设置关掉」**：工具栏开关会隐藏工具栏，而设置菜单就在工具栏里——一旦关掉就再也打不开。此项单列为 E2E 断言。
7. **规范化顺序固定**：修饰键按 `ctrl → alt → shift → meta` 重排，`Shift+Ctrl+S` 与 `Ctrl+Shift+S` 才会归一到同一绑定。`mod` / `cmdOrCtrl` 占位符**先落成 `meta`、再参与重排**，故 `cmdOrCtrl+Shift+S` 解析为 `shift+meta+s`（顺序与用户书写无关）。裸空白（`"ctrl+ "`）在配置里不接受（空格固定写 `space`），事件路径不受影响。
8. **规格 §11.2 的 `tauri-plugin-global-shortcut` 未采用**：那是**系统级全局热键**（应用不在前台也触发），与「应用内命令快捷键」是两回事。本阶段实现的是应用内**命令分发器**（键位 → 命令 id → handler）；与系统冲突的检测按「确实拿不到的组合」列出（`Alt+F4` / `Alt+Tab` / macOS 的 ⌘Q 等）。
9. **命名偏差**：规格 §11.1 的比较默认档位字段叫 `defaultStrictness`，这里随 F-06 的既有契约用 `variantStrictness`（直接复用 `CompareOptions`，让「设默认值」与「比较对话框初值」天然同一份结构）。

### 待后续阶段

- 第九阶段：稳定性 + 收口（错误信息统一 + 前端 Toast、启动 < 1.5s、单实例、文档）
- F-11 §11.3 自定义工具栏（v1.1）：把整理工具 16 个未分配键位的命令统一接线
- 设置项联动补齐：`editor.defaultEncoding` / `defaultLineEnding`、`conversion.*`、`compare.*` 目前**已持久化**，但尚未全部接到相应对话框的初始值

---

## 开发日志 009 — 2026-10-15（第九阶段：稳定性 + 收口，全部完成）

### 已交付

| 主题 | 内容 |
|------|------|
| **统一 Toast 通知** | `store/toastStore.ts`（队列 + 四级别 + 自动消失，纯状态层可单测）+ `components/ToastHost.tsx`（右下角堆叠，挂在 `App` 根部、`z-index` 高于对话框遮罩）；替换掉第八阶段之前的**两个单槽横幅**（`error` / `notice`：同一时刻只能有一条，后一条直接顶掉前一条）。为不动几十处调用点，保留 `setError` / `setNotice` 两个旧接口形状（空值 = 不提示），并改为**模块级**函数（不依赖组件状态，也就不必让各处 `useCallback` 依赖数组都去列它们） |
| **会话与未保存恢复** | `core/session.rs`（纯算法核心）+ `commands/session.rs`（`session_load` **永不失败** / `session_save` 回执实际落盘值 / `session_clear`）+ 前端启动恢复与 300ms 防抖落盘；`tabsStore.restoreSession` 负责装载并把 id 计数器推到已有 id 之后 |
| **单实例** | 接入 `tauri-plugin-single-instance`（必须**第一个**注册）：第二次启动聚焦已有窗口，而不是再开一个进程 |
| **启动性能可观测** | `StartupMetrics { setupMs, debugBuild }` + `startup_metrics` 命令：把「启动 < 1.5s」从口号变成可断言的数字（口径 = `run()` → `setup` 完成，**不含前端加载**） |
| **内置帮助页** | `components/HelpDialog.tsx`：顶栏「帮助」/ `F1`（新增 `help.open` 命令）；快捷键一览**直接由 `COMMANDS` + 当前绑定渲染**（不抄写死的表，用户改绑后帮助页仍说实话）；「关于」显示版本（`app_version` 命令，版本号唯一出处是 `Cargo.toml`） |
| **文档收口** | README 修正（转换方向 17 → **14**，与 `Direction` 枚举一致）；补充会话恢复 / 完全离线 / 版本号出处三节 |

### 验证（真实运行，非仅单测）

- **Rust**：`cargo fmt --check` ✓、`cargo clippy --all-targets` ✓（0 警告）、单测 **187/187** ✓（新增 `core::session` 14 项：默认值 / 原子写不留 `.tmp` / 紧凑 JSON / 坏文件留 `.bad` / **单个坏标签不牵连其余** / 光标钳制 / 未知行尾回落 / 空 id 丢弃 / 活动标签回落 / 幂等清除 / 自动建目录）、契约集成 **47/47** ✓（stage3 5 + stage4 8 + stage5 7 + stage6 5 + stage7 5 + stage8 7 + **stage9 10**）
- **前端**：vitest **113/113** ✓（新增 `toastStore.test` 10 项：空消息不入队 / 级别默认时长 / 堆叠 / 超限丢最旧 / 手动关闭 / 清空 / 便捷入口）、ESLint ✓、`tsc -b && vite build` ✓
- **真实 UI 端到端**（WebView2 CDP + Playwright，**32/32 通过**）：
  - 启动即编辑：没有会话文件时恰好一个空标签，没有欢迎页
  - 启动指标：前端读到 `{ setupMs, debugBuild }`，并断言在预算内
  - Toast：出现 / 手动关闭 / 自动消失（约 4.6s）/ **两条可同时在屏**（旧横幅会互相顶掉）
  - 未保存恢复：写正文 → 落盘（`dirty = true`，正文进 `session.json`）→ 重载后原样回来
  - 已保存标签：`content = null` 只存路径，启动时**从磁盘重读**
  - 多标签与活动标签恢复（正文与标签栏高亮都指向第二个）
  - 恢复之后还能继续新建标签（id 计数器已推到已有 id 之后）
  - 帮助页：顶栏入口与 `F1` 都能打开、列出命令与当前键位、带版本号、`Esc` 关闭
- **回归**：第八阶段 E2E 仍 **51/51** 通过

### 关键决策与发现

1. **会话「正文按需保存」**。会话里每个标签都记 id / 路径 / 编码 / 行尾 / 光标，但正文只在**磁盘上还原不出来**时才写进 `session.json`（`dirty` 或从未保存过）。于是「打开十个大文件、一个字没改」的会话只有几 KB，而「改了一半没保存」的一个字都不会丢；已保存的标签启动时从磁盘重读——文件可能已被外部改动，以磁盘为准。
2. **会话永不因为文件坏掉而挡住启动**：整份解析失败就**逐标签**恢复（坏的丢、好的留），原文件留 `.bad`。于是 `session_load` 可以「永不失败」，前端不必写兜底。
3. **`sessionReady` 闸门**：恢复完成前**禁止回写**。否则启动瞬间会拿空的 store 覆盖磁盘上的会话——等于把用户的会话清空。
4. **`async` 命令 + `State<'_>` 编译不过**：`startup_metrics` 最初写成 `async fn`，`State` 的借用活不过 `Future + 'static`。它是纯内存读，改**同步命令**即可——不必为了「和别的命令一致」硬套 `async`。
5. **「启动 < 1.5s」必须区分构建类型**：同一台机器上 dev 构建实测 `setupMs ≈ 1500ms`（未优化 + 更大二进制 + WebView2 冷启动），发布构建才会显著更低。故指标里带上 `debugBuild`，自动化按构建类型选阈值（dev 2000ms / release 1500ms）——否则要么把 dev 的正常值判成失败，要么把发布版的退化放过去。
6. **帮助页不抄写死的快捷键表**：直接渲染 `COMMANDS` + 当前绑定。否则用户一改绑，帮助页就开始说谎（写死的表还会漏掉「未绑定」这种真实状态）。
7. **单实例回调只做聚焦**：`argv` / `cwd`（用启动参数打开文件）先忽略，留给后续；不做半成品。
8. **Toast 改造顺手统一了冲突提示的级别**：快捷键冲突原本走普通提示（绿色），现改为 `warn`——它是「需要注意但不阻断」的情形，配色该和成功提示区分开。

### 待后续阶段

- 第十阶段：打包发布（`npm run tauri:build` 三平台出包、`packaging.test.ts` 阈值检查、GitHub Actions tag 触发 release、冒烟脚本）
- 设置项联动补齐：`editor.defaultEncoding` / `defaultLineEnding`、`conversion.*`、`compare.*` 已持久化但尚未接到相应对话框初值
- F-11 §11.3 自定义工具栏（v1.1）
- 会话的边界行为（如关闭全部标签后是否顺带清空会话）可按使用反馈细化

---

## 开发日志 010 — 2026-10-15（第十阶段：构建与发布，全部完成）

### 已交付

| 主题 | 内容 |
|------|------|
| **三平台各一个安装文件** | 基线 `bundle.targets: "all"` 在 Windows 上会同时产出 MSI + NSIS（两个安装文件）。改为三份平台配置显式收窄：`tauri.windows.conf.json` → `["nsis"]`、`tauri.macos.conf.json` → `["dmg"]`、`tauri.linux.conf.json` → `["appimage"]`（Tauri 2 自动合并平台配置）。Windows 侧 `installMode: currentUser`：装到用户目录、不弹提权 |
| **Windows 不依赖任何预装运行时** | `dumpbin /dependents` 实测：改造前唯一的非系统依赖是 `MSVCP140.dll`（OpenCC 的 C++ 侧按 `/MD` 编译）。改成**两侧静态 CRT** 后消失——`.cargo/config.toml` 里 `+crt-static`（rustc 侧；少了它，C++ 静态产物需要的 `libcmt` 符号在动态链接下无处可寻 → LNK2019）+ `_CL_=/MT`（`cl.exe` 把该变量里的选项**追加到命令行末尾**，从而覆盖 CMake 写死的 `/MD`）。`opencc-sys` 是 registry 依赖、改不了它的 build.rs，`cmake` crate 自己也不会从 `CARGO_CFG_TARGET_FEATURE` 推断 `crt-static`（只有 `cc` crate 会），所以只能从编译器环境这一层兜住。改造后导入表只剩 Windows 自带 DLL 与 `api-ms-win-crt-*`（UCRT，从 Windows 10 起属于系统组件） |
| **WebView2 用官方引导程序** | `embedBootstrapper`（约 1.8MB 随包走）：已有 WebView2 的机器（Windows 11 全部、打过补丁的 Win10）拿来就用，缺失时才联网下载一次 |
| **图标全套** | `scripts/gen-app-icon.ps1` 生成 1024 母版 → `tauri icon` 产出全套（含 macOS `icon.icns`、Windows `icon.ico` 与 Store logos）——`.icns` 是多种尺寸的容器格式，手搓不值当 |
| **冒烟脚本** | `scripts/smoke.mjs`：**零依赖** CDP 客户端（Node 内置 `fetch` + 全局 `WebSocket`，不引 playwright，CI 少一步下载浏览器）。启动**打包产物** → 等界面挂载 → 断言标题 / 编辑器 / 标签栏 / 帮助入口 / 启动指标 / 无运行时错误，并**真跑一次简繁转换** |
| **打包契约测试** | `tests/packaging.test.ts`（20 项）：三平台单安装文件、静态 CRT 两个开关、**PE 导入表白名单**、版本号唯一出处、完全离线（无 updater + 最小能力）、资源与图标齐全、体积预算（16MB / 12MB / 1.5MB） |
| **CI 三平台出包** | `.github/workflows/release.yml`：tag `v*` 触发 Windows / macOS（通用包）/ Linux 三条 runner，校验 tag 与版本号一致 → 出包 → Windows 冒烟 → 上传 artifacts → 创建 draft Release |

### 验证（真实运行，非仅单测）

- **出包**：`AioTextEditor_0.1.0_x64-setup.exe` **4.43 MiB**（NSIS，`currentUser`，免提权）。
- **装完即用（本机实测）**：静默安装 `/S` → `%LOCALAPPDATA%\AioTextEditor\` 落地 `aiotext-editor.exe`（7.5MB）+ `uninstall.exe` + `data/legacy`、`data/builtin-tables`；**目录里没有任何运行库 DLL**（不像很多安装包要拖一串 `msvcp140.dll`）。对**已安装**的程序跑冒烟 **10/10 通过**，启动 **614ms**。
- **导入表**：`dumpbin /dependents` 确认无 `MSVCP140.dll` / `VCRUNTIME140.dll`。
- **冒烟**：对 `target/release` 直接跑 **10/10**（启动 **623ms**）、对已安装副本 **10/10**（614ms）；两项都在第九阶段 1500ms 验收线内。转换断言实测：`汉字软件测试` → `漢字軟件測試`（4 字变更）、`漢字軟體測試` → `汉字软体测试`。
- **前端**：ESLint ✓、`tsc -b && vite build` ✓、vitest **133/133** ✓（新增 `packaging.test.ts` 20 项；因产物已存在，PE 导入表与体积预算两项**实际执行**而非跳过）。
- **Rust**：单测 **187/187** + 契约 **47/47**（合计 234 项，0 失败）。静态 CRT 改了 rustflags，debug 缓存全量重编后复跑；Rust 源码本身未改动，改的只是链接方式。

### 关键决策与发现

1. **「不依赖系统文件」要盯最终二进制的导入表，不是构建脚本**。所以 `packaging.test.ts` 自己解析 PE 的导入目录，断言「没有 `msvcp*` / `vcruntime*`」并给系统 DLL 列白名单——出现未知依赖就红，逼人做一次有意识的决定（是系统组件？加白名单；是第三方？想办法去掉）。
2. **两侧静态 CRT 缺一不可**。只开 `+crt-static`：CMake 仍按 `/MD` 编 OpenCC，`MSVCP140.dll` 照样回来。只开 `_CL_=/MT`：C++ 产物要 `libcmt` 的符号，而 rustc 仍按动态 CRT 链接 → LNK2019。两条各自都不自洽。
3. **`_CL_` 是绕开 registry 依赖的唯一支点**。要改 `opencc-sys` 的 CMake 参数，正常做法是 vendor 整个 crate 再 patch——为此把库源码抄进仓库太重。`cl.exe` 会读取 `_CL_` 环境变量并把其中的选项追加到命令行**末尾**，优先级天然高于 CMake 生成的 `/MD`；而 Cargo 的 `[env]` 正好能把这个变量交给所有构建脚本及其子进程。`_CL_` 只影响编译（链接读的是 `LINK` / `_LINK_`），所以不会干扰 rustc 的链接步骤。
4. **安装包体积与「零前提」不可兼得，已明确取舍**。内嵌 WebView2 离线安装器能把安装包做到零前提零联网，代价是 +127MB（4.43MB → 约 150MB），突破 PRD §六 的 16MB 验收线。取「保体积线 + 官方引导程序」，并把另选的开关与代价写进配置注释、测试注释与文档三处。
5. **冒烟必须等界面挂载**。第一版探针在 CDP 一连上就查 DOM，拿到「标题已对、React 未挂载」的中间态（`.cm-content` 不存在、标签栏 0 个、启动指标 `null`），报出 4 项假失败。改成先轮询 `.cm-content`（最长 15s）再断言，10/10 通过。**假失败比没测更糟**——它会让人开始不信任测试。
6. **冒烟里那次简繁转换不是凑数**：既存笔记记录过「旧版 `msvcp140.dll` 让 OpenCC 词典加载访问违例」（见技术架构 §10.1），而我们刚改了链接方式。只断言「窗口打开了」不足以覆盖它，所以每次都真跑一次 `convert_opencc`。
7. **macOS / Linux 的包只能由 CI 产出**。`.dmg` 需要 macOS SDK 与 `codesign`，AppImage 需要 webkit2gtk 与 linuxdeploy，Windows 上都交叉不了——本机验证 Windows，另两平台留给 `release.yml` 首跑。macOS 现为 ad-hoc 签名（任何 Mac 都能打开，浏览器下载后首次打开需右键放行一次），免掉这一步需要 Apple Developer 证书，Secrets 清单已写在 `release.yml` 末尾注释里。

### 待后续阶段

- ~~**CI 首跑**：macOS 通用包与 Linux AppImage 尚未在真实 runner 上验证过~~ —— **已在 v0.9.0 发布时兑现**：macOS 通用包 6.85 MB 出包成功，Linux 改为 deb 后 4.00 MB 也出包成功（见开发日志 011）。
- 若拿到 Apple Developer 证书：接上签名与公证，去掉首次打开的右键放行步骤。
- F-11 §11.3 自定义工具栏（v1.1）、打印、自动分段（v1.1）。
- 会话的边界行为（关掉全部标签后是否顺带清空会话）可按使用反馈细化。

---

## 开发日志 011 — 2026-10-19（v0.9.0 发布：三平台出包 + CI 修绿，全部完成）

### 已交付

| 主题 | 内容 |
|------|------|
| **Linux 安装包 AppImage → deb** | `tauri.linux.conf.json` 的 `bundle.targets` → `["deb"]`，`release.yml` 的 Linux artifact → `bundle/deb/*.deb`，`tests/packaging.test.ts` 的 Linux 断言同步（这条不改会让**三平台**的前端单测一起红）。deb 由 Tauri 直接产出；AppImage 要额外下载 linuxdeploy 及其插件，首版三平台发布就挂在它上面 |
| **CI 三平台修绿 6/6** | 前端（lint + test + build）与 Rust（fmt + check + test）在 windows / macos / ubuntu 上全部通过 |
| **CI 诊断层** | 日志正文要登录 GitHub 才看得到、接口也要 token。故在失败步骤后把关键错误行写成 `::error::` **annotation**（公开可读）。这一层是下面三个真因能被定位的前提 |
| **macOS 键位测试去平台耦合** | `mod()` 拼出的键位按 `MODIFIER_ORDER`（ctrl→alt→shift→meta）排好；`shortcuts.test.ts` 不再写死 `ctrl+n` / `ctrl+s`，改从注册表取当前平台的默认键 |
| **merge 测试按平台分隔符构造** | `Path::file_name()` 的分隔符是平台相关的，测试里写死的 `C:\dir\1_2.txt` 在 Linux / macOS 上必然红。改用 `std::path::MAIN_SEPARATOR` 现场构造 |
| **Windows 冒烟从 CI 移除** | GitHub Runner 没有交互式桌面会话，WebView2 建不了窗 —— 那条检查在 CI 上**不可能通过**（本机正常通过）。脚本 `scripts/smoke.mjs` 保留，验证产物这件事回到有桌面的机器上 |
| **Actions 升级到 Node 24 运行时** | `checkout` v4→v7、`setup-node` v4→v7、`upload-artifact` v4→v7、`download-artifact` v4→v8、`softprops/action-gh-release` v2→v3（v3 的变更只有「runtime 从 Node 20 迁到 Node 24」，无 input 破坏） |
| **文档同步** | README 新增「获取安装包」一节（三个包 + `dpkg -i` 装法）；README / PRD / `03-tech-architecture` / `05-roadmap` 里的 AppImage 表述同步为 deb，并记下改格式的理由 |

### 验证（真实运行，非仅单测）

- **Release workflow 三平台出包**（tag `v0.9.0` → `436db8a`）：`AioTextEditor_0.9.0_x64-setup.exe` **4.45 MB**、`.dmg`（Intel + Apple Silicon 通用）**6.85 MB**、`.deb` **4.00 MB**；三个 job 与「发布」job 全部 success，draft Release 已生成。
- **deb 在真实 Linux 上装过**：WSL Debian 13 里本地构建（4.06 MB）→ `dpkg -i` 装上 → `ldd` 无缺失动态库 → 二进制真的启动到 WebView 初始化（无显示器，故只见 `MESA-EGL` 提示）→ 随包 `data/legacy`（fc1/fc2）与 `data/builtin-tables` 齐全。
- **本机**：前端 `vitest` 156/156、Rust 单测 249、`cargo fmt` / `tsc -b` / `eslint` 全干净。
- **macOS 路径的验证方式**：本机是 Windows，故临时把 `IS_MAC` 写成 `true` 跑一遍前端单测再还原 —— 真实 macOS 上 `isMacPlatform()` 与模块判断一致，那条假失败不是缺陷。

### 关键决策与发现

1. **「看不到日志」要先解决，否则只能猜**。GitHub Actions 的日志正文要登录才看得到，API 取日志也要 token，而 annotation 是公开可读的 —— 给 `ci.yml` / `release.yml` 加诊断层之后，三个真因一次跑完就全浮出来了。**修 CI 之前先修「能不能看见」**，这是这轮最重要的一条。
2. **LLVM 18 的 libclang 依赖 `libtinfo.so.5`，ubuntu runner 上只有 `.so.6`** → libclang 打不开 → `opencc-sys` 的 bindgen panic。故 Linux 不用 `kylemayes/install-llvm-action`，改发行版自带的 `libclang-dev`（`llvm-config` 不存在时用 `find` 兜底）。
3. **装依赖与配变量有先后**：`libclang-dev` 必须先装，下面「配置 `LIBCLANG_PATH`」才问得到位置。顺序反了变量会落空，bindgen 报 `invalid: []`（连试都没意义的路径）。
4. **写死平台的东西只会在别的平台上红**：Windows 路径分隔符（发现 2）、`ctrl+n`/`ctrl+s` 默认键（发现 3）都是同一类。测试要断言行为，就别把平台相关的常量抄进期望值。
5. **键位必须是规范形式**。`MODIFIER_ORDER` 里 `meta` 排在 `shift` 之后，所以 macOS 上是 `shift+meta+s` 而不是 `meta+shift+s`。注册表里若出现「写得出来却解析不回自身」的键位，自定义覆盖会静默失效 —— 现在由 `mod()` 统一排序。
6. **改打包格式会牵动打包契约测试**。改 deb 之后三平台前端单测全红，就是 `packaging.test.ts` 那条断言 —— 这是我自己引入的 regression，本地 `npm test` 一眼抓到。**格式类的改动不存在「只影响一个平台」**。
7. **产物落在项目根目录的 `target/release/bundle/deb/`**，不是 `src-tauri/target/`（Windows 的 NSIS 同理）。`release.yml` 的 artifact 路径按此写。
8. **Windows 冒烟在 CI 上必然失败**，且它排在 artifact 上传之前 —— 一失败会把上传判成 skipped，变成「包明明打出来了却没传上去」。先加 `continue-on-error` 兜住，最终移除。

### 待后续阶段

- **v0.9.0 的 draft Release 待 Publish**（草稿状态下对外不可见，`releases/latest` 取不到）。
- `upload-artifact` v7 / `download-artifact` v8 / `gh-release` v3 只在 tag 发版时才真正执行 —— 本次 CI 跑不到它们，v0.9.1 首跑时留意一眼「发布」job。
- 若拿到 Apple Developer 证书：接上签名与公证，去掉首次打开的右键放行步骤（Secrets 清单已写在 `release.yml` 末尾注释里）。
- F-11 §11.3 自定义工具栏（v1.1）、打印、自动分段（v1.1）。

---

## 开发日志 012 — 2026-10-20（比较模式目标窗 + 差异标红 + 查找框预填）

### 已交付

| 主题 | 内容 |
|------|------|
| **目标窗 / 对照窗** | 比较模式下鼠标点哪格、哪格就是目标窗（浅蓝外框、可编辑），另一格自动转对照（只读）。激活标签跟着切 |
| **差异标红** | 目标窗**缺**的字标在对照窗（下划线，提示补进去），**多出**的字标在目标窗（删除线，提示删掉），位置对齐但字不同的两边都标 |
| **查找框预填** | 先选中文字再按 Ctrl+F / Ctrl+H，选中的文字直接进查找框并自动查一次；跨行 / 跨段转 `\n` 并切正则，超 600 字不填 |
| **文档** | README 与规格 §6.2 的「双栏 / 三栏 diff」改为实际口径；规格新增 §6.7（目标窗切换）与 §5.6（选区预填） |

### 验证（真实运行，非仅单测）

- 前端单测 **171/171**（新增 15 条：`compareView` 的方向映射 6 条、`findText` 的转义 7 条）。
- `tsc -b`、`eslint --max-warnings 0` 均干净。

### 关键决策与发现

1. **激活标签跟着目标窗走，是因为保存会骗人**。在 B 窗改完按 Ctrl+S，若激活标签还在 A，存的是 A 那个文件 —— 改动凭空消失。这不只是「标签栏高亮对不对得上」的观感问题。
2. **代价是渲染来源不能再由 `activeTabId` 推**。原来 A 窗 = `activeTab`，一旦切了激活标签，A 窗就会渲染成 B 的内容。所以两侧标签各自存 id（`aTabId` / `bTabId`），这是切窗能落地的前置改动。
3. **只读不能挂载时定死**。`EditorState.readOnly` / `EditorView.editable` 是状态级配置，必须用 **Compartment** 原地翻转（沿用行号、自动换行那三项的既有做法）—— 重建 EditorState 会丢撤销历史与滚动位置，比较模式下两格都会明显跳。
4. **标红标在哪一格最容易搞反**：目标窗**缺**的字要标在**对方**那一格（不然用户看不到少了什么）。抽成 `shared/compareView.ts` 的纯函数并单测锁住 —— 界面上搞反了看着也照样能转。
5. **跨行选区必须切正则**：单行输入框塞不下真实换行，后端认的是 `\n`。「转义结果与原文不同」正好可以当作「要不要切正则模式」的判据，不必另设标志。
6. **差异跳转与查找定位原本共用 `pendingSelection`，必须分开**。目标窗切到 B 后，在 B 里查找会把 A 窗也带跑（两个窗格接的是同一份请求）—— A 侧另立 `compareSelectionA`；同时 `pendingEdit` / `commandRequest` / `highlights` 按目标窗分发，避免写进只读的那一格。
7. **RangeSet 让「标全部」与「大文件不卡」兼得**：分块稀疏结构，只有视口内的装饰才真正绘制；数量上限由后端截断（5000 处）兜住。
8. **术语分两层**：对话框说「A 侧 / B 侧」（比较的两侧，固定不变），进入后说「目标窗 / 对照窗」（当前角色，会随切换易位）。差异数据里的 `posA` / `posB` 始终指两侧，只在显示时翻译成角色名。

### 待后续阶段

- 三栏平铺与「同步滚动」（v1.1）。
- **50 MB × 2 的标红尚未实测**：类型与单测都过了，但大文本下的真实滚动表现只由 RangeSet 的性质推断，未跑过。
- 目标窗切换时若两窗都在编辑器撤销栈上有历史，跨窗撤销的边界行为可按使用反馈再定。
- F-11 §11.3 自定义工具栏（v1.1）、打印、自动分段（v1.1）。

---

## 开发日志 013 — 2026-10-20（标红另走一套口径；查找 / 替换框按焦点回填）

### 已交付

| 主题 | 内容 |
|------|------|
| **标红只标真正的差异** | 新增 `compare_diff`（**最小编辑脚本**，LCS 回溯）专供标红；F5 跳差异仍走原来的逐字口径，**一行未动** |
| **标红样式** | 去掉下划线 / 删除线，两侧统一为红字 + 淡红底 —— 落在哪一格已经说明它是该补进去还是该删掉 |
| **查找 / 替换框按焦点回填** | 鼠标最后点过哪个框，正文里选中的文字就补进哪个框；查找框填了自动查一次，**替换框只接住文字**，绝不替用户执行替换 |

### 验证（真实运行，非仅单测）

- Rust 单测 **260/260**（新增 `core::text_diff` 11 条），`cargo fmt --check` 干净；前端单测 **172/172**，`tsc -b` 与 `eslint --max-warnings 0` 干净。
- **CDP 真机 · 标红**：`汉字软件 / 汉字兔软件` 这组之前会把「软件」也染红，现在**只有 B 窗的「兔」是红的**，`text-decoration` 为 `none`；点 B 格之后，同一段红的类名从 `cm-diff-missing` 翻到 `cm-diff-extra`，A 窗始终一个字都不标。
- **CDP 真机 · 输入框回填**（同一次运行）：焦点在替换框时选中「汉字」→ 替换框收到「汉字」，**查找框分毫未动**；再点进查找框选中「兔」→ 只有查找框变，替换框保留「汉字」。

### 关键决策与发现

1. **「差异之后所有字都被标红」不是 CSS 的问题，是算法的属性**。用户报告后，脚本把标红的文字 dump 出来才确认：`汉字软件 / 汉字兔软件` 会把「软件」也染红 —— 逐字口径在失配处**两侧各进一步**，之后一路错位。改不动前端，只能另开一条路。
2. **两套口径并存，而不是整体改成 diff**（用户选的）：F5 校对的口子本来就是 TextPro 那个；整体改要重写 §6.2 行为描述、`CompareEnd` 语义与大批 Rust 单测。并存的代价是**界面上「N 处不一致」与标红的条目数不相等**，已在 §6.8 写明。
3. **LCS 用空间换精确**：`compare` 是惰性流、O(1) 内存；LCS 必须整体持有字符。故设了阈值 `MAX_DIFF_CHARS`，超出就退回逐字口径并标 `approximate` —— **宁可这一标得粗糙，也不能让 50 MB 的文本把内存吃掉**。
4. **「程序跳转的选中」必须和用户的选择区分开**。查找下一个 / 跳差异都会选中一段；若不辨来源，用户刚敲好的替换词会被跳过去的那个词顶掉。现在 `Editor` 用 `Annotation` 给每一笔选区标明来源，面板据此决定要不要回填。
5. **标红落在哪一格由「谁多出了字」决定**：`delete` 段永远标 A、`insert` 段永远标 B；变的只是称谓（目标窗多了 / 缺了），所以切换目标窗时同一段红的 kind 会翻面。这条最容易搞反，已用单测锁住。
6. 前后缀裁剪先跑一遍再进 DP：绝大多数文本只在中间几处不同，DP 规模因此能小一个数量级。

### 待后续阶段

- 超大文本（超出 `MAX_DIFF_CHARS`）的标红仍是逐字口径 —— 想要精确又省内存，以后可以走「先按行对齐、再对失配行做字符级」的分块策略。
- 两个口径的计数不一致：若觉得别扭，可以把 `CompareBar` 的计数也换成 diff 口径（届时 F5 的定位序列要一起改）。
- 三栏平铺与「同步滚动」（v1.1）。
- F-11 §11.3 自定义工具栏（v1.1）、打印、自动分段（v1.1）。

---


---

## 开发日志 014 — 2026-10-20（比较统一到 diff 口径：删除逐字那套）
### 已交付
| 主题 | 内容 |
|------|------|
| **一个口径** | 删掉 `compare_texts` 命令与 `core::compare::compare()`（TextPro 式同步逐字）：差异计数、F5 跳差异、标红现在同吃 `compare_diff` 一份结果，**工具条上的「N 处」与标红的处数必然相等** |
| **三级漏斗** | `core::text_diff`：裁公共前后缀 → 够小则 DP（精确最优）→ 有换行则按行 Myers → 无换行两侧等长则逐位线性扫 → 兜不住就 `degraded`，不再退回另一套算法 |
| **一处怎么算** | 相邻的一「缺」一「多」并成一处：换掉一个字算一处 |
| **工具条统计** | 「X 窗先到尾部，还剩 N 字」改成「第 i/N 处 · 共 N 处 · 新增 X 字 · 缺失 Y 字」（语义参考 DiffChecker 的统计栏，MIT） |

### 验证（真实运行，非仅单测）
- Rust 单测 **209/209** + 第六阶段契约 **5/5**；`cargo fmt` / `cargo build` 干净。
- **50 MB 两条用例都跑得动**：有换行的一条走「按行 Myers」，无换行等长的一条走「逐位比较」—— 原先这条能力由逐字提供，现在由漏斗自己接管。
- 前端单测 **180/180**（新增 8 条：`diffStats` 4 条、`previewText` 3 条、UI 口径 1 条）；`tsc -b` / `eslint` 干净。
- **参考对象实测**：DiffChecker 的行级 LCS 在 4000 行就要 2.1 秒 / 1.6 GB 堆（行数翻倍内存涨 4 倍），外推到本节 50 MB 的规模约 **5.8 小时 / 16 TB** —— 只参考它的统计呈现，算法一行未抄。

### 关键决策与发现
1. **删掉逐字之后，50 MB 是唯一的硬门槛**。先把「按行 Myers」与「等长逐位」两层补齐，能力才敢说由 diff 接管 —— 否则大文本只会 OOM，而不是「标得粗糙」。
2. **那条老的大文件用例踩中了出题习惯**：同一句话重复 100 万次、中间没有换行，按行锚点对它无效；好在它两侧等长，正是「逐位比较」那层的适用形状。故又新增一条**带换行**的 50 MB 用例，两层的覆盖才有据可查。
3. **重复行会让位置产生歧义**。两万行内容全相同时，「多出来 / 少掉的是哪一行」有多个编辑距离相同的答案 —— 这是 diff 的固有特性，不是 bug。测试里给每行带上行号避开它，并把理由写进了注释。
4. **行锚点层有个真实的取下溢**：前后缀裁剪之后头尾是「半行」，失配块可以只有一侧有行，`la[i - 1]` 直接崩 —— 这是单测逮到的，不是推算出来的。
5. **「相邻一对」的合并必须限定范围**。最初写成「一路吃到下一个相同处」，结果全异的长文本被整段吞成一处；改成一次只配一对（先看眼前这一串是什么，再配它的另一半）。编辑脚本里删除与插入的先后不固定，两种顺序都得认。
6. **`degraded` 不许藏着**。这也是与 DiffChecker 最大的不同：算不准就在工具条写明，而不是拿着近似的答案给一个看起来正常的数字。

### 待后续阶段
- 没有换行、长度又不等的超大文本仍会 `degraded`：需要时可按 n-gram 锚点（patience 思路）再补一层。
- 三栏平铺与「同步滚动」（v1.1）。
- F-11 §11.3 自定义工具栏（v1.1）、打印、自动分段（v1.1）。
---

## 开发日志 015 — 2026-10-20（逐字对照标蓝、排版选项与规则、打开提速）

### 已交付
| 主题 | 内容 |
|------|------|
| **逐字对照标蓝** | 比较模式下选中一侧的字，两侧**对应的位置**一起标蓝。对应位置由 diff 的分段映射在前端推算：相同部分按偏移差精确对应，差异块内标整块 —— 零 IPC；切到另一窗选中同理 |
| **网文排版** | 段首缩进默认 2 → **0**（稿件多半已经带着缩进，补一遍就成双份） |
| **中文文案** | 新增「段首缩进」（数字框，默认 2，与网文正好相反）；三条空格规则各有独立开关：单位补空格、数学符号、半角括号 |
| **打开提速** | 30 MB 文件 **1.34s → 0.19s**（debug），7.2 倍 |

### 性能实测（发布构建，30 MB 样本）
| 动作 | 耗时 |
|------|------|
| 打开 | **116 ms** |
| 比较（三处改动） | **622 ms** |

打开那 7.2 倍来自四处：
1. UTF-8 直接把字节块转成 String —— 省掉 `decode` 的一次全量分配与拷贝；
2. 行尾判断从三趟 `matches()` 合成一趟；
3. 行尾归一改成**原地**：没有 CR 时一个字节都不动（原先两次 `replace` 会产出两份中间 String）；
4. `fs_read` / `fs_read_with` / `fs_write` / `fs_check_mappable` 补上 `spawn_blocking` —— 项目里其它重活早都这么做了，唯独文件 I/O 漏了。

### 关键取舍
1. **差异块内标整块，不逐字硬拉**。A 三字对 B 一字时逐字对应本就无从谈起，标整块比乱指一个字诚实。
2. **半角括号的判据收得很紧**：只认「中文紧挨着括号」与「英文 + 全大写缩写」（`Decision Tree(DT)`）。小写的一律不动 —— `foo(bar)` 是函数调用，给它加空格反而错了；URL 与行内代码整体跳过。
3. **连字符 `-` 一律不管**：日期、连字符、负号三种身份挤在一个字符上；`<` `>` `*` `/` 同理（HTML / Markdown / 路径会撞）。数学符号只取 `+ = × ÷ ≈ ≠ ±`。
4. **没有去动 diff 的结构**。比较 30 MB 在发布构建下 622 ms，而「跳过全量 Item 构造、直接走行级」要重写位置换算与递归 —— 收益没大到值得冒那个险（上一轮刚在 myers 上翻过车）。
5. **顺手修了单位表一个真 bug**：表里存的是大写 `GB`，比对的却是折成小写的文本，所以 `10GB` 一直匹配不上；改为全小写 + 最长匹配（`10mbps` 也不会再被 `mb` 截走）。度与百分号改为**显式排除**，免得日后往表里加个 `c` 就误伤 `37°C`。

### 验证
- Rust **217 项** + 各阶段契约全绿（新增 4 条排版用例）；`cargo fmt` 干净。
- 前端 **185/185**（新增 5 条映射用例）；`tsc` / `eslint` / `npm run build` 均通过。
- 打开与比较的耗时是**实测**得来的（临时基准，测完已删），不是估算。
---

## v0.10.0 — 2026-10-20（发布）

由 tag `v0.10.0` 触发 Release workflow 三平台出包：
Windows `AioTextEditor_0.10.0_x64-setup.exe`、
macOS `AioTextEditor_0.10.0_universal.dmg`、
Linux `AioTextEditor_0.10.0_amd64.deb`。

相对 v0.9.0 的变化：

**新增**
- **逐字对照标蓝**：比较模式下选中一侧的字，两侧**对应的位置**一起标蓝 —— 相同部分
  按偏移差精确对应，差异块内标整块。切到另一窗选中同理。
- **中文文案**：新增「段首缩进」（默认 2）；三条空格规则各有独立开关 ——
  数字与单位（° 与 % 不加空格）、数学符号、半角括号。

**变更**
- 网文排版「段首缩进」默认 **2 → 0**（稿件多半已带缩进，补一遍就成双份）。
- 比较统一到 diff 口径，旧的「逐字模式」实现移除。

**性能**
- 打开 30 MB 文件 **1.34s → 0.19s**（debug）；发布构建实测：打开 **116 ms**、
  比较 **622 ms**（1176 万字符 / 三处改动）。
- 比较算法：内存预算 512 MB、`Item` 瘦身、两串逐字相同直接短路。
---

## 开发日志 016 — 2026-10-20（港澳台引号规则无效）

**问题**：排版 → 规范标点 → 引号体系 → 选「港澳台」，文本一个字都不变。

**根因**：`pair_quotes` 只认半角直引号 `"` `'`。中文稿件里输入法打出来的、
从 Word 粘过来的几乎都是全角 `“”` —— 这一档在这些文本上完全不动，用户看到
的就是「这个选项没用」。

**修法**（依据台湾教育部《重訂標點符號手冊》修訂版）：
- 「港澳台」把**全角引号**一起换过来：`“”` → `「」`、`‘’` → `『』`。
- 手册原文：「引號分單引號及雙引號，通常先用單引號，如果有需要，單引號內再用
  雙引號，依此類推。」台湾的「单引号」是 `「」`（**外层**）、「双引号」是
  `『』`（**内层**）—— 与大陆恰好相反。所以 `“”`（大陆外层）→ `「」`、
  `‘’`（大陆内层）→ `『』`，嵌套也自然对上：`“她说‘你好’”` → `「她说『你好』」`。
- 修订说明里另有一句佐证：「橫式『引號』改為 `「」『』`」。

**大陆那一档一字未动**（按要求保持现状）：仍只把半角直引号配成对，
不碰任何已有的全角引号。

**验证**：Rust **219 项**（新增 2 条：港澳台转全角与嵌套、大陆不动）。
冒烟新增一条**走真 UI 路径**的端到端用例 —— 在选项对话框里把引号体系选成
「港澳台」，确认全角 `“”` 真的变成 `「」`。这次的教训正是：单测覆盖的是后端
函数，而「选项没生效」这类问题只有端到端点一遍才会暴露。本机冒烟 37 通过 / 0 失败。

**没做的**：手册里台湾与大陆另有几处符号习惯不同（间隔号 `·` vs `．`、
书名号、连接号），按你的要求这次一概不动。
---

## 开发日志 017 — 2026-10-20（CI 在 macOS 上挂：OpenCC 数据目录的并发初始化）

**现象**：`Rust (fmt + check + test)` 的 macos-latest 一栏红，8 条 annotation 全部指向
`src-tauri/tests/convert_contract.rs:98`（`convert_with_inline_dicts(...).unwrap()`）。
Windows / Linux 两栏是绿的，本地 Windows 连跑 5 次也全过。

**根因**：`data_dir()` 首次初始化有竞态。`convert_contract` 里 5 个测试是并行跑的，
其中好几个都会触发 OpenCC 首次写盘，而当时的写法是：

    if target.exists() { continue; }          // 别的线程正在写时文件已经存在
    std::fs::write(&target, data.content)     // 不是原子写

线程 A 正在写 `TSPhrases.ocd2` 时，线程 B 一看文件存在就跳过 —— 手里是**半截字典**，
`opencc_open` 随即失败。macOS runner 的调度与文件系统让这个窗口更容易命中。

**修法**（两道保险）：
1. 初始化加锁：`static INIT: Mutex<()>`，拿到锁后二次检查 `DATA_DIR`；
2. 所有写盘改成**原子写**：先写同目录临时文件再 `rename`（同一文件系统内原子），
   这样「文件存在」就等价于「内容完整」。

这个洞不只影响测试：应用里若有两个操作同时触发首次转换，同样会踩到。

**回归**：新增 `tests/opencc_init.rs` —— 独占一个测试二进制（保证是该进程第一次
`data_dir()`），8 个线程同时首启，逐个校验文件大小与内嵌内容一致、转换结果正确、
所有线程拿到同一个目录。

**验证**：Rust 219 项 + 各集成测试全绿（含新增的并发用例）；`cargo fmt` 与
`clippy -D warnings` 干净。
---

## 开发日志 018 — 2026-10-20（大陆引号规则对台湾文本无效）

**问题**：文件是港澳台的角引号 `「」『』`，排版 → 规范标点 → 引号体系 → 选「大陆」，
一个字都不变。

**根因**：`pair_quotes` 里只有港澳台那一档有全角映射表（`TO_CORNER`），
大陆档落在 `_ => None` —— 只认半角 `"` `'`。与日志 016（港澳台对全角 `“”`
无效）是**反向的同一个洞**。更要紧的是 `mainland` 是这一档的**默认值**，
所以台湾文件点进来什么都不用改，看到的就是「没反应」。

**修法**：给大陆档补上 `TO_MAINLAND` —— `「」`→`“”`、`『』`→`‘’`。
依据仍是台湾教育部《重訂標點符號手冊》修訂版：「引號分單引號及雙引號，
通常先用單引號，單引號內再用雙引號」—— 台湾的单引号是 `「」`（外层）、
双引号是 `『』`（内层），大陆恰好相反（双引号 `“”` 外层、单引号 `‘’`
内层），两边一一对应。

按**字符**直接映射（本次确认的口径）：规范写法 `「他说『你好』」` →
`“他说‘你好’”`。若原文把 `『』` 用在了外层（非规范写法），得到的结果是
层次反的（外层成单引号），字符本身仍是转了的 —— 简化优先，不做层次重排。

**港澳台那一档一字未动**（按要求保持现状）。

**验证**：Rust 219 项（原 `mainland_quotes_stay_as_they_are` 断言的正是
「不动 `「」`」，随本次语义变更改写为 `mainland_quotes_convert_corner_ones`）。
冒烟新增一条走真 UI 路径的**反向**用例 —— 在选项对话框里把引号体系选成
「大陆」，确认 `「」` 真的变成 `“”`。本机冒烟 38 通过 / 0 失败。
---

## 开发日志 019 — 2026-10-20（Windows 便携版：单个 exe、免安装）

**需求**：增加一个便携安装包 —— 整个软件只有一个单独的 exe，直接运行，不写入注册表。

**调查**：
- Tauri **没有** portable 这个 bundle target（Windows 只有 nsis / msi / wix）。
- `target/release/<name>.exe` 本身就是便携的：前端资源已编进二进制，双击直接运行、
  不安装、**不写注册表**（应用本身不碰注册表）—— 业界用法见 EHDL-IDE 的构建文档：
  「`ehdl-ide.exe` — the portable binary」。
- 唯一的坎：运行时要读 `data/legacy`（异体字组表，比较用）与 `data/builtin-tables`
  （内置替换表）。单 exe 旁边没有这两个目录 → 比较会报「未找到异体字组表目录」，
  内置替换表则是空的。

**做法**：
1. 新建 `core/embedded.rs`：用 `include_bytes!` 把这 5 个文件（合计 0.13 MB）编进
   二进制；磁盘上找不到资源目录时展开到临时目录再读（进程内一次，原子写）。
2. `data_tables::legacy_dir` 与 `replace::builtin_resource_dir` 的候选链**末尾**加上
   这条兜底 —— 磁盘上有就永远走不到，安装版行为完全不变。
3. `scripts/make-portable.mjs` 把主 exe 复制成 `AioTextEditor_<版本>_x64_portable.exe`；
   接到 `tauri:build` 之后，本地与 CI 一致。
4. Release workflow 的 windows job 两个都上传（nsis 安装包 + 便携 exe）。

**验证**：
- Rust 221 项（新增 2 条：展开写全、`embedded_matches_files_on_disk` —— 守的是
  「数据改了却忘了重编」，那会让便携版与安装版行为不同，而本地磁盘上总有 data/，
  这种差异几乎发现不了）。
- 冒烟新增 3 条：便携 exe 放在**空目录**（没有 data/）里跑 —— 目录里只有单个 exe、
  能启动渲染、比较功能可用（内嵌的 data/legacy 生效）。比较那条特意用 `fullEq`：
  「兔/兎」在 fc1 里属完全等同，表加载成功才会判为无差异（差异块 0），
  表没加载则直接报错 —— 正好是可判别的。
- 本机冒烟 41 通过 / 0 失败，连跑两次稳定。便携 exe 7.69 MiB。

**踩到的坑**：冒烟里 kill 掉便携进程后立刻删临时目录会 EPERM（exe 还被占用）——
`kill` 是异步的，要等它真正退出；两处清理都加了容错。