# AioTextEditor 文档修订记录

> 每次重大变更在此记录，便于追溯。

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

- **CI 首跑**：macOS 通用包与 Linux AppImage 尚未在真实 runner 上验证过（尤其 macOS 通用包要同时编两个架构的 OpenCC）。
- 若拿到 Apple Developer 证书：接上签名与公证，去掉首次打开的右键放行步骤。
- F-11 §11.3 自定义工具栏（v1.1）、打印、自动分段（v1.1）。
- 会话的边界行为（关掉全部标签后是否顺带清空会话）可按使用反馈细化。

---

