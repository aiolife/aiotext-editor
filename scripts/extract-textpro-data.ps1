# =====================================================================
# AioTextEditor - TextPro 数据文件提取工具
# =====================================================================
# 用途：将 TextPro 6.5 的专属二进制数据文件提取为任何通用编辑器
#       都能打开的开放文本格式（UTF-8 with BOM）。
#
# 来源 -> 产物：
#   data/fc1.dat  -> data-extracted/fc1.txt   完全等同异体字组表（1003 组）
#   data/fc2.dat  -> data-extracted/fc2.txt   部分等同异体字组表（10579 组）
#   data/u2b1.dat -> data-extracted/u2b1.tsv  BIG5 异体字回退表（2122 条）
#   data/u2b2.dat -> data-extracted/u2b2.tsv  BIG5 组字式回退表（995 条）
#
# 格式说明详见 docs/06-data-dictionary.md。
# 验证：提取条目数与源文件头部记录数完全一致；
#       fc1 含 TextPro 文档示例组"兔兎"；fc2 含"奔…逩"组长组。
# =====================================================================

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = 'd:\site\aiotext-editor\TextPro65\data'
$out = 'd:\site\aiotext-editor\data-extracted'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

function Read-U32($b, $o) { return [BitConverter]::ToUInt32($b, $o) }

# ---------------------------------------------------------------
# TEXTPRO 容器（u2b1/u2b2）：
#   头部: "TEXTPRO"UTF16LE + u16 0 + u32 ver + u32 count + u32 ? + u32 0
#         + u32 descLen + desc[descLen]
#   记录: u32 keyLen(=2) | u32 keyCode | u32 valLen | value[valLen] | u16 pad
#   记录区从 descEnd + 6 字节对齐填充后开始
# ---------------------------------------------------------------
function Extract-TextPro($file) {
    $b = [System.IO.File]::ReadAllBytes("$src\$file")
    $descLen = Read-U32 $b 0x20
    Write-Host ("{0}: desc=[{1}]" -f $file, [System.Text.Encoding]::Unicode.GetString($b, 0x24, $descLen))

    $pos = 0x24 + $descLen + 6
    $entries = New-Object System.Collections.Generic.List[string]
    while ($pos + 12 -le $b.Length) {
        $kl = Read-U32 $b $pos
        if ($kl -ne 2) { break }   # 所有键均为单个 UTF-16 字符
        $vl = Read-U32 $b ($pos + 8)
        if ($vl -lt 2 -or $vl -gt 4096 -or ($vl % 2) -ne 0 -or ($pos + 12 + $vl + 2) -gt $b.Length) { break }
        $key = [System.Text.Encoding]::Unicode.GetString($b, $pos + 4, 2)
        $val = [System.Text.Encoding]::Unicode.GetString($b, $pos + 12, $vl)
        $entries.Add("$key`t$val")
        $pos += 12 + $vl + 2
    }
    Write-Host ("  {0} 条记录（记录区止于 0x{1:X}）" -f $entries.Count, $pos)
    return ,$entries
}

foreach ($pair in @(@('u2b1.dat','u2b1.tsv'), @('u2b2.dat','u2b2.tsv'))) {
    $entries = Extract-TextPro $pair[0]
    if ($entries.Count -eq 0) { throw "解析失败: $($pair[0])" }
    [System.IO.File]::WriteAllLines("$out\$($pair[1])", $entries, (New-Object System.Text.UTF8Encoding $true))
}

# ---------------------------------------------------------------
# fc1/fc2：每字节 XOR 0x20 去混淆 -> UTF-16LE + BOM，CRLF 分行
# 每行一个异体字组（组内字符直接连排，首字符为最常用形）
# ---------------------------------------------------------------
foreach ($f in @('fc1.dat','fc2.dat')) {
    $bytes = [System.IO.File]::ReadAllBytes("$src\$f")
    $dec = New-Object byte[] $bytes.Length
    for ($i = 0; $i -lt $bytes.Length; $i++) { $dec[$i] = $bytes[$i] -bxor 0x20 }
    $text = [System.Text.Encoding]::Unicode.GetString($dec)
    $text = $text.TrimStart([char]0xFEFF).Replace("`r`n", "`n").Trim("`n")
    $lines = @($text -split "`n" | Where-Object { $_ -ne '' })
    $name = $f -replace '\.dat$', '.txt'
    [System.IO.File]::WriteAllLines("$out\$name", $lines, (New-Object System.Text.UTF8Encoding $true))
    Write-Host ("{0} -> {1}: {2} 组" -f $f, $name, $lines.Count)
}

# 校验和
Get-ChildItem $out | ForEach-Object {
    $h = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash
    Write-Host ("{0}  {1}  ({2} 行)" -f $h, $_.Name, ([System.IO.File]::ReadAllLines($_.FullName)).Count)
}
