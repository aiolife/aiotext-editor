# Generate app icons (32/128/256 PNG + PNG-in-ICO)
# Placeholder icon for stage 1; real icon (assets/icon.svg) replaces in stage 10.
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = 'd:\site\aiotext-editor\src-tauri\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$glyph = [string][char]0x6587   # U+6587 "WEN"

function Make-Png([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 25, 60, 110))
    $g.FillRectangle($bg, 0, 0, $size, $size)

    $fontSize = [int]($size * 0.6)
    $font = New-Object System.Drawing.Font('Microsoft YaHei', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, ($size * 0.04), $size, $size)
    $g.DrawString($glyph, $font, $white, $rect, $fmt)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $bg.Dispose(); $font.Dispose(); $white.Dispose(); $fmt.Dispose()
}

Make-Png 32  "$dir\32x32.png"
Make-Png 128 "$dir\128x128.png"
Make-Png 256 "$dir\128x128@2x.png"

# PNG-in-ICO (Windows Vista+)
$png = [System.IO.File]::ReadAllBytes("$dir\128x128@2x.png")
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]1)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]32)
$bw.Write([UInt32]$png.Length)
$bw.Write([UInt32]22)
$bw.Write($png)
[System.IO.File]::WriteAllBytes("$dir\icon.ico", $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Get-ChildItem $dir | Select-Object Name, Length | Format-Table -AutoSize
