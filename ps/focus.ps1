# Force-foreground a window by process name. Used by tests and the demo path.
# Usage: powershell -File focus.ps1 -ProcessName notepad
param([string]$ProcessName = "notepad")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PieFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public static bool Force(IntPtr hWnd) {
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint myThread = GetCurrentThreadId();
        AttachThreadInput(myThread, fgThread, true);
        ShowWindow(hWnd, 9); // SW_RESTORE
        bool ok = SetForegroundWindow(hWnd);
        AttachThreadInput(myThread, fgThread, false);
        return ok;
    }
}
"@

$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $p) { Write-Output "NOTFOUND"; exit 1 }
$ok = [PieFocus]::Force($p.MainWindowHandle)
Write-Output ("FOCUSED=" + $ok)
