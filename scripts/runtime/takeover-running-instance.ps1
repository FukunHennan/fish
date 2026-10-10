$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$runtime = Join-Path $root "controller\.runtime"
$controllerExe = [IO.Path]::GetFullPath((Join-Path $runtime "fish-controller.exe"))
$nextControllerExe = [IO.Path]::GetFullPath((Join-Path $runtime "fish-controller.next.exe"))
$cloudflaredExe = [IO.Path]::GetFullPath((Join-Path $runtime "cloudflared.exe"))
$launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\start.bat"))
$watcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "watch-controller.ps1"))
$currentLauncherPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId

function Get-ProcessPath($process) {
    if (-not $process.ExecutablePath) { return "" }
    try { return [IO.Path]::GetFullPath($process.ExecutablePath) } catch { return "" }
}

function Stop-ProcessTree([int] $processId, [string] $label) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
    Write-Output "[INFO] Stopping previous $label (PID $processId)..."
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
}

$processes = @(Get-CimInstance Win32_Process)

# Stop the old supervisor first. Otherwise its restart loop would launch a new
# controller five seconds after the old controller is terminated.
foreach ($process in $processes) {
    if ($process.ProcessId -eq $currentLauncherPid -or $process.Name -ne "cmd.exe") { continue }
    $command = [string]$process.CommandLine
    if ($command.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-ProcessTree $process.ProcessId "Fish startup supervisor"
    }
}

# A supervisor attached to an already running controller has no start.bat
# parent. Stop it before stopping the controller so it cannot restart it.
foreach ($process in $processes) {
    if ($process.Name -notin @("powershell.exe", "pwsh.exe")) { continue }
    $command = [string]$process.CommandLine
    if ($command.IndexOf("-File", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $command.IndexOf($watcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $command.IndexOf($controllerExe, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-ProcessTree $process.ProcessId "Fish Controller supervisor"
    }
}

# Match resolved executable paths so an unrelated process is never killed just
# because it happens to listen on the same port.
$processes = @(Get-CimInstance Win32_Process)
foreach ($process in $processes) {
    $path = Get-ProcessPath $process
    if ($path.Equals($controllerExe, [StringComparison]::OrdinalIgnoreCase) -or
        $path.Equals($nextControllerExe, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-ProcessTree $process.ProcessId "Fish Controller and vision service"
    }
}
foreach ($process in $processes) {
    $path = Get-ProcessPath $process
    if ($path.Equals($cloudflaredExe, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-ProcessTree $process.ProcessId "Cloudflare Tunnel"
    }
}

$deadline = [DateTime]::UtcNow.AddSeconds(8)
do {
    $occupied = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in 8081, 8091 })
    if (-not $occupied) { break }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)

Remove-Item -LiteralPath (Join-Path $runtime "cloudflared.pid") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtime "fish-controller.pid") -Force -ErrorAction SilentlyContinue
