param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$PidFile
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $PidFile)) { exit 0 }
$recordedId = (Get-Content -LiteralPath $PidFile -Raw).Trim()
if ($recordedId -ne [string]$ProcessId) { exit 0 }
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
if ($process -and $process.ExecutablePath -and
    [IO.Path]::GetFullPath($process.ExecutablePath) -eq [IO.Path]::GetFullPath($Executable)) {
    & taskkill.exe /PID $ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 1 }
}
if ((Test-Path -LiteralPath $PidFile) -and
    (Get-Content -LiteralPath $PidFile -Raw).Trim() -eq [string]$ProcessId) {
    Remove-Item -LiteralPath $PidFile -Force
}
