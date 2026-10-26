# AioTextEditor 功能模块详细说明

**版本**：v0.1
**对应 PRD**：v0.1

> 本文档面向开发者，每个模块从"用户故事 → 行为描述 → 数据契约 → 边界情况 → 实现要点"五个维度展开。

---

## 目录

- [F-01 编辑器核心](#f-01-编辑器核心)
- [F-02 多编码 I/O](#f-02-多编码-io)
- [F-03 简繁互转](#f-03-简繁互转)
- [F-04 自定义替换表](#f-04-自定义替换表)
- [F-05 中文增强正则](#f-05-中文增强正则)
- [F-06 文件比较](#f-06-文件比较)
- [F-07 文件合并](#f-07-文件合并)
- [F-08 批处理](#f-08-批处理)
- [F-09 文本整理工具集](#f-09-文本整理工具集)
- [F-10 统计与导航](#f-10-统计与导航)
- [F-11 偏好与快捷键](#f-11-偏好与快捷键)

---

## F-01 编辑器核心

### 1.1 用户故事

> 我可以同时打开多个纯文本文件，在标签中切换，断电后下次启动能恢复到上次关闭时的标签和未保存的内容。

### 1.2 行为描述

- **多标签**：在窗口顶部显示已打开的标签，标签上小圆点表示"修改未保存"。
- **新建 / 打开 / 保存 / 另存为 / 关闭**：通过菜单、快捷键、标签右键菜单触发；关闭另有**关闭其他标签**、**全部关闭**，保存另有**全部保存**（详见 PRD v0.3 §3.4）。
- **拖入文件**：macOS 从 `NSDraggingInfo`、Windows 从 `WebMessage` 拿路径，进入"待打开文件队列"。
- **启动恢复**：启动时读取 `%APPDATA%/AioTextEditor/session.json`（macOS 在 `~/Library/Application Support/AioTextEditor/`，Linux 在 `~/.config/AioTextEditor/`）。
- **修改检测**：基于 CodeMirror 的 `change` 事件，标记缓冲区 `dirty` 标志。
- **关闭确认**（PRD v0.3 §3.4）：
  - 关闭标签时若有未保存内容，弹**三选**对话框：**保存**（保存成功后才关闭；保存失败或取消保存则留在原地）、**不保存**（丢弃改动，且不再由会话恢复）、**取消**（什么都不做）。
  - 批量关闭（**关闭其他标签** / **全部关闭**）时只**汇总询问一次**，不逐个连弹。
  - 从未保存过的新文件选「保存」时走「另存为」让用户指定路径。
  - **退出应用 / 关闭窗口**的拦截（原规格的另一半）**顺延至 v1.1**：本条要改 Rust 侧的窗口关闭事件，macOS `Cmd + Q` 与 Linux 窗口管理器两条路径无法在 Windows 上验证（PRD §3.4 C-8）。

### 1.3 数据契约

```ts
// SessionState（持久化）
{
  tabs: Array<{
    filePath: string | null,
    content: string,
    encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'gb2312' | 'gb18030' | 'big5' | 'iso-8859-1',
    cursorLine: number,
    cursorColumn: number,
    scrollTop: number,
    isDirty: boolean,
  }>,
  activeTabId: string,
  windowBounds: { x, y, w, h }
}
```

### 1.4 Tauri Commands

```rust
#[tauri::command]
async fn session_load(app: AppHandle) -> SessionState;

#[tauri::command]
async fn session_save(app: AppHandle, state: SessionState) -> Result<(), String>;

#[tauri::command]
async fn open_files(app: AppHandle) -> Vec<PathBuf>;  // 启动参数 + 拖放 + 队列

#[tauri::command]
async fn reveal_in_folder(path: PathBuf) -> Result<(), String>;
```

**实现注记（第九阶段）**：

- 实际落地的是 `session_load()`（**永不失败**）、`session_save(state)`（回执**实际落盘值**）、`session_clear()`，另有 `startup_metrics()` / `app_version()`。不需要 `app: AppHandle` 参数——路径由 `core::paths::app_data_dir()` 定位；`open_files` / `reveal_in_folder` 待后续阶段。
- 实际标签字段：`id` / `filePath` / `fileName` / `content`（**`null` = 启动时从磁盘重读**）/ `encoding` / `lineEnding`（`lf` / `cr` / `crlf`）/ `hadBom` / `dirty` / `cursorLine` / `cursorColumn`；`activeTabId` 可为 `null`。
- **正文按需保存**：只有「磁盘上还原不出来」的标签才把正文写进 `session.json`（`dirty` 或从未保存过），否则只留路径——既避免会话被大文件撑大，也让「已保存但被外部改动」的文件以磁盘为准。
- `scrollTop` 与 `windowBounds`（窗口位置 / 大小）本阶段未持久化。
- 落盘为**紧凑 JSON + 原子写**（临时文件 + `rename`）；坏文件留 `.bad` 并**逐标签**恢复，单个坏标签不影响其余。

### 1.5 边界情况

- 启动恢复的文件路径已不存在 → 提示用户并以无标题形式保留。
- 单文件超大（> 50 MB）→ 警告 + 提供仅查看模式。
- 系统剪贴板 / 拖放路径指向符号链接 → 在读盘后跟随到真实路径。

### 1.6 实现要点

- 使用 **CodeMirror 6**（与 iml-lite 一致）：体积小、虚拟滚动易接。
- 用 **Zustand** 管理标签状态。
- 文件 I/O 完全交给 Rust，前端只通过 `invoke` 传字符串 / 字节。

---

## F-02 多编码 I/O

### 2.1 用户故事

> 我能直接打开 GBK 编码的古籍文件、保存为 UTF-8；也能在 UTF-8、UTF-16、GBK、GB2312、GB18030、Big5、ISO-8859-1 等编码之间相互转换（另存为 / 批量重编码），遇到目标编码不支持的字符时有明确提示而不是丢字。

### 2.2 行为描述

- **自动检测**（顺序）：BOM → UTF-8 严格 → GB18030（含 GBK/GB2312） → BIG5 → UTF-16 LE/BE → fallback windows-1252（ISO-8859-1）。
- **手选编码**：`文件 → 重新载入 ▸` 提供编码列表（v0.5：7 项 + 原来的「自动探测…」对话框）——简体中文(936,GBK) / 简体中文(54936,GB18030) / 繁体中文(950,BIG5) / UTF-8 / UTF-16LE / UTF-16BE / NFO(437)。
- **编码转换**（v0.5 新增）：`文件 → 编码转换 ▸` 把**当前文件**按目标编码重写（GBK / GB18030 / BIG5 / UTF-8），内容一个字符都不改，因此 GBK ⇄ BIG5 可任意互转；目标编码表示不了的字符走下面的预检流程。
- **支持编码**（`encoding_rs`，WHATWG Encoding Standard 全集）：UTF-8、UTF-16 LE/BE、GBK、GB2312、GB18030、Big5、ISO-8859-1（windows-1252）、Shift_JIS、EUC-JP、EUC-KR、KOI8-R 等全部读写互转。
  - **例外：CP437 / NFO(437)** 不在 WHATWG 表里（`encoding_rs` 不提供），由 `core/encoding.rs` 自带的 256 项表处理；只支持**显式指定**（重新载入 / 打开），不参与自动探测。
- **保存为非 Unicode 编码（BIG5 / GBK 等）** 时：
  - 保存前**预检**不可编码字符，若有 → 弹窗列出前 N 处，供用户选择：**改存为 UTF-8（带 BOM）/ 以数字字符引用 `&#xNNNN;` 写出（WHATWG 标准行为）/ 取消**。
  - 批处理 / 流水线场景默认采用数字字符引用，不打断流程。
- **BOM 选项**：保存 UTF-8 默认不加 BOM，提供勾选。
- **换行符**：保存提供 LF / CRLF / CR 三选一。
- **行末去 BOM**：读到 BOM 默认剥离。

### 2.3 数据契约

```rust
pub enum Encoding {
    Utf8,
    Utf16LE,
    Utf16BE,
    Gb2312,   // WHATWG 将 GB2312 标签按 GBK 解析（超集兼容）
    Gbk,
    Gb18030,  // 含 4 字节区，GB18030 ⊇ GBK ⊇ GB2312
    Big5,
    Latin1,   // WHATWG 中 ISO-8859-1 标签 = windows-1252
    Cp437,    // v0.5：NFO / DOS 码页，encoding_rs 没有，自带 256 项表
}
// serde 名与 label() 严格一致（"utf-8" / "utf-16le" / "iso-8859-1" …），
// 老名字（utf8 / utf16le / latin1）保留为 alias。v0.4 及以前靠 rename_all 生成
// "utf8"，导致 fs_write 收到前端的 "utf-8" 在反序列化阶段就报 unknown variant。

pub struct LoadResult {
    text: String,
    encoding: Encoding,
    had_bom: bool,
    line_ending: LineEnding,
}

pub struct SaveOptions {
    encoding: Encoding,
    add_bom: bool,
    line_ending: LineEnding,
    /// 不可编码字符策略
    unmappable: UnmappablePolicy,   // Ask / CharRef / ToUtf8
}

pub enum UnmappablePolicy {
    Ask,      // 弹窗（默认，交互保存）
    CharRef,  // 写成 &#xNNNN;（批处理默认）
    ToUtf8,   // 自动改存 UTF-8
}
```

### 2.4 Tauri Commands

```rust
#[tauri::command]
async fn fs_read(path: PathBuf) -> Result<LoadResult, String>;

#[tauri::command]
async fn fs_check_mappable(text: String, encoding: Encoding) -> Vec<(usize, char)>;
// 保存前预检：返回不可编码字符（位置, 字符），供前端弹窗

#[tauri::command]
async fn fs_write(path: PathBuf, text: String, opts: SaveOptions) -> Result<SaveReport, String>;

pub struct SaveReport {
    written_path: PathBuf,
    bytes_written: u64,
    actual_encoding: Encoding,    // 可能与请求不同（如策略选择回落 UTF-8）
    char_refs_written: usize,     // 以 &#xNNNN; 写出的字符数
}
```

### 2.5 数据文件

```
src-tauri/data/legacy/          # 开放文本格式（详见 docs/06-data-dictionary.md）
├─ fc1.txt        # 完全等同异体字组表（文件比较用，1003 组）
└─ fc2.txt        # 部分等同异体字组表（文件比较用，10579 组）

注：
- TextPro 的 s2t.dat/t2s.dat（简↔繁单字表）与 OpenCC 词库同质，已由 OpenCC 取代，不打包。
- TextPro 的 u2b1/u2b2（BIG5 异体字/组字式回退表）按 v0.5 决策弃用，不打包；
  编码互转由 encoding_rs 承担，不可编码字符按 WHATWG 标准以数字字符引用写出。
```

数据文件为开放文本格式，解析器独立为 `core/data_tables.rs`。

### 2.6 边界情况

- BOM 不匹配的 UTF-16 → 当作 8 位 fallback 重新探测。
- GBK 文件夹在 0x80 的孤立字节 → 降级处理，标注可疑区域。
- 超大文件 (>500 MB) → 边读边转换的流式接口。

### 2.7 实现要点

- 编码转换统一使用 Rust 的 [`encoding_rs`](https://github.com/encoding-rs/encoding_rs) 库（GitHub 上 WHATWG Encoding Standard 的参考实现）——UTF-8、UTF-16 LE/BE、GBK、GB2312、GB18030、Big5、ISO-8859-1（windows-1252）、Shift_JIS、EUC-JP、EUC-KR 等全部原生支持，无需自研编码表。
- 不可编码字符由 `encoding_rs` 编码器按 WHATWG 标准生成数字字符引用 `&#xNNNN;`，产品仅在交互式保存前增加预检与弹窗。
- 弃用的 TextPro `u2b1/u2b2` 回退表不再参与任何流程。
- 检测采用 Mozilla universal charset detector 的 Rust 移植版 `chardet`。

---

## F-03 简繁互转（基于 OpenCC 1.4.x）

> 引擎：[BYVoid/OpenCC](https://github.com/BYVoid/OpenCC) v1.4.2（2026-08-22 发布），以 `opencc-sys` crate 静态链接。
> 用户自定义词典：见 [F-04 自定义替换表](#f-04-自定义替换表)。
> 说明：TextPro 原有的简↔繁数据（s2t/t2s.dat）由 OpenCC 取代；其 `fc1/fc2` 实为异体字组表（供 F-06 文件比较用），不属于本模块，见[数据字典](./06-data-dictionary.md)。

### 3.1 用户故事

> 我能把整篇 GBK 简体文章转成繁体并保存为 BIG5，遇到部分多义字时希望它尽量按词组识别而不是单字硬转；我还要能选台湾正体 / 香港繁体 / 中国大陆等不同地区习惯。

### 3.2 行为描述

#### 支持的转换方向（OpenCC 全部配置）

| 配置名 | 转换方向 | 常用场景 |
|--------|---------|---------|
| `s2t.json` | 简体 → OpenCC 标准繁体 | 一般简转繁（推荐） |
| `t2s.json` | OpenCC 繁体 → 简体 | 一般繁转简（推荐） |
| `s2twp.json` | 简体 → 台湾正体（带台湾惯用词彙） | "鼠标 → 滑鼠" 等词组也一并转换 |
| `tw2sp.json` | 台湾繁体 → 简体（带大陆惯用词彙） | 处理台湾文档时按大陆习惯标准化 |
| `s2hk.json` | 简体 → 香港繁体 | 面向香港地区 |
| `hk2s.json` | 香港繁体 → 简体 | 处理香港繁体资料 |

这 6 种**就是全部**：「简繁」菜单里直接点用，没有二级菜单，也不再有「常用 / 其他」之分。

> **实现注记（v0.5：方向收敛）**：原先提供的 8 种低频方向 —— `s2tw` / `tw2s` / `t2tw` / `tw2t` / `t2hk` / `hk2t` / `t2jp` / `jp2t` —— 已按用户要求**从引擎侧彻底删除**：`core/opencc.rs` 的 `Direction` 枚举不再有这些变体、`all_standard()` 只返回 6 个、这些 id 反序列化时会失败（不是"UI 不显示但引擎还认"）。需要它们请走 `Custom`（在 `%APPDATA%/AioTextEditor/configs/` 放自己的配置 JSON）。
>
> **实现注记（第三阶段）**：`opencc-sys` 0.5.2 内嵌数据本来就不含 `t2seal` / `seal2t` / `s2seal`（小篆，试验性）及其词典，故这三个方向历来不支持。

#### OpenCC 转换链（核心机制）

```
[输入文本]
   │
   ▼
[前处理：括号对豁免（可选）]
   │   例如：[]、()、<> 等任意字符对范围内的字符不参与转换
   ▼
[OpenCC 转换]   ◀── 使用 `opencc_open("s2twp.json")`
   │   └─ 引擎自动按 STCharacters/STPhrases 等字典匹配
   ▼
[用户自定义表（可选）]
   │   └─ 编译为 OpenCC 内联字典，作为转换链末位叠加（见 F-04）
   ▼
[OpenCC 歧义片段诊断]
   │   └─ 用 `opencc_convert` + 模拟"反向回查"标记一对多区段
   ▼
[输出文本 + AmbiguitySpan 列表]
```

OpenCC 在转换过程中会按"最大词组匹配"优先于"单字替换"，这等同于 TextPro §1 中描述的"词组级优先级"。

#### 用户词典叠加

参见 [F-04 自定义替换表](#f-04-自定义替换表)。程序把用户的自定义表编译为 OpenCC 内联字典，作为转换链的最后一步叠加（用户词典优先级最高）。

### 3.3 数据契约

```rust
/// 转换请求
pub struct ConvertRequest {
    text: String,
    direction: OpenCCDirection,
    skip_inside: Option<Vec<BracketPair>>,    // TextPro 风格的"括号对豁免"
    apply_user_tables: Vec<String>,           // 加载这些用户表
    diagnostics: bool,                        // 是否返回歧义片段诊断
}

#[derive(Copy, Clone, Serialize, Deserialize)]
pub enum OpenCCDirection {
    // PRD v0.5 §3.5：只提供 6 种，其余已从引擎删除
    S2T, T2S,
    S2TWP, TW2SP,
    S2HK, HK2S,
    Custom { name: String },                  // 用户自定义转换配置
}

#[derive(Clone, Serialize, Deserialize)]
pub struct BracketPair { open: char, close: char }

/// 转换结果
pub struct ConvertReport {
    text: String,
    changed_count: usize,
    /// OpenCC 风格歧义片段（转换时一对多）
    ambiguities: Vec<AmbiguitySpan>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AmbiguitySpan {
    start: usize,
    end: usize,
    candidates: Vec<String>,
    primary: String,
}
```

### 3.4 Tauri Commands

```rust
#[tauri::command]
async fn list_opencc_directions() -> Vec<OpenCCDirectionMeta>;

#[tauri::command]
async fn convert_opencc(req: ConvertRequest) -> Result<ConvertReport, String>;

#[tauri::command]
async fn preview_convert(req: ConvertRequest) -> Result<ConvertPreview, String>;
// ConvertPreview 含前 N 行 diff，用于 UI 在转换前预览差异。
```

### 3.5 已废弃：TextPro s2t/t2s 旧词表

经逆向验证（见[数据字典](./06-data-dictionary.md)），TextPro 的 `s2t.dat`/`t2s.dat` 为简↔繁单字/词组表，与 OpenCC `STCharacters/STPhrases`、`TSCharacters/TSPhrases` 完全同质；`fc1/fc2.dat` 则为异体字组表（属 F-06 文件比较功能），**均不参与简繁转换链**。简繁转换的词汇补充一律走 F-04 用户自定义表（OpenCC 内联字典）。

### 3.6 非 Unicode 编码保存时的回退（v0.5 修订）

- TextPro 的 `u2b1`（异体字）/`u2b2`（组字式）回退表已**弃用**，不再随包分发。
- 编码互转由 `encoding_rs`（WHATWG Encoding Standard）承担：保存为 BIG5 / GBK 等出现不可编码字符时，按标准以数字字符引用 `&#xNNNN;` 写出，不丢字。
- 交互式保存前先预检（`fs_check_mappable`）并弹窗供用户选择：改存 UTF-8 / 以引用继续 / 取消（见 F-02 §2.2）。
- 若用户希望"尽量用异体字保字"，可自行对文本先执行 OpenCC `HKVariantsRev`/`TWVariantsRev` 变体转换再保存——产品不自动串联（避免覆盖用户的用字意图）。

### 3.7 边界情况

| 场景 | 处理 |
|------|------|
| 用户选区为空 | 弹提示"未选区，将转换整篇" |
| 含 Emoji 的现代文本 | 不影响，正常处理 |
| 已有混合文本 | OpenCC 按词典归一化处理 |
| 极短文本（< 4 字节） | 不走 OpenCC，直接返回原文 + 提示"已处理 0 处" |
| 转换中游用户编辑文本 | 取消正在进行的转换任务，重新启动 |
| OpenCC 库初始化失败（理论上不会出现，因静态构建） | 提示"繁简引擎初始化失败"并禁用此功能 |

### 3.8 实现要点

- 底层：`opencc-sys = "0.5"`（`TerakomariGandesblood/opencc-sys`），零运行时依赖，编译期嵌入 OpenCC + JSON 词典。
- 安全封装：自写 `core/opencc.rs` 模块，包装 `unsafe` FFI，提供 RAII `OpenccHandle`（`Drop` 中调 `opencc_close`）。
- 临时文件：因 OpenCC C API 的 `opencc_open` 仅接受磁盘路径，模块在 `%TEMP%/aotext-cc-XXXX.json` 写入配置并持有它，进程退出时清理。
- 歧义片段诊断：
  1. 正常路径：调用 `opencc_convert_utf8` 得到结果文本。
  2. 诊断路径：对结果中的"候选字"反向逐处重查；候选用 `try_alternative_variants`（用户表为空时直接返回 OpenCC 默认歧义）。
  3. 实现参考 OpenCC CLI 的 `--ambiguities` 输出。

  > **实现注记（第三阶段 / v0.5 更新）**：C API 不暴露 OpenCC 内部 Segments（CLI 的 `--ambiguities` 走私有 C++ 接口），故实际采用**同族方向差分**：`s2t`/`s2twp`/`s2hk`（以及各自的对向族）互为同族，逐行比对用字差异即为歧义片段，`candidates` 为同族其他方向的写法，`primary` 为当前方向结果。方向收敛后每族由 4 个降为 3 个，诊断语义不变。对用户语义等价（提示"此处存在其他合理用字"），机制与 CLI 不同。
- 并行安全：`unsafe impl Send + Sync for OpenccHandle`，但 `last_error()` 非线程安全，因此 `convert` 路径用 `Mutex<()>` 保护（与 messense/opencc-rs 设计一致）。

### 3.9 单测覆盖

- OpenCC **6 种**转换（s2t / t2s / s2twp / tw2sp / s2hk / hk2s）各跑 10k 字样本，
  对比 v1.4.2 reference output。
  > **2026-10-26 更正**：此处原写「17 种」，与 v0.5 的方向收敛（见 F-03 §实现注记）
   > 矛盾——引擎侧只有 6 种，另 8 种已删除、`t2seal` 等三个历来不支持。按事实改为 6 种。
- 不转换括号对：含 `[]` 的样例文本。
- 歧义片段诊断：含"文/丑/瞭/干"等多义字的样本。
- 用户自定义表叠加：F-04 的内联字典进入转换链后的组合回归。

---

## F-04 自定义替换表（TextPro 风格 UI + OpenCC 内联字典后端）

### 4.1 用户故事

> 我能用熟悉的 TextPro 格式（`A/B=目标`）维护多张自定义替换表，**既可以独立执行（替换工具）**，**也可以叠加到任何 OpenCC 繁简转换中作为"用户词典"**。

### 4.2 三种使用模式

| 模式 | UI 入口 | 后端 |
|------|---------|------|
| (A) **独立查找替换** | "搜索 → 自定义替换…" | 全部走 Rust 的 `core/replace.rs`（Aho-Corasick + 正则） |
| (B) **叠加到 OpenCC 简繁转换** | "功能 → 简 → 繁（或某一方向）" 勾选用户表 | `core/opencc.rs` 自动把表编译成 OpenCC 内联字典 |
| (C) **批处理中的步骤** | 批处理步骤库中的"自定义替换" | 与 (A) 共享 |

> (A) 适用于"自定义替换不依赖 OpenCC"的场景（如全部都是半角 → 标点调整）。
> (B) 适用于"用户表主要做简繁转换微调"的场景（如 `么=麼`、`山门=山門`）。

### 4.3 表格式（保留 TextPro 6 风格 + 扩展）

**文件位置**：`%APPDATA%/AioTextEditor/tables/*.tab`（UTF-8 无 BOM）

**行的语法**：

| 行 | 含义 | 示例 |
|----|------|------|
| `A=B` | 标准替换 | `鼠标=滑鼠` |
| `A/B=C` | 多对一 | `少/兔=㝹` |
| `A/B/C=D` | 多对多…… | 允许任意数量 / 分隔 |
| `;comment` | 注释 | `; 简体异体字校正` |
| `#name: <filename>` | 表元数据 | `#name: 古籍人名用字统一` |
| `#desc: <text>` | 表描述 | `#desc: 用于佛经校勘阶段一` |
| 空行 | 忽略 | |

> **实现注记（第四阶段）**：格式解析落在 `core::replace::parse`，行为与上表一致，并明确以下**格式保留字符**（无法作为键，需在编写表时避开）：
>
> | 字符 | 位置 | 原因 |
> |------|------|------|
> | `=` | 任意 | 分列符（首个 `=` 分左右） |
> | `/` | `=` 左侧 | 候选分隔符（如需字面 `/` 目前无法表达） |
> | `;` `#` | 行首 | 注释标记（`#name:` / `#desc:` / `#rules:` 为元数据行） |
> | `\` | 任意 | 转义引导符，字面反斜杠写作 `\\` |
>
> 转义仅支持 `\n` `\t` `\r` `\\`（`#rules: escape=0` 时整行按字面处理）。另有扩展元数据行 `#rules: escape=1,wholeWord=0,caseSensitive=1,useRegex=0`，用于把整词/大小写等开关随表持久化（表管理对话框中的复选框即写这一行）。

1. 用户表中"全文出现的行"优先（按文件中位置从上到下）。
2. 多对一形式中，**先列出者优先**（与 TextPro 行为一致）。

### 4.4 作用于 OpenCC 的转换链表示

当用户在简繁转换对话框中勾选使用某张自定义表时，**`core/opencc.rs`** 把该表编译为以下 OpenCC 配置（运行时写入临时 JSON）：

```json
{
  "name": "AioTextEditor:UserDictionary(My Table)",
  "conversion_chain": [
    { "dict": { "type": "group", "dicts": [
        { "type": "ocd2", "file": "STPhrases.ocd2" },
        { "type": "ocd2", "file": "STCharacters.ocd2" }
    ]}}
  ]
}
```

加入用户内联字典后：

```json
{
  "name": "AioTextEditor:UserDictionary(My Table)",
  "conversion_chain": [
    { "dict": { "type": "group", "dicts": [
        { "type": "ocd2", "file": "STPhrases.ocd2" },
        { "type": "ocd2", "file": "STCharacters.ocd2" },
        { "type": "group", "dicts": [
            { "type": "inline", "entries": {
                "少": "㝹",
                "兔": "㝹",
                "鼠标": "滑鼠"
            }},
            { "type": "inline", "entries": {
                "麽": "么"
            }}
        ]}
    ]}}
  ]
}
```

> 这相当于把用户表"挂在 `STPhrases/STCharacters` 之后"——OpenCC 会按配置中 `group.dicts` 顺序查表，**用户表优先级最高**，与我们的设计一致。

### 4.5 数据契约

```rust
pub struct ReplaceTable {
    name: String,
    description: String,
    entries: Vec<ReplaceEntry>,
    rules: ReplaceRules,
    meta: TableMeta,
}

pub struct ReplaceEntry {
    pattern: String,           // A/B 形式时为左侧的多个 candidates
    candidates: Vec<String>,   // 已展开的左侧候选
    replacement: String,       // = 右侧
}

pub struct ReplaceRules {
    whole_word: bool,      // 仅作 UI 选项；OpenCC 内联字典模式下不生效
    case_sensitive: bool,  // 仅作 UI 选项；OpenCC 内联字典默认大小写不敏感
    escape: bool,          // 是否对 \n 等做转义
    use_regex: bool,       // [v1.1] 启用后使用 Rust 正则引擎而非 OpenCC
}

pub struct ApplyOpts {
    mode: ApplyMode,
}

pub enum ApplyMode {
    /// 走 Rust 引擎（独立替换）
    Standalone,
    /// 走 OpenCC 内联字典（与简繁转换合并执行）
    AsOpenCCDic,
}

pub struct ApplyReport {
    text: String,
    changed_count: usize,
    per_entry_count: HashMap<String, usize>,  // 词 → 替换次数
}
```

### 4.6 Tauri Commands

```rust
#[tauri::command]
async fn list_replace_tables() -> Vec<TableMeta>;

#[tauri::command]
async fn load_replace_table(name: String) -> Result<ReplaceTable, String>;

#[tauri::command]
async fn save_replace_table(table: ReplaceTable) -> Result<(), String>;

#[tauri::command]
async fn delete_replace_table(name: String) -> Result<(), String>;

#[tauri::command]
async fn validate_replace_table(table: ReplaceTable) -> Result<ValidationReport, String>;
// 验证：解析每行的语法、检查 =/B/A 形式、检查正则（如启用）

#[tauri::command]
async fn apply_replace(
    text: String,
    table: ReplaceTable,
    opts: ApplyOpts,
) -> Result<ApplyReport, String>;

#[tauri::command]
async fn import_textpro_tab(path: PathBuf, name: Option<String>) -> Result<ReplaceTable, String>;
// v1.0：导入 TextPro .tab 文件（自动识别空格 / "=" 两种分隔符），返回解析后的表

#[tauri::command]
async fn export_opencc_json(table: ReplaceTable, path: PathBuf) -> Result<(), String>;
// v1.1：导出为 OpenCC 内联字典 JSON 配置

#[tauri::command]
async fn export_opencc_ocd2(table: ReplaceTable, path: PathBuf) -> Result<(), String>;
// v1.1：导出为 OpenCC .ocd2 二进制词典（依赖 opencc_dict 工具链）
```

> **实现注记（第四阶段）**：以上命令均已实现（重活经 `spawn_blocking`），`save_replace_table` / `delete_replace_table` 返回类型收紧为 `TableMeta` / `()`。为支撑「UI 镜像编辑器」（F-04 §4.9：直接编辑 `.tab` 源文本），另补三条命令：
>
> | 命令 | 作用 |
> |------|------|
> | `read_replace_table_source(name) -> String` | 取源文本（保留注释与排版，供编辑器载入） |
> | `parse_replace_table_text(text, name) -> ParsedTable` | 解析并返回**源行号级**校验报告（`table` + `report`），驱动实时标红 |
> | `save_replace_table_source(name, text, sourcePath) -> TableMeta` | 保存源文本；校验不通过则**阻止保存**（F-04 §4.8）；内置表与新建表一律落到用户目录（重名自动追加 ` (2)`，不覆盖既有表） |
>
> `export_opencc_json` / `export_opencc_ocd2` 属 v1.1，未实现（模式 B 走运行时内联配置，见 §4.4）。表名解析同时接受**文件名**与 `#name:` 显示名（UI 列表用的是显示名）。

### 4.7 二次正则替换（TextPro §20 行为）

作为 v1.0 的最小集，先实现"链式串接"，高级二次正则放到 v1.2：

- **链式串接**：在批处理中把"自定义替换"、"OpenCC 转换"、"自定义替换"等作为多个独立步骤按序执行（顺序可由用户拖拽决定）。
- **二次正则（v1.2）**：`ReplaceRules.secondary` 字段允许附加一份"先 regex，match group n 时用表 m 替换"。

### 4.8 边界情况

| 场景 | 处理 |
|------|------|
| 同名表已存在 | 保存时改名 `name (2)`，UI 提示 |
| 用户给出非法正则 | UI 高亮出错行 + 底部状态栏吐错；保存阻塞 |
| 用户表很大（> 1 万行） | 编译为 OpenCC 内联字典时自动切分到多个 group |
| 用户表的左侧与 OpenCC 默认词典冲突 | OpenCC 按配置顺序，用户表排在后面 → 用户优先 |
| 没有 = 的行（裸文本） | UI 中给出警告"行 N 缺 ="，保存阻塞 |
| 表中字符含 `\n` `\t` 等不可见字符 | 按转义符规则处理（`\n` → LF），与 TextPro 一致 |
| 表路径含中文 | UTF-8 NFD/NFC 规范化后比较（macOS 文件系统需要） |

### 4.9 实现要点

- **表解析**：行级处理，关注 `;` `#` `=` 三类分隔符；UTF-8 BOM 剥离。
- **OpenCC 内联字典编译**：
  - 把 `ReplaceTable.entries` 摊平为 `HashMap<String, String>`。
  - 按优先级分割：先处理整词表（candidates 都是单词），再处理多对多。
  - 生成阶段拼成 OpenCC JSON，运行时写入临时文件。
- **独立替换引擎**：
  - 大表使用 `aho-corasick`（Rust）做多模式匹配 + 二级优先级表。
  - 小表使用 `HashMap<String, String>` 即可。
- **UI 镜像编辑器**：CodeMirror + 当前解析状态做 lint（标红错误行）。
- **导入（v1.0）**：支持导入 TextPro 的 `.tab` 自定义替换表文件（含半角空格旧分隔符与 `=` 新分隔符两种格式的自动识别，TextPro V6 前旧表用空格分隔、V6 后用 `=`，见 TextPro §2 说明）。
- **导出（v1.1）**：支持导出为 OpenCC 原生表格式（`.json` 内联字典配置 / `.ocd2` 二进制词典），方便与 OpenCC 生态工具互通。

### 4.10 内置示例表（首次启动时复制到用户目录）

为了让用户体验上手即用，**首次启动时**把以下表复制到 `tables/builtin/`（不计入用户修改）：

| 文件名 | 内容 |
|--------|------|
| `简体异体字校正.tab` | ~80 个简体异体字（来自 OpenCC 维护的 `STVariants`） |
| `古籍常用字.tab` | ~200 个古文 / 佛经用字（参考 `fc1.txt`/`fc2.txt` 异体字组表编写） |
| `中文标点修正.tab` | 半角→全角标点对照 |
| `EmptyLinesNormalize.tab` | 用于"删除空行"等内部步骤 |

这些表**默认禁用**，由用户在"设置 → 替换表"显式启用。

> **实现注记（第四阶段）**：实际内置三张示例表，内容由 `scripts/gen-builtin-tables.mjs` 从 **opencc-sys 内嵌的 OpenCC 原始词典**（Apache-2.0，© Carbo Kuo 等）生成，产物落在 `src-tauri/data/builtin-tables/`（编译期打包，`tauri.conf.json` 的 `bundle.resources`）：
>
> | 文件（`tables/builtin/`） | `#name:` 显示名 | 条目数 | 数据来源 |
> |---|---|---|---|
> | `simplified-variants.tab` | 异体字校正（兼容区） | 1002 | `CJK_Compatibility_Ideographs.txt` |
> | `ancient-usage.tab` | 古籍异体字规整 | 78 | `TWVariants.txt` + `HKVariants.txt` |
> | `cn-punct.tab` | 中文标点修正（半角→全角） | 28 | 脚本内联（`=` `/` `;` `#` 无法作为键，见 §4.3） |
>
> 复制策略：**仅在目标文件不存在时复制**（用户改动过的副本不会被覆盖）；启动日志记录 `count` / `copied`，二次启动 `copied=0`（幂等，已由真实运行验证）。生成脚本会按解析器规则**回读校验条目数**，数量不符即报错，避免「以 `;`/`#` 开头的键被当注释静默吞掉」这类数据缺陷。规格中设想的 `古籍常用字.tab`（依赖 `fc1.txt`/`fc2.txt`）属第六阶段文件比较的异体字组表，本阶段未纳入。

### 4.11 单测覆盖

- 解析：每种行格式 1 个 fixture。
- 应用：100 行白盒测试，独立模式 50 + OpenCC 模式 50。
- 与 OpenCC 组合：转换链顺序、用户表优先、歧义诊断。
- 跨平台路径：macOS NFD、NFC、Windows 中文路径。

---

## F-05 中文增强正则

### 5.1 用户故事

> 我能用类 `\c[GBK]` `\c[BIG5]` `\c[数字]` `\c[天干]` 这种类目快捷选择汉字字符集，无需手写范围。

### 5.2 行为描述（基于 TextPro 的中文正则）

| 类目 | 含义 |
|------|------|
| `\c[GBK]` | GBK 全部字符（含简繁、符号） |
| `\c[BIG5]` | BIG5 全部字符 |
| `\c[数字]` | 中英文数字 |
| `\c[天干]` | 甲乙丙丁戊己庚辛壬癸 |
| `\c[地支]` | 子丑寅卯辰巳午未申酉戌亥 |
| `\c[大写金额]` | 零壹贰叁... |
| `\c[标点]` | 中英文标点 |
| `\a` | ASCII 字母 |
| `\d` | 数字（同 `\c[数字]`） |
| `\n` | 换行 |
| `\t` | 制表符 |
| `\xhhhhhh` | 1-6 位十六进制 Unicode |
| `\\` | 字符 `\` |

附加功能：
- **忽略回车**、**忽略半角空格**、**忽略标点** 三个开关。
- **捕获组 `\1` `\2`** 等。
- **使用转义符**：在普通搜索中也允许 `\n`、`\t`、`\x...`。

> **实现注记（第四阶段）**：类目清单与上表一致（另有 `\c[汉字]`、`\c[字母]` 两个别名，均由下拉直接插入）。`\c[GBK]` / `\c[BIG5]` 按 **GBK/BIG5 实际码表**逐字符解码生成集合（而非粗粒度区间），故「GBK 有、Unicode 亦有」的生僻字精确命中，而 ASCII 与增补平面汉字（如 U+20000）不进集合。
>
> **三个「忽略」开关的实现语义**：把被忽略字符**从匹配空间中摘除**后再匹配，命中区间再映射回原文（区间包含被忽略字符，例如「关 键\n词」命中「关键词」）。映射时**起点取字符起始、终点取前一个命中字符的末尾**——即尾随的被忽略字符（如命中后的空格）**不并入命中区间**。此细节由第四阶段真实 UI 回归发现并修正（原实现会吞掉尾随空格，导致高亮与替换范围偏大）。

### 5.3 数据契约

```rust
pub struct RegexOptions {
    ignore_newlines: bool,
    ignore_punct: bool,
    ignore_half_space: bool,
    case_insensitive: bool,
    use_escape: bool,
}

pub struct RegexEngine;  // 'std::regex' 增广 + 中文类目
```

### 5.4 Tauri Commands

```rust
#[tauri::command]
async fn regex_find(text: String, pattern: String, opts: RegexOptions) -> Vec<MatchSpan>;
#[tauri::command]
async fn regex_replace(text: String, pattern: String, replacement: String, opts: RegexOptions) -> ReplaceReport;
```

> **实现注记（第四阶段）**：实际签名增加两个可选参数以便 UI 实现「替换当前这一个」与「全部替换」：
>
> ```rust
> async fn regex_replace(text, pattern, replacement, opts, skip: Option<usize>, limit: Option<usize>) -> RegexReplaceReport;
> // skip：跳过前 N 个命中；limit：仅替换 N 个（None = 到底）
> ```
>
> `RegexReplaceReport` 含 `text` / `count` / `spans`（替换前坐标）与 **`replacements`**（每个区间的实际替换文本，与 `spans` 一一对应）——UI 据此做**精确区间改写**，避免为「只替换一处」而整篇重写丢失光标。另新增 `regex_categories()` 提供下拉数据源。
>
> **偏移口径**：`MatchSpan.start/end` 一律为 **UTF-16 码元**偏移（CodeMirror 文档坐标），可直接用于高亮与选区，前端无需换算。

### 5.5 实现要点

- 选用 `regex` crate（HFA 引擎）作为基础。
- 编译前做"预转换"：把所有 `\c[...]` 替换为对应 Unicode 范围集合。
- 编译错误返回带行列号的 `RegexError`，UI 跳转。

> **实现注记（第四阶段）**：编译错误目前以可读文本返回（含 `regex` crate 的原始诊断），**行号**与 UI 跳转留待 v1.1（`RegexEngine` 类型未单独抽象，直接以 `compile()` + `find()` / `replace()` 函数式 API 暴露）。预转换在 `extend()` 中单遍扫描完成（同时处理 `\c[...]` `/` `\a` `/` `\d` `/` `\n` `/` `\t` `/` `\x...` `/` `\\`），字面查找模式下改为 `unescape_literal()` + `regex::escape()`。捕获组 `\1`/`$1` 两种写法都可用（`$1` 由 `Captures::expand` 原生支持，`\1` 在 `expand_replacement()` 中改写为 `$1`）。

### 5.6 实现注记（2026-10-20，选区预填查找 / 替换输入框）

- **两个输入框共用一条规则：鼠标最后点过哪个框，正文里选中的文字就补进哪个框** —— 省掉一次复制粘贴。面板刚打开时默认是查找框。
- 查找框填了自动跑一次查找；**替换框只接住文字**，绝不替用户执行替换。
- **先选好文字再按 Ctrl+F / Ctrl+H**：这一刻的选区直接落进对应的框并自动查一次。
- **跨行 / 跨段的选区转成字面的 `\n`，并自动切到正则模式**：单行输入框塞不下真实换行，而后端认的是正则；其余元字符（`(`、`[`、`+` 等）逐个转义，否则选中 `a(b` 一查就报错。
- **超过 600 字不自动填**：那么长多半是误选了整篇，填进去既卡也没意义。
- **两种情况一律不动**：空选区（只是点了一下光标）；以及程序跳转（查找下一个 / 跳差异）顺带选中的段落 —— 否则用户刚敲好的替换词会被跳过去的那个词顶掉。`Editor` 给每一笔选区标了来源（`Annotation`），面板据此分辨是不是用户亲手框的。

---

## F-06 文件比较

### 6.1 用户故事

> 我能在同一个窗口上下或左右平铺两份文本，按 F5 同步定位差异，逐字校对。

### 6.2 行为描述

- **视图模式**：双栏（「一个对照窗 + 一个目标窗」），平铺方式可选水平 / 垂直。
- **目标窗与对照窗**：
  - 目标窗是「要改的那个文件」：外框**浅蓝高亮**，可直接编辑，激活标签跟着它走（保存 / 另存 / 统计等命令都作用于它）。
  - 对照窗只读，只用来比对。
  - 鼠标点哪格、哪格就是目标窗，另一格自动转为对照窗。
- **差异标红**（让人一眼看出这个文件少了什么、多了什么）：
  - 落在哪一格由「谁多出了字」决定：目标窗**缺**的文字标在**对照窗**，目标窗**多出**的文字标在**目标窗**。
  - 两侧同一个样子 —— **红字 + 淡红底，不加下划线 / 删除线**；落在哪一格已经说明了它是该补进去还是该删掉。
  - **只标真正的差异**：两文只差一个字时，后面重新对上的部分一个都不标（三处统一走最小编辑脚本，见 §6.8）。
- **同步方式**：
  1. 用户在每个文件手动设定"起始对齐位置"。
  2. 按 F5 启动同步滚动比较。
  3. 发现不一致时，状态栏提示，并激活文件中光标跳到该位置，另一窗口同步滚动。
- **忽略项**：
  - 回车。
  - 半角空格。
  - 全角标点（可选）。
  - 半角标点（可选）。
  - 异体字：
    - 完全等同（音义全同，如"兔兎"）。
    - 部分等同（部分相同，如"奔犇逩"）。
    - 不忽略。
- **结束条件**：任意一方到达尾部，提示已完成。

### 6.3 数据契约

```rust
pub struct CompareOptions {
    ignore_newlines: bool,
    ignore_half_space: bool,
    ignore_full_punct: bool,
    ignore_half_punct: bool,
    variant_strictness: VariantStrictness,
}

pub enum VariantStrictness {
    FullEq,        // 异体字完全等同视为相同
    PartialEq,     // 部分等同
    Strict,        // 不忽略
}

pub struct CompareReport {
    differences: Vec<Difference>,
}

pub struct Difference {
    pos_a: usize,
    pos_b: usize,
    char_a: Option<char>,
    char_b: Option<char>,
}
```

### 6.4 Tauri Commands

```rust
#[tauri::command]
async fn compare_diff(a: String, b: String, opts: CompareOptions) -> DiffResult;

// DiffResult { blocks: DiffBlock[], truncated: bool, degraded: bool }
// DiffBlock { posA, posB, lenA, lenB }   // 一处差异；长度为 0 的一侧表示那一侧没有对应的字
```

### 6.5 实现要点

- 最小编辑脚本 + 三级漏斗（`core::text_diff`，不引第三方 diff 库）；早期那套逐字同步已删除，见 §6.8。
- 异体字查表：`src-tauri/data/legacy/fc1.txt`（完全等同）与 `fc2.txt`（部分等同），开放文本格式（见[数据字典](./06-data-dictionary.md)），另支持用户扩展表。
- 双向同步的滚动通过前端 `requestAnimationFrame` 而非 Rust 实时通信。

### 6.6 实现注记（2026-10-15，第六阶段）

- **算法与 §6.5 提示的偏差**：规格 §6.5 把 Myers diff（`similar` crate）列为实现提示，但 F-06 的用户故事是「F5 同步、逐字校对、任一方到达尾部即结束」——Myers 求的是最小编辑脚本，在失配处会「两侧各退一步」，与 TextPro 的「两侧各进一步」行为不符。**改用流式 O(n) 同步逐字实现**，失配处两侧各进一步（逐字校对口径），复杂度 O(n + m)、内存 O(1)。**50 MB × 2 内嵌 3 处差异的直测秒级通过**，百 MB 用例同样可用，无需引入额外依赖；偏差已记录在 F-06 实现注记。
- **偏移口径为 UTF-16 码元**：与 CodeMirror / regex 阶段一致；指**原文坐标**，不受忽略项过滤影响——`positions_are_original_offsets_despite_ignored_chars` 单测锁定。
- **忽略字符集合**：回车 = `\n` / `\r`；半角空格 = `' '` / `'\t'`；全角标点 = `，。！？、：；（）《》〈〉「」『』【】〔〕｛｝“”‘’…—～·％＋－＊／＝`；半角标点 = `,.!?;:()[]{}<>"'` 等等（共约 40 个）。
- **异体字策略是「叠加」关系**：`FullEq` 只用 fc1；`PartialEq` 优先 fc1 再叠加 fc2（部分等同是完全等同的超集）；`Strict` 逐字。
- **差异清单上限 5000 + `truncated`**：百 MB 全异文本不至于生成上亿条目，UI 提示「仅显示前 N 处」。
- **「一处」的定义**：相邻的一「缺」一「多」并成一处 —— 把一个字换成另一个字算**一处**；这是工具条上「第 i/N 处」的 N，也是计数与标红能对得上的缘由（旧的 4 种结束原因 `CompareEnd` 随逐字口径一并删除）。
- **平铺与同步**：双栏平铺支持垂直 / 水平；F5 = 下一处不一致（按当前报告），Shift+F5 = 从两个窗格当前光标处重新比较（即「重选同步起点」）；比较模式 B 窗只读、不抢焦点（`SelectionRequest.focus:false`）。
- **Tauri 命令**：`compare_texts(a, b, opts)`。
- **异体字组表未支持用户扩展**：规格 §6.5 提到的「用户扩展表」在 v1.1 之前未启用，当前是只读加载 `data/legacy/fc1.txt` / `fc2.txt`（已被 `OnceLock` 进程内缓存）。
- **三栏平铺与「同步滚动」**（规格 §6.5 列的两条扩展）**未实现**：v1.1 视需要再起。

### 6.7 实现注记（2026-10-20，目标窗切换与差异标红）

- **只读状态靠 Compartment 原地翻转**。`EditorView.editable` / `EditorState.readOnly` 是状态级配置，挂载时定死就切不动了。项目里行号、自动换行那三项本来就用 Compartment，只读沿用同一套 —— 重建 EditorState 会丢撤销历史与滚动位置，比较模式下两格都会明显跳。
- **激活标签必须跟着目标窗走**。否则在 B 窗改完按 Ctrl+S，存的是 A 窗那个文件，改动会凭空消失。代价是**两窗的渲染来源不能再由 `activeTabId` 推**，得各自记 id —— 否则 A 窗会渲染成 B 的内容。
- **差异标红用 RangeSet**：分块稀疏结构，**只有视口内的装饰才真正绘制**，所以「标全部差异」与「大文件不卡」能同时成立；数量上限由后端截断（5000 处）兜住。
- **查找 / 转换 / 撤销只作用于目标窗**：`pendingEdit` / `commandRequest` / `highlights` 在比较模式下按目标窗分发，避免写进只读的那一格。差异跳转的选区请求另走一套（`compareSelectionA` / `compareSelection`），不与查找定位共用 —— 共用的话，在目标窗查找会把另一格也带跑。
- **术语分层**：对话框里说「A 侧 / B 侧」（比较的两侧，固定不变）；进入比较后说「目标窗 / 对照窗」（当前角色，会随切换易位）。差异数据里的 `posA` / `posB` 始终指两侧，只在显示时翻译成角色名。

### 6.8 实现注记（2026-10-20，口径统一：只留最小编辑脚本）

**两套口径并存的日子结束了。** 原先差异计数与 F5 跳差异走 TextPro 式**同步逐字**（`compare_texts`），只有标红另走 `compare_diff`；由此产生一个绕不过去的现象 —— **界面上的「N 处不一致」与标红的处数不必相等**（`汉字软件` / `汉字兔软件`：3 处 vs 1 处）。现在逐字那套与 `compare_texts` 命令一并删除，**差异计数、F5 跳差异、标红同吃 `compare_diff` 一份结果**，两个数字必然相等。

**「一处」的定义**：相邻的一「缺」一「多」并成一处。把一个字换成另一个字算**一处**（不是两处），这与人在屏幕上的观感一致，也是工具条上「第 i/N 处」的 N。

**工具条那句提示换掉了。** 旧的「X 窗先到尾部，还剩 N 字」来自逐字口径的 `CompareEnd`，diff 口径下没有对应含义；改为站在目标窗立场的统计 —— **「第 i/N 处 · 共 N 处 · 新增 X 字 · 缺失 Y 字」**（表达参考了 DiffChecker 的「新增 / 删除 / 修改」统计栏，MIT）。

**删掉逐字之后，50 MB 是唯一要重新兜住的能力。** 原先那条大文件用例靠的是逐字流的 O(1) 内存，现在由三级漏斗接手：

| 层 | 触发条件 | 代价 |
|---|---|---|
| 裁公共前后缀 | 总是先跑 | 线性；多数文本到此为止 |
| 字符级 DP | 剩余规模 < `MAX_DP_CELLS`（约 2000×2000） | **精确最优**，内存 O(n·m) |
| 按行 Myers | 文本里有换行 | 行内容压成 u64，`O(N·D)`，D 是行差数 |
| 逐位比较 | 没有换行**且**两侧等长 | 一趟线性，不占额外内存 |
| `degraded` | 以上都兜不住 | 如实提示「文本过大，未完整比较」 |

最后一条是刻意的：**不再悄悄退回另一套算法**。算不准就把话说清楚，而不是给一个看着正常的数字。

**参考过 DiffChecker（MIT，`index.html` 里的自实现算法），但一行没抄。** 结构上它是「先按行对齐 → 再对失配行做字符级」，方向与漏斗一致；缺点是每层都弱一档 —— 没有前后缀裁剪、行级是朴素 LCS 且**每格 new 一个 JS 对象**、字符级是三重循环（最坏 `O(n³)`）、没有任何规模保护。实测它的行级：4000 行要 2.1 秒 / 1.6 GB 堆（行数翻倍内存涨 4 倍），照此外推到本节那两条 50 MB 用例的规模约 **5.8 小时 / 16 TB**。它只贡献了「统计栏该怎么说」这点思路。

---

## F-07 文件合并

### 7.1 用户故事

> 我能用正则表达式把多个分散文件合并成一个，例如 `(\d+)_(\d+)\.txt` → `\1.txt`，且按第二个分组排序。

### 7.2 行为描述

- **手工合并**：
  1. `文件 → 合并文件` 打开对话框。
  2. 选择源文件列表、定义输出文件名、排序字段。
  3. 合并后保存为新文件。
- **自动合并（正则）**：
  - 源文件名正则：`(\d+)_(\d+)\.txt`
  - 输出文件名正则：`\1.txt`
  - 排序关键字：`\2`
- **合并策略**：
  - 简单拼接（行尾追加空行）。
  - 同名段拼接（仅 `\1` 文件去重，行为按序追加）。

### 7.3 Tauri Commands

```rust
#[tauri::command]
async fn merge_files(req: MergeRequest) -> Result<MergeReport, String>;
```

### 7.4 边界情况

- 输出文件已存在 → 询问是否覆盖。
- 源文件读取失败（编码错误）→ 跳过 + 报告。

### 7.5 实现注记（2026-10-15，第六阶段）

- **两种模式共用规划器 `core::merge::plan_merge`**：吃内存 `MergeItem`（不读盘）→ 输出 `Vec<MergedOutput>`；文件 I/O 在 `commands/merge.rs`。这样「1 万文件合并」可以在单测里直接构造，无需真实落盘。
- **排序为自然排序**（数字段按数值比较，段后字符继续参与比较）：`2 < 10`，对 `(\d+)_(\d+)\.txt` 这类文件名是显然正确的语义；键相同时按文件名次排、没给排序关键字时保持输入顺序（`no_sort_key_keeps_input_order` 锁定）。
- **模板渲染 `\1`..`\9`**：越界/未命中 → 空串；与 §7.2 例子一致。
- **拼接策略（简单拼接 = 行尾追加空行）**：各文件去尾换行后以一个空行相接，结果保证单个结尾换行；读入的文本已由编码层归一为 LF，故文本里多个连续空行也会被去尾。
- **同名段拼接（自动合并）**：按源正则第 1 捕获组分文件去重，组内按排序关键字排序，输出名由 `output_pattern` 模板渲染；未命中源正则的文件在命令层被过滤（不计入 `scanned`），全部文件都没有命中则报错「没有文件名匹配源正则的文件」。
- **`overwrite: bool` 在命令层**：不勾时**跳过并在 `MergeReport.skipped` 写明「输出文件已存在（未勾选覆盖）」**，让用户在通知里看到、而不是被静默覆盖。
- **读取失败的处理**：编码读失败 → 进入 `MergeReport.skipped`（path + reason）；全部源文件都读失败 → 直接报错「没有任何源文件读取成功，合并中止」，不写出任何输出。
- **`MergeRequest` 的 tag + flatten 平铺 JSON**：前端发的是 `{"mode":"manual","files":[…],"strategy":"simple",…}` 这种平铺对象（TS 判别联合直接对应），比「结构体里嵌一个 internally-tagged 枚举字段」少一层嵌套、更不易写错。
- **输出编码**：默认 UTF-8（无 BOM，行尾 LF）；不支持自定义输出编码是当前 v1 的限制，规格 §7.2 也未要求。
- **Tauri 命令**：`merge_files(req)`。

---

## F-08 批处理

### 8.1 用户故事

> 我能配置一组流水线（重编码 / 简繁转换 / 替换 / 删除行末空格），然后把整个目录的文件批量跑一遍，并自动备份。

### 8.2 行为描述

UI 布局（沿用 TextPro 的双栏模式）：

- **左下框**：可用的处理步骤库（简繁转换、自定义表、删除空行 / 段内回车、替换、删除半角、半角转全角、控制行宽、删除重复行、归一行首、自动分段等）。
- **右下框**：已选处理步骤的顺序队列（拖拽调整）。
- **顶部**：目录选择器（或多文件拖入）。
- **设置区**：
  - 输入编码（含"自动"）。
  - 输出编码（含"自动 / 跟输入"）。
  - 是否递归子目录。
  - 是否建立 `.bak` 备份。
  - 仅修改过的文件保持原 mtime。

### 8.3 步骤抽象

```rust
#[serde(tag = "kind")]
pub enum PipelineStep {
    ConvertS2T(ConvertOptions),
    ConvertT2S(ConvertOptions),
    ApplyTable { name: String, opts: ReplaceRules },
    RegexReplace { pattern: String, replacement: String, opts: RegexOptions },
    RemoveHalfWidth(HalfWidthOptions),
    HalfToFull(HalfFullOptions),
    FullToHalf,
    TrimLineEnd,
    NormalizeLineHead(NormalizeHeadOptions),
    RemoveEmptyLines,
    RemoveIntraLineBreaks(IntraLineOptions),
    AutoSegment(SegmentOptions),
    ControlLineWidth(u32),
    RemoveDuplicateLines,
    SortLines(SortMode),
    RemoveBlankHead,
    BracketsMatch,
    ReplaceHalfQuotes,
    VerticalToHorizontal,
}
```

### 8.4 Tauri Commands

```rust
#[tauri::command]
async fn batch_run(req: BatchRequest, progress: tauri::State<ProgressEmitter>) -> BatchReport;

pub struct BatchRequest {
    inputs: Vec<PathBuf>,
    recursive: bool,
    backup: bool,
    input_encoding: EncodingOrAuto,
    output_encoding: EncodingOrAuto,
    steps: Vec<PipelineStep>,
}
```

### 8.5 进度回调

通过 Tauri 的 `Channel<T>` 或 `Event` API 把每个文件的处理进度和错误推到前端。

### 8.6 实现要点

- `walkdir` crate 递归枚举。
- `rayon` crate 并行处理多文件（数量受限于 `available_parallelism`）。
- 进度通过 `Arc<AtomicUsize>` + 间隔广播。

### 8.7 实现注记（2026-10-15，第七阶段）

**进度必须「合并上报」——这是本阶段最重要的实测结论。** 规格 §8.5 只说「通过 `Channel<T>` 把每个文件的进度推到前端」，但逐文件推送在真实环境里会彻底盖过批处理本身：

| 做法 | 300 文件实测耗时（core 内部计时） |
|------|-----------------------------------|
| 每个文件推 2 条事件（Started + Done） | **21.3s** |
| 后端合并为进度快照（每 100ms 一条） | 5.8s |
| 再延迟首次上报 300ms + 间隔 500ms | **0.12s** |

`core::batch` 真正跑完 300 文件 × 5 步骤只要 0.12s。也就是说 `Channel::send` 单次约 **35~100ms**（VM 内 WebView2 的 IPC 往返），600 次 send 就是 20s。因此 `commands/batch.rs` 用 `ProgressThrottle` 做合并：计数用原子量累加，至多每 `FIRST_FLUSH_MS`（300ms，之后 `FLUSH_MS`=500ms）发一条 `BatchProgress::Progress` 快照，收尾补一条 `Finished`（含完整报告与完整错误清单）。**短任务因此完全不报中间进度**——用户直接看到结果，不多花一分 IPC。

- **`BatchRequest` 比规格多一个 `preserveMtime`**：规格 §8.2 的「不变更 mtime」是默认行为，但用户偶尔需要「只处理、时间戳照常更新」（例如让下游同步工具感知变化），故做成显式开关、默认开启。
- **`EncodingOrAuto` 用手写 serde 而非 `untagged`**：`untagged` 下单元变体 `Auto` 会序列化成 `null` 而非 `"auto"`。手写后前端发的是裸字符串（`"auto"` / `"utf-8"` / `"gbk"` …），未知编码直接报错而非静默回退。
- **重编码算「改写」**：输入 GBK、输出 UTF-8 时，即使流水线没改一个字，也必须写出（否则「编码互转」在正文无变化时会被静默跳过）。判定条件为 `new_text != old_text || output_encoding != input_encoding`。
- **`*.bak` 不得作为输入**：备份是批处理自己的产物，若不排除，第二次运行会产出 `x.txt.bak.bak`、「备份」语义也随之破坏。枚举阶段一律跳过（显式把 `.bak` 当单个输入传入也跳过）。
- **无效路径不致命**：`enumerate_files` 对单个不可访问的路径**静默跳过**（目录不存在 / 权限不足 / 网络盘掉线），由 `run_batch` 统一记入 `errors` 的 `Enumerate` 阶段；其余文件照常处理。错误面板按阶段（`enumerate` / `read` / `process` / `backup` / `write` / `mtime`）染色。
- **逐文件日志必须降级**：`core::encoding` 的「文件读取完成 / 文件写出完成」原为 INFO，而 tracing 的 fmt 订阅器是**全局互斥**的 stdout 写——批处理上万文件时既刷屏又把并行处理串行化（实测 300 文件从 0.12s 退化成 20s，与进度上报的成本叠加）。现降为 DEBUG，并在 `lib.rs` 改用 `EnvFilter`，需要时 `RUST_LOG=debug` 打开；批处理改为收尾一条汇总 INFO。
- **取消**：`batch_cancel` 置位全局 `Arc<AtomicBool>`；`run_batch` 在每个文件**开始前**查一次，已启动的文件会跑完（不做半途中断，避免写出半个文件）。取消后仍返回当前汇总（`cancelled: true`）。
- **Tauri 命令**：`batch_run(req, progress: Channel<BatchProgress>)`、`batch_cancel()`、`batch_plan(req)`（仅枚举、不读盘写盘，供 UI 预览「将处理 N 个文件」）。
- **批处理只做「整理工具流水线」**：规格 §8.3 的步骤抽象直接复用 F-09 的 `PipelineStep`。重编码作为**输入 / 输出编码**选项实现，而不是流水线里的一步——这样「先解码一次、最后编码一次」，中间步骤始终在 `String` 上工作。简繁转换 / 替换表出现在同一流水线里属于后续扩展。
- **错误总数取自进度快照的计数，而不是错误列表长度**：合并上报（见上）使每个快照只带「本次新增的最后一条错误」，运行中前端的错误列表是压缩过的。UI 用快照的 `errors` 字段显示总数、列表只用于展示，结束后以 `Finished` 报告的完整清单覆盖。规格 §8.4「实时显示错误列表」在运行中为「最近若干条 + 准确总数」。
- **错误面板条目上限**：列表最多渲染 20 条（`errors.slice(-20)`），超出部分以「… 运行中已累计 N 条，结束后显示完整清单」提示；结束后的完整清单同样按 20 条截断展示，但总数与 `report.errors` 始终一致。

---

## F-09 文本整理工具集

将 TextPro §6–§10、§11 中大部分"转换"工具集中实现。每个工具在 Rust 端是一个 `pipeline_step`，在前端是一个工具按钮：

| 名称 | 模块 | 备注 |
|------|------|------|
| 删除半角字符 | `remove_half_width` | 选项三种模式 |
| 转半角 | `full_to_half` | 全角字母数字 → 半角；全角空格 → 两个半角 |
| 转全角 | `half_to_full` | 单选项：是否转换字母数字；是否合并半角空格 |
| 规范行首 | `normalize_line_head` | 行首两全角空格 |
| 删除行末空格 | `trim_line_end` | 同时处理半 / 全角 |
| 删除段内回车 | `remove_intra_line_breaks` | 选项：保留连续换行、新段以双空格开始 |
| 按行排序 | `sort_lines` | 默认按 Unicode 排序，扩展可拼音 / 笔画 |
| 删除重复行 | `dedup_lines` | 仅保留首次出现 |
| 删除空行 | `remove_empty_lines` | 含全 / 半角空格行 |
| 段间空一行 | `insert_blank_between` | 反向；**段 = 一个非空行**（v0.5：补缺失空行 + 合并多余空行） |
| 简单排版 | `simple_layout` | 删除空行 + 规范行首 + 删除行末空格 |
| 自动分段 | `auto_segment` | 三选项 |
| 控制行宽 | `control_width` | 半角字符数为单位 |
| 匹配括号 | `match_brackets` | 检查 + 提示 |
| 括号嵌套转换 | `fix_brackets` | 自动修复 |
| 半角引号转全角 | `half_quote_to_full` | 区分前后 |
| 竖排符号横转 | `vertical_to_horizontal` | |
| 删除行首空格 | `trim_line_head` | |

### v0.9 新增：5 个排版类工具 + 1 个高频直点项

| 名称 | 模块 | 备注 |
|------|------|------|
| 规范标点 | `normalize_punctuation` | 按 GB/T 15834-2011：引号体系（大陆 “”‘’ / 港澳台 「」『』 / 不动）、省略号统一 `……`、破折号统一 `——`、中文语境里的半角标点转全角、竖排符号横转；可附「括号配对检查 / 嵌套改写」 |
| 网文排版 | `web_novel_layout` | 中英文 / 中数之间补空格（跳过 URL 与行内代码）、去掉全角标点旁的多余空格、清理行尾空格、段首缩进（全角空格个数可调） |
| 中文文案 | `chinese_copywriting` | 中英空格 + 标点后不留空格 + 重复标点合并（`！！`→`！`）+ 省略号 / 破折号 + 数字与单位之间补空格（`100kg`→`100 kg`） |
| 技术文档 | `tech_doc_layout` | Markdown：`#标题`→`# 标题`、列表符号统一 `-`、代码围栏前后补空行、行尾去空格、围栏外的中英空格、末尾补换行；**围栏内部一律不动** |
| 片段处理 | `snippet_process` | 行级批处理：去行首 / 行末空格、删空行、段间空一行、去重、排序（4 种）、删半角字符、合并段内回车——原来散在菜单里的细项收在这里 |
| 删除行首行末空格 | `trim_both` | 一次清两端（原 `trim_line_head` / `trim_line_end` 仍保留，供片段处理与批处理组合） |

各步骤均可作为批处理流水线的一部分复用。

> **v0.9：菜单只露出 11 项。** `pipelines::catalog()` 从 18 项收成 11 项（5 个排版类工具 + 6 个高频直点项），
> 其余 13 个步骤不再各自占一个菜单项，但**能力一条没删**：它们仍可被 `from_id` 构造，
> 单测 `internal_steps_are_still_constructible` 与契约测试盯的就是这件事，批处理（F-08）也照旧选得到。

### 9.1 实现注记（2026-10-15，第五阶段；2026-10-18 v0.5 修订）

> **v0.5 修订：`insert_blank_between` 的「段」定义改了。** 原先按「连续非空行 = 一段」切分（只在遇到真空行时切），于是 `甲\n乙` 被算成 1 段、一个空行都不插——用户实测报「段间空行功能无效」，就是这个原因。现在按「**每个非空行 = 一段**」处理：缺的空行补上，多余的连续空行合并成一个，行尾风格沿用原文（`split_lines` + `dominant_terminator`）。单测 `insert_blank_between_adds_and_collapses` 与 `stage5_contract` 的链路断言已同步。



- **目录驱动**：工具（v0.9 起菜单露出 11 项）的分组、`has_options`（菜单显示「…」）、`inspects_only`（标「仅检查」）与各自的默认选项全部由后端 `pipelines::catalog()` 提供，前端不写死工具清单。
- **带「…」的工具共 11 个**（多于本表显式写了"选项"的 6 个）：`remove_half_width`、`full_to_half`、`half_to_full`、`sort_lines`、`dedup_lines`、`normalize_line_head`、`remove_intra_line_breaks`、`auto_segment`、`control_width`、`fix_brackets`、`simple_layout`。其余 7 个（`trim_line_head`、`trim_line_end`、`remove_empty_lines`、`insert_blank_between`、`vertical_to_horizontal`、`half_quote_to_full`、`match_brackets`）**点一下即以默认选项应用**。
- **行尾符保真**：所有行级工具保留原文的 `\r\n` / `\n` / `\r`，并保留"末尾是否有换行"（`split_lines` 返回 `(内容, 行尾符)` 对）。
- **全半角互转**：`full_to_half` 与 `half_to_full` 共用同一实现（偏移 `+0xFEE0` 双向对称）；默认**只动字母数字与空格**，中文标点 `，。` 不会被变成 `,.`，需要时在同一对话框里显式打开"转换标点"。
- **匹配括号**为纯检查型：返回原文本 + 问题清单（行 / 列从 1 起；三类：多余右括号 / 不匹配 / 未闭合），UI 只提示、不改写正文。
- **括号嵌套转换**只改写半 / 全角圆括号对，`「」『』` 等仅用于计算嵌套深度，因此已符合阶梯样式的文本二次运行不变（幂等）。
- **排序**：当前为 Unicode 升 / 降序与行长度升 / 降序；拼音 / 笔画排序留待后续版本（与 F-11 §11.3 自定义工具栏同期）。
- **组合与复用**：`apply_pipeline_chain` 可串行执行任意步骤——「简单排版」在 Rust 侧即由 删除空行 → 删除行末空格 → 规范行首 三步组合，并在提示条里分步列出各步结果；第七阶段批处理直接复用该命令。
- **作用范围**：与 F-03 一致——有选区只处理选区（提示标「（选区）」），否则整篇；结果经 CodeMirror 精确改写，可 `Ctrl+Z` 撤销。
- **Tauri 命令**：`pipelines_catalog`、`apply_pipeline_step`、`apply_pipeline_chain`、`regex_replace_with_tool`（对每个命中套用工具）。

---

## F-10 统计与导航

### 10.1 字数统计

- 普通字数：CJK 计 1 字、ASCII 计 0.5 字（可切换）。
- 选定文字出现次数：先取当前选区，再全文正则计数。
- 段落数：以 `\n\n` 或一个空行分隔。

### 10.2 转到某行

- 输入行号（1-based）→ 光标跳转，行号越界提示。

### 10.3 选定计数实现要点

- CJK 计数用 `UnicodeBlock` 判断，不采用 char 计数（与 TextPro 行为一致）。

### 10.4 Tauri Commands

```rust
#[tauri::command]
async fn stats_total(text: String, mode: CountMode) -> Stats;

#[tauri::command]
async fn stats_occurrences(text: String, needle: String, opts: RegexOptions) -> OccurReport;

#[tauri::command]
async fn stats_paragraphs(text: String) -> usize;
```

---

## F-11 偏好与快捷键

### 11.1 设置项（持久化 JSON，路径见 PRD）

```ts
type Settings = {
  appearance: {
    fontFamily: string,
    fontSize: number,
    showLineNumber: boolean,
    showToolbar: boolean,
    showStatusBar: boolean,
    theme: 'system' | 'light' | 'dark',
  };
  editor: {
    tabWidth: number,
    insertSpaces: boolean,
    wrap: boolean,
    defaultEncoding: EncodingOrAuto,
    defaultLineEnding: 'lf' | 'crlf' | 'cr',
  };
  conversion: {
    bracketSkip: string,         // 例 "[]"
    preserveConverted: boolean,
  };
  // v0.5：big5UseVariants / big5UseIdeographDesc 已随 u2b1/u2b2 弃用而移除；
  // 不可编码字符策略见 F-02 UnmappablePolicy（Ask / CharRef / ToUtf8）
  compare: {
    defaultStrictness: VariantStrictness,
    ignoreNewlines: boolean,
    ignoreHalfSpace: boolean,
    ignoreFullPunct: boolean,
    ignoreHalfPunct: boolean,
  };
  shortcuts: Record<string, string>; // 例 'cmd+S' → 'file.save'
};
```

**实现注记（第八阶段）**：

- `shortcuts` 是**覆盖表**而非全量快照：缺键＝用注册表默认、空串＝显式解绑、非空＝自定义覆盖；默认键位的唯一来源是前端 `shared/shortcuts.ts` 的命令注册表。
- 比较默认档位字段落地时命名为 `variantStrictness`（规格里的 `defaultStrictness`）：直接复用 F-06 的 `CompareOptions`，与其既有契约保持一致。
- 落盘**原子化** + 坏文件**逐字段恢复**（详见 `03-tech-architecture.md` §七）。

### 11.2 快捷键配置

- 采用**应用内命令分发器**（键位 → 命令 id → handler）+ 自定义 UI 注册。
  - **实现注记（第八阶段）**：未采用原定的 `tauri-plugin-global-shortcut`——那是**系统级全局热键**（应用不在前台也触发），与「应用内菜单快捷键」是两回事。改为前端统一命令分发器，替换早期散落在各组件里的 `window` keydown 监听。
  - 默认键位以 `mod` 令牌书写（macOS = ⌘，其余 = Ctrl），避免 macOS ⌘S / ⌘F 静默失效。
  - 规范键位字符串：修饰键固定顺序 `ctrl → alt → shift → meta`；解析支持「缺键＝默认 / 空串＝显式解绑 / 非空＝覆盖」三态。
- 与系统冲突时给出警告（不可分配）：内置系统保留键黑名单（`Alt+F4` / `Alt+Tab` / macOS ⌘Q 等）在分配时拒绝。

### 11.3 自定义工具栏（搁置）

- 让用户从可用命令列表拖拽到工具栏，每个命令可绑定图标（SVG）。（不做此功能）

---

## 八、测试矩阵

| 模块 | 必备测试 |
|------|---------|
| F-02 编码 | GBK / BIG5 / UTF-8 / UTF-16 双向 + 乱码回退 |
| F-03 简繁 | 词组歧义、长文、未匹配字符 |
| F-04 替换表 | 用户表加载、A/B/C=目标、二次替换 |
| F-05 正则 | 中文类目、转义符、忽略空白 |
| F-06 比较 | 异体字策略、跨行不同步 |
| F-07 合并 | 正则捕获组 + 排序 |
| F-08 批处理 | 200 文件 × 5 步骤、备份回退 |
| F-09 工具集 | 各步骤单元测试 + 端到端 |

---

## 九、附录：数据文件来源

AioTextEditor 沿用 TextPro 内置数据中的**两项**（`fc1`、`fc2`，已转换为开放文本格式，详见[数据字典](./06-data-dictionary.md)），产品不解析任何 TextPro 专属二进制格式。其余不打包：`s2t.dat`/`t2s.dat` 由 OpenCC 取代（v0.3 决策）；`u2b1.dat`/`u2b2.dat` 由 `encoding_rs` 编码互转取代（v0.5 决策）。许可与版权：

> 原始数据文件由 TextPro 作者（佛典网 admin@fodian.net）提供，本项目以继承兼容方式使用，转换后的开放格式数据打包在 `src-tauri/data/legacy/` 目录下，保留原始版权声明。

