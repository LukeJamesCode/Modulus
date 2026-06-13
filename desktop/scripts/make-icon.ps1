# Renders the panel helix (src/panel/web/favicon.svg) with System.Drawing and
# packs a multi-size icon.ico for the desktop shell. PNG-compressed ICO entries
# are valid on Vista+, which covers every OS the app supports. Re-run after
# changing the favicon; the output is committed at ModulusDesktop/Assets/icon.ico.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assets = Join-Path $PSScriptRoot '..\ModulusDesktop\Assets'
$outIco = Join-Path $assets 'icon.ico'
$cache = Join-Path $PSScriptRoot '..\.cache'
New-Item -ItemType Directory -Force $cache | Out-Null
$outPreview = Join-Path $cache 'icon-preview.png'

function New-HelixPng([int]$size) {
    $s = $size / 64.0
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Cross-rungs first (under the strands), matching the SVG draw order.
    $rung = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(140, 0xC7, 0x7B, 0xE0), (2.6 * $s))
    $rung.StartCap = 'Round'; $rung.EndCap = 'Round'
    foreach ($r in @(@(24.5, 39.5, 11), @(21, 43, 18), @(24.5, 39.5, 25), @(24.5, 39.5, 39), @(21, 43, 46), @(24.5, 39.5, 53))) {
        $g.DrawLine($rung, [single]($r[0] * $s), [single]($r[2] * $s), [single]($r[1] * $s), [single]($r[2] * $s))
    }
    $rung.Dispose()

    # Each SVG quadratic (P0, C, P2) becomes a cubic for AddBezier. Scalar args
    # per segment — PowerShell flattens nested arrays unpredictably.
    function AddQuad($path, [double]$x0, [double]$y0, [double]$cx, [double]$cy, [double]$x2, [double]$y2) {
        $p0 = New-Object System.Drawing.PointF([single]($x0 * $s), [single]($y0 * $s))
        $c = New-Object System.Drawing.PointF([single]($cx * $s), [single]($cy * $s))
        $p2 = New-Object System.Drawing.PointF([single]($x2 * $s), [single]($y2 * $s))
        $cp1 = New-Object System.Drawing.PointF([single]($p0.X + 2 * ($c.X - $p0.X) / 3), [single]($p0.Y + 2 * ($c.Y - $p0.Y) / 3))
        $cp2 = New-Object System.Drawing.PointF([single]($p2.X + 2 * ($c.X - $p2.X) / 3), [single]($p2.Y + 2 * ($c.Y - $p2.Y) / 3))
        $path.AddBezier($p0, $cp1, $cp2, $p2)
    }

    function StrandPen([System.Drawing.Color]$from, [System.Drawing.Color]$to, [System.Drawing.PointF]$a, [System.Drawing.PointF]$b) {
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($a, $b, $from, $to)
        $pen = New-Object System.Drawing.Pen($brush, (6.5 * $s))
        $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
        return $pen
    }

    # Pink strand: M32 4 Q60 18 32 32 Q4 46 32 60, gradient (0,0)->(64,64).
    $pink = StrandPen ([System.Drawing.Color]::FromArgb(0xFF, 0x7A, 0xB8)) ([System.Drawing.Color]::FromArgb(0xE9, 0x55, 0x9F)) `
        (New-Object System.Drawing.PointF(0, 0)) (New-Object System.Drawing.PointF($size, $size))
    $pa = New-Object System.Drawing.Drawing2D.GraphicsPath
    AddQuad $pa 32 4 60 18 32 32
    AddQuad $pa 32 32 4 46 32 60
    $g.DrawPath($pink, $pa)
    $pa.Dispose(); $pink.Dispose()

    # Purple strand: M32 4 Q4 18 32 32 Q60 46 32 60, gradient (64,0)->(0,64).
    $purple = StrandPen ([System.Drawing.Color]::FromArgb(0xB7, 0x8A, 0xFF)) ([System.Drawing.Color]::FromArgb(0x9D, 0x6B, 0xFF)) `
        (New-Object System.Drawing.PointF($size, 0)) (New-Object System.Drawing.PointF(0, $size))
    $pb = New-Object System.Drawing.Drawing2D.GraphicsPath
    AddQuad $pb 32 4 4 18 32 32
    AddQuad $pb 32 32 60 46 32 60
    $g.DrawPath($purple, $pb)
    $pb.Dispose(); $purple.Dispose()

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @{}
foreach ($size in $sizes) { $pngs[$size] = New-HelixPng $size }

# ICO container: ICONDIR + one ICONDIRENTRY per size + raw PNG blobs.
$fs = [System.IO.File]::Create($outIco)
$w = New-Object System.IO.BinaryWriter($fs)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($size in $sizes) {
    $bytes = $pngs[$size]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $w.Write([byte]$dim); $w.Write([byte]$dim)   # width, height (0 = 256)
    $w.Write([byte]0); $w.Write([byte]0)         # palette, reserved
    $w.Write([uint16]1); $w.Write([uint16]32)    # planes, bpp
    $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset)
    $offset += $bytes.Length
}
foreach ($size in $sizes) { $w.Write($pngs[$size]) }
$w.Dispose(); $fs.Dispose()

[System.IO.File]::WriteAllBytes($outPreview, $pngs[256])
Write-Output "wrote $outIco ($((Get-Item $outIco).Length) bytes) + preview png"
