# Generate the app icon master PNG (assets/icon.png, 1024x1024).
#
# Why a separate step: `tauri icon` needs one big square source and produces the whole
# set for us -- 32x32/128x128/128x128@2x.png, icon.ico (Windows), icon.icns (macOS),
# icon.png and the Windows Store logos. Hand-writing .icns (which is a container of
# several PNG sizes) is not worth it, so:
#
#   1. pwsh scripts/gen-app-icon.ps1        # master PNG  <- this file
#   2. npx tauri icon assets/icon.png      # full icon set into src-tauri/icons/
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = 'd:\site\aiotext-editor\assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'icon.png'

$size = 1024
$radius = [int]($size * 0.22)          # rounded-square corner radius
$brand = [System.Drawing.Color]::FromArgb(255, 25, 60, 110)   # #19386E
$glyph = [string][char]0x6587          # U+6587 "WEN"

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# rounded-square background
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()

$bg = New-Object System.Drawing.SolidBrush($brand)
$g.FillPath($bg, $path)

# a slightly lighter inner border for depth
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 255, 255, 255), [single]($size * 0.012))
$g.DrawPath($pen, $path)

# the glyph
$font = New-Object System.Drawing.Font('Microsoft YaHei', [single]($size * 0.58), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, ($size * 0.02), $size, $size)
$g.DrawString($glyph, $font, $white, $rect, $fmt)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $bg.Dispose(); $pen.Dispose(); $path.Dispose(); $font.Dispose(); $white.Dispose(); $fmt.Dispose()

Get-Item $out | Select-Object FullName, Length | Format-Table -AutoSize
