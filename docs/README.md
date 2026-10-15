# AioTextEditor 文档总览

> 本目录收录产品立项的全部文档。
> **当前基线：v0.5**（2026-10-14，弃用 u2b1/u2b2 BIG5 回退表，编码互转改用 encoding_rs，详见 [CHANGELOG.md](./CHANGELOG.md)）。

| 文档 | 内容 |
|------|------|
| [PRD.md](./PRD.md) | 产品需求文档，含定位、范围、验收 |
| [02-functional-spec.md](./02-functional-spec.md) | 功能模块详细说明（用户故事、契约、命令） |
| [03-tech-architecture.md](./03-tech-architecture.md) | 技术架构设计、模块划分、数据流 |
| [04-ui-ux.md](./04-ui-ux.md) | UI / UX 设计要点、菜单、对话框 |
| [05-roadmap.md](./05-roadmap.md) | 项目结构与开发路线图 |
| [06-data-dictionary.md](./06-data-dictionary.md) | 数据字典：TextPro 数据文件逆向与开放格式规范 |
| [CHANGELOG.md](./CHANGELOG.md) | 文档重大变更记录 |

## 立项脚本

本项目从三个来源提炼：

1. **`../TextPro65/`**：原始 Windows 程序的二进制、菜单与数据表。
2. **https://github.com/imoling/iml-editor-lite**：Tauri 2 壳层 + React + CodeMirror 的工程基线。
3. **https://github.com/BYVoid/OpenCC**：繁简转换引擎（v0.2 引入）。

## 阅读建议

- 第一次进入项目：先看 `PRD.md`。
- 设计具体功能：跳到 `02-functional-spec.md` 找 F-xx。
- 设计界面：`04-ui-ux.md`。
- 想参与编码：`03-tech-architecture.md` + `05-roadmap.md`。
- 追溯变更：`CHANGELOG.md`。
