# modulus-computer-use Windows control backend.
# Invoked per action by win-control.ts as:
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-control.ps1 <command> [args...]
# Built-in .NET only (System.Drawing + user32 P-Invoke) so there is nothing to
# compile or install. Capture writes a PNG and prints "<width> <height>";
# foreground prints compact JSON {process,title}; input commands print nothing.
# Text/keys arrive base64-encoded (UTF-8) so arbitrary content survives argv.

param(
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$A1,
  [string]$A2,
  [string]$A3,
  [string]$A4
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CU {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, WHEEL = 0x0800;
}
"@

function Move-To([int]$x, [int]$y) { [CU]::SetCursorPos($x, $y) | Out-Null }
function Click-Left { [CU]::mouse_event([CU]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [CU]::mouse_event([CU]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero) }
function Click-Right { [CU]::mouse_event([CU]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [CU]::mouse_event([CU]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero) }
# Reinterpret a signed wheel delta as the unsigned DWORD mouse_event expects.
function Wheel-Delta([int]$d) { return [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes($d), 0) }

switch ($Command) {
  'capture' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $bmp.Save($A1, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $g.Dispose()
      $bmp.Dispose()
    }
    Write-Output "$($b.Width) $($b.Height)"
  }
  'foreground' {
    $h = [CU]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [CU]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    $procId = 0
    [CU]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $name = ''
    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
    @{ process = $name.ToLower(); title = $sb.ToString() } | ConvertTo-Json -Compress
  }
  'click' {
    Move-To ([int]$A1) ([int]$A2)
    Start-Sleep -Milliseconds 30
    switch ($A3) {
      'right' { Click-Right }
      'double' { Click-Left; Start-Sleep -Milliseconds 70; Click-Left }
      default { Click-Left }
    }
  }
  'move' {
    Move-To ([int]$A1) ([int]$A2)
  }
  'type' {
    $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($A1))
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 50
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  'key' {
    $keys = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($A1))
    [System.Windows.Forms.SendKeys]::SendWait($keys)
  }
  'scroll' {
    # One wheel notch is 120 units; $A2 is the tick count (positive = up).
    $delta = [int]$A2 * 120
    [CU]::mouse_event([CU]::WHEEL, 0, 0, (Wheel-Delta $delta), [UIntPtr]::Zero)
  }
  'drag' {
    Move-To ([int]$A1) ([int]$A2)
    Start-Sleep -Milliseconds 60
    [CU]::mouse_event([CU]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    Move-To ([int]$A3) ([int]$A4)
    Start-Sleep -Milliseconds 80
    [CU]::mouse_event([CU]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  default {
    throw "unknown command: $Command"
  }
}
