# 第一阶段：迁移数据文件到 src-tauri/data/
$ErrorActionPreference = 'Stop'
$root = 'd:\site\aiotext-editor'

# 1) TextPro 开放文本数据（fc1/fc2，随包分发；u2b1/u2b2 已弃用仅存档于 data-extracted/）
$legacy = "$root\src-tauri\data\legacy"
New-Item -ItemType Directory -Force -Path $legacy | Out-Null
Copy-Item "$root\data-extracted\fc1.txt" $legacy -Force
Copy-Item "$root\data-extracted\fc2.txt" $legacy -Force

# 2) 内置示例替换表（F-04：首次启动复制到用户目录，默认禁用）
$builtin = "$root\src-tauri\data\builtin-tables"
New-Item -ItemType Directory -Force -Path $builtin | Out-Null

@"
# 简繁习惯用字示例表（TextPro 风格：`A/B=目标`，一行一条）
# 仅供参考，可在"替换表"对话框中编辑（docs/02-functional-spec.md F-04）
裏/裡=里
衹/祗=只
彷/彷=彷徨
"@ | Set-Content "$builtin\simplified-variants.tab" -Encoding utf8

@"
# 古籍/佛经用字习惯示例表
# 左边为常见印刷形，右边为佛经电子化整理常用形
於/于=於
群/羣=群
"@ | Set-Content "$builtin\ancient-usage.tab" -Encoding utf8

@"
# 中文标点归一示例表（半角→全角）
,/，
;/；
:/：
"@ | Set-Content "$builtin\cn-punct.tab" -Encoding utf8

Get-ChildItem "$root\src-tauri\data" -Recurse -File | Select-Object FullName, Length | Format-Table -AutoSize
