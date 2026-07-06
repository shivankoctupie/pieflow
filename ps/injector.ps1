# PieFlow injector sidecar.
# Persistent process. Reads JSON commands (one per line) on stdin, answers JSON on stdout.
# Commands:
#   {"cmd":"type","id":1,"text":"hello"}        type text via SendInput KEYEVENTF_UNICODE
#   {"cmd":"paste","id":2,"text":"hello"}       clipboard paste with clipboard backup/restore
#   {"cmd":"enter","id":3}                      press Enter
#   {"cmd":"copy","id":4}                       send Ctrl+C, return selected text
#   {"cmd":"fg","id":5}                         foreground process name + window title
#   {"cmd":"ping","id":6}
# Must run with -STA for clipboard access.

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PieInput {
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags;
        return i;
    }

    // Release any held modifiers so our synthetic chords are clean.
    public static void ReleaseModifiers() {
        ushort[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        foreach (ushort vk in mods) {
            if ((GetAsyncKeyState(vk) & 0x8000) != 0) {
                INPUT[] up = { KeyInput(vk, 0, KEYEVENTF_KEYUP) };
                SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
            }
        }
    }

    // Batch the whole string into large SendInput calls. Sending char-by-char
    // lets other input interleave and some controls garble the stream.
    public static void TypeText(string text) {
        var list = new System.Collections.Generic.List<INPUT>();
        foreach (char c in text) {
            if (c == '\r') continue;
            if (c == '\n') {
                list.Add(KeyInput(0x0D, 0, 0));
                list.Add(KeyInput(0x0D, 0, KEYEVENTF_KEYUP));
            } else {
                list.Add(KeyInput(0, c, KEYEVENTF_UNICODE));
                list.Add(KeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            if (list.Count >= 128) FlushInputs(list);
        }
        FlushInputs(list);
    }

    static void FlushInputs(System.Collections.Generic.List<INPUT> list) {
        if (list.Count == 0) return;
        SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        list.Clear();
        System.Threading.Thread.Sleep(8);
    }

    public static void PressKey(ushort vk) {
        INPUT[] seq = {
            KeyInput(vk, 0, 0),
            KeyInput(vk, 0, KEYEVENTF_KEYUP)
        };
        SendInput(2, seq, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Chord(ushort mod, ushort vk) {
        INPUT[] seq = {
            KeyInput(mod, 0, 0),
            KeyInput(vk, 0, 0),
            KeyInput(vk, 0, KEYEVENTF_KEYUP),
            KeyInput(mod, 0, KEYEVENTF_KEYUP)
        };
        SendInput(4, seq, Marshal.SizeOf(typeof(INPUT)));
    }

    public static string ForegroundInfo() {
        IntPtr h = GetForegroundWindow();
        uint pid; GetWindowThreadProcessId(h, out pid);
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        string exe = "";
        try { exe = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
        return exe + "\u0001" + sb.ToString();
    }
}
"@

function Emit($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-ClipboardSafe {
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            return [System.Windows.Forms.Clipboard]::GetText()
        }
    } catch {}
    return $null
}

function Set-ClipboardSafe([string]$text) {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            if ($null -eq $text -or $text -eq "") { [System.Windows.Forms.Clipboard]::Clear() }
            else { [System.Windows.Forms.Clipboard]::SetText($text) }
            return $true
        } catch { Start-Sleep -Milliseconds 50 }
    }
    return $false
}

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Emit @{ event = "ready" }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq "") { continue }
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        switch ($req.cmd) {
            "ping" { Emit @{ id = $id; ok = $true; event = "pong" } }
            "type" {
                [PieInput]::ReleaseModifiers()
                Start-Sleep -Milliseconds 30
                [PieInput]::TypeText($req.text)
                Emit @{ id = $id; ok = $true }
            }
            "paste" {
                $backup = Get-ClipboardSafe
                if (-not (Set-ClipboardSafe $req.text)) {
                    Emit @{ id = $id; ok = $false; error = "clipboard set failed" }
                    break
                }
                [PieInput]::ReleaseModifiers()
                Start-Sleep -Milliseconds 40
                [PieInput]::Chord(0x11, 0x56)   # Ctrl+V
                Start-Sleep -Milliseconds 250
                if ($null -ne $backup) { Set-ClipboardSafe $backup | Out-Null }
                Emit @{ id = $id; ok = $true }
            }
            "enter" {
                [PieInput]::ReleaseModifiers()
                Start-Sleep -Milliseconds 30
                [PieInput]::PressKey(0x0D)
                Emit @{ id = $id; ok = $true }
            }
            "copy" {
                $backup = Get-ClipboardSafe
                Set-ClipboardSafe "" | Out-Null
                [PieInput]::ReleaseModifiers()
                Start-Sleep -Milliseconds 30
                [PieInput]::Chord(0x11, 0x43)   # Ctrl+C
                Start-Sleep -Milliseconds 300
                $sel = Get-ClipboardSafe
                if ($null -ne $backup) { Set-ClipboardSafe $backup | Out-Null }
                Emit @{ id = $id; ok = $true; text = $sel }
            }
            "fg" {
                $info = [PieInput]::ForegroundInfo().Split([char]1, 2)
                Emit @{ id = $id; ok = $true; exe = $info[0]; title = $info[1] }
            }
            "quit" { Emit @{ id = $id; ok = $true }; exit 0 }
            default { Emit @{ id = $id; ok = $false; error = "unknown cmd" } }
        }
    } catch {
        Emit @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}
