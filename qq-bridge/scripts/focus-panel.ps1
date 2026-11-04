param([switch]$Star, [switch]$Unfullscreen, [switch]$Close, [switch]$Topmost)
# 面板窗口 / 星图窗口的处置
#   默认          = 全屏 + 置前 + 置顶：全屏就置前(0)；不是全屏就关掉重开(2)；没有窗口(1)
#   -Unfullscreen = 退出全屏（发 F11），之后仍保持置顶(4)
#   -Close        = WM_CLOSE 关掉窗口(3)
#   -Topmost      = 只置顶，绝不关窗口(5)
#   -Star         = 目标换成「记忆星图」
#
# 用 EnumWindows 枚举**所有顶层窗口**按标题找，而不是 Get-Process 的 MainWindowTitle：
# 两个窗口共用同一个 --user-data-dir 时属于同一个 Edge 实例，MainWindowTitle 只会给出其中一个，
# 于是星图窗口经常"找不到"（这就是星图不置顶的原因）。
#
# 注意：文件必须是 UTF-8 BOM，PowerShell 5.1 才会正确读里面的中文标题。
$ErrorActionPreference = 'SilentlyContinue'

$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class W {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<IntPtr> Find(string needle) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp

if ($Star) { $needle = '记忆星图' } else { $needle = '小鲸鱼的控制终端' }
$handles = [W]::Find($needle)
if ($handles.Count -eq 0) { exit 1 }

$h = $handles[0]
$screenW = [W]::GetSystemMetrics(0)
$screenH = [W]::GetSystemMetrics(1)
$TOPMOST_FLAGS = 0x0001 -bor 0x0002 -bor 0x0010   # NOSIZE | NOMOVE | NOACTIVATE
$HWND_TOPMOST = [IntPtr](-1)

function Is-Fullscreen([IntPtr]$hw) {
  $r = New-Object W+RECT
  if (-not [W]::GetWindowRect($hw, [ref]$r)) { return $false }
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  return ($w -ge ($screenW - 4) -and $ht -ge ($screenH - 4))
}

function Focus-Window([IntPtr]$hw) {
  [W]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)     # Alt down：解前台锁
  $fgPid = 0
  $ftid = [W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [ref]$fgPid)
  $tid = [W]::GetCurrentThreadId()
  if ($ftid -ne 0 -and $ftid -ne $tid) { [void][W]::AttachThreadInput($ftid, $tid, $true) }
  [void][W]::BringWindowToTop($hw)
  [void][W]::SwitchToThisWindow($hw, $true)
  [void][W]::SetForegroundWindow($hw)
  [void][W]::SetWindowPos($hw, $HWND_TOPMOST, 0, 0, 0, 0, $TOPMOST_FLAGS)
  if ($ftid -ne 0 -and $ftid -ne $tid) { [void][W]::AttachThreadInput($ftid, $tid, $false) }
  [W]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
}

if ($Close) {
  [void][W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  exit 3
}

if ($Topmost) {
  [void][W]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $TOPMOST_FLAGS)
  exit 5
}

if ($Unfullscreen) {
  if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9) }
  Focus-Window $h
  Start-Sleep -Milliseconds 220
  [W]::keybd_event(0x7A, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [W]::keybd_event(0x7A, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 260
  [void][W]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $TOPMOST_FLAGS)
  exit 4
}

if (-not (Is-Fullscreen $h)) {
  [void][W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  exit 2
}

if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9) }
Focus-Window $h
Start-Sleep -Milliseconds 140
if ([W]::GetForegroundWindow() -eq $h) { exit 0 }
exit 6
