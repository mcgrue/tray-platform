$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TrayDesktopNative {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
    $processStartCache = @{}
    function Get-WindowDescriptor([IntPtr] $windowHandle) {
        if (-not [TrayDesktopNative]::IsWindow($windowHandle)) { return $null }
        [uint32] $windowPid = 0
        [void][TrayDesktopNative]::GetWindowThreadProcessId($windowHandle, [ref] $windowPid)
        if ($windowPid -eq 0 -or $windowPid -eq $request.appPid) { return $null }
        if ($processStartCache.ContainsKey($windowPid)) {
            $startedAt = $processStartCache[$windowPid]
            if ($null -eq $startedAt) { return $null }
        } else {
            try {
                $windowProcess = [System.Diagnostics.Process]::GetProcessById($windowPid)
                try { $startedAt = $windowProcess.StartTime.ToUniversalTime().ToString('o') }
                finally { $windowProcess.Dispose() }
                $processStartCache[$windowPid] = $startedAt
            } catch { $processStartCache[$windowPid] = $null; return $null }
        }
        $text = New-Object System.Text.StringBuilder 32768
        [void][TrayDesktopNative]::GetWindowText($windowHandle, $text, $text.Capacity)
        return @{ kind = 'window'; hwnd = $windowHandle.ToInt64().ToString(); pid = $windowPid; processStartedAt = $startedAt; title = $text.ToString() }
    }

    switch ($request.command) {
        'list' {
            $windows = New-Object System.Collections.Generic.List[object]
            $callback = [TrayDesktopNative+EnumWindowsProc] {
                param([IntPtr] $windowHandle, [IntPtr] $data)
                if ([TrayDesktopNative]::IsWindowVisible($windowHandle)) {
                    $descriptor = Get-WindowDescriptor $windowHandle
                    if ($null -ne $descriptor -and $descriptor.title.Length -gt 0) { $windows.Add($descriptor) }
                }
                return $true
            }
            [void][TrayDesktopNative]::EnumWindows($callback, [IntPtr]::Zero)
            $result = @($windows.ToArray())
        }
        'foreground' { $result = Get-WindowDescriptor ([TrayDesktopNative]::GetForegroundWindow()) }
        'activate' {
            $target = $request.destination
            if ($target.kind -ne 'window' -or $target.hwnd -notmatch '^[1-9][0-9]{0,18}$') { throw 'Choose a valid window destination.' }
            $targetHandle = [IntPtr]([long]::Parse($target.hwnd))
            $actual = Get-WindowDescriptor $targetHandle
            if ($null -eq $actual -or $actual.pid -ne $target.pid -or $actual.processStartedAt -cne $target.processStartedAt) {
                throw 'The selected window has closed or changed. Choose its current window again.'
            }
            if ([TrayDesktopNative]::IsIconic($targetHandle)) { [void][TrayDesktopNative]::ShowWindowAsync($targetHandle, 9) }
            [void][TrayDesktopNative]::SetForegroundWindow($targetHandle)
            Start-Sleep -Milliseconds 100
            if ([TrayDesktopNative]::GetForegroundWindow() -ne $targetHandle) {
                throw 'Windows refused to activate this window. Select it from the taskbar or try again.'
            }
            $result = $null
        }
        default { throw 'Unknown desktop operation.' }
    }
    [Console]::Out.WriteLine((@{ ok = $true; result = $result } | ConvertTo-Json -Depth 6 -Compress))
} catch {
    [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress))
}
