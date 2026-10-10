param(
    [Parameter(Mandatory = $true)][string]$ControllerDir,
    [Parameter(Mandatory = $true)][string]$Executable,
    [int]$ExistingProcessId = 0
)

$ErrorActionPreference = "Stop"
$nextExecutable = [IO.Path]::ChangeExtension($Executable, ".next.exe")
$backupExecutable = [IO.Path]::ChangeExtension($Executable, ".previous.exe")

function Get-ControllerRevision {
    $roots = @(
        (Join-Path $ControllerDir "cmd"),
        (Join-Path $ControllerDir "internal")
    )
    $files = @()
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            $files += Get-ChildItem -LiteralPath $root -Recurse -File -Filter "*.go"
        }
    }
    foreach ($name in @("go.mod", "go.sum")) {
        $path = Join-Path $ControllerDir $name
        if (Test-Path -LiteralPath $path) {
            $files += Get-Item -LiteralPath $path
        }
    }
    $description = ($files | Sort-Object FullName | ForEach-Object {
        "{0}|{1}|{2}" -f $_.FullName, $_.Length, $_.LastWriteTimeUtc.Ticks
    }) -join [Environment]::NewLine
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($description)
        # Windows PowerShell 5.1 runs on .NET Framework, which does not expose
        # Convert.ToHexString(). Keep the supervisor compatible with both the
        # built-in powershell.exe and modern pwsh.
        return -join ($sha.ComputeHash($bytes) | ForEach-Object {
            $_.ToString("X2")
        })
    }
    finally {
        $sha.Dispose()
    }
}

function Build-Controller {
    Write-Host "[HOT] Controller source changed; rebuilding..."
    Push-Location $ControllerDir
    try {
        & go build -o $nextExecutable ./cmd/fish-controller
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
            return $false
        }
        return $true
    }
    finally {
        Pop-Location
    }
}

function Start-Controller {
    Write-Host "[HOT] Starting Fish Controller..."
    return Start-Process -FilePath $Executable -WorkingDirectory $ControllerDir -NoNewWindow -PassThru -ErrorAction Stop
}

function Start-ControllerWithRetry([int]$MaximumAttempts = 0) {
    $attempt = 0
    while ($MaximumAttempts -eq 0 -or $attempt -lt $MaximumAttempts) {
        $attempt++
        try {
            $candidate = Start-Controller
            Start-Sleep -Milliseconds 500
            if (-not $candidate.HasExited) { return $candidate }
            Write-Host "[WARN] Fish Controller exited immediately with code $($candidate.ExitCode)."
        }
        catch {
            Write-Host "[WARN] Fish Controller launch failed: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 3
    }
    return $null
}

function Restore-ControllerBackup {
    try {
        Copy-Item -LiteralPath $backupExecutable -Destination $Executable -Force -ErrorAction Stop
        Write-Host "[WARN] Restored the previous Fish Controller binary."
    }
    catch {
        Write-Host "[WARN] Could not restore the previous binary: $($_.Exception.Message)"
    }
}

function Request-GracefulRestart {
    try {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:8081/__dev/restart-controller" -TimeoutSec 3 | Out-Null
        return $true
    }
    catch {
        Write-Host "[WARN] Graceful restart request failed: $($_.Exception.Message)"
        return $false
    }
}

$revision = Get-ControllerRevision
$process = $null
try {
    if ($ExistingProcessId -gt 0) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$ExistingProcessId"
        $listener = Get-NetTCPConnection -State Listen -LocalPort 8081 -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $ExistingProcessId } | Select-Object -First 1
        if (-not $existing -or -not $existing.ExecutablePath -or -not $listener -or
            -not [String]::Equals([IO.Path]::GetFullPath($existing.ExecutablePath),
                [IO.Path]::GetFullPath($Executable), [StringComparison]::OrdinalIgnoreCase)) {
            throw "PID $ExistingProcessId is not the running Fish Controller at $Executable."
        }
        $process = Get-Process -Id $ExistingProcessId -ErrorAction Stop
        Write-Host "[HOT] Attached to running Fish Controller PID $ExistingProcessId."
    }
    else {
        $process = Start-ControllerWithRetry
    }
    while ($true) {
        Start-Sleep -Milliseconds 750
        if ($process.HasExited) {
            $code = $process.ExitCode
            Write-Host "[WARN] Fish Controller exited with code $code; restarting in 5 seconds."
            Start-Sleep -Seconds 5
            $process = Start-ControllerWithRetry
            $revision = Get-ControllerRevision
            continue
        }

        $current = Get-ControllerRevision
        if ($current -eq $revision) {
            continue
        }
        Start-Sleep -Milliseconds 500
        $stable = Get-ControllerRevision
        if ($stable -ne $current) {
            continue
        }
        if (-not (Build-Controller)) {
            Write-Host "[WARN] Controller rebuild failed; keeping the current process running."
            $revision = $stable
            continue
        }

        try {
            Copy-Item -LiteralPath $Executable -Destination $backupExecutable -Force -ErrorAction Stop
        }
        catch {
            Write-Host "[WARN] Could not back up the running controller; keeping it online: $($_.Exception.Message)"
            Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
            $revision = $stable
            continue
        }

        if (-not (Request-GracefulRestart)) {
            Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $backupExecutable -Force -ErrorAction SilentlyContinue
            $revision = $stable
            continue
        }
        if (-not $process.WaitForExit(10000)) {
            Write-Host "[WARN] Controller did not exit after graceful restart request; keeping the current binary."
            Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $backupExecutable -Force -ErrorAction SilentlyContinue
            $revision = $stable
            continue
        }

        $replaced = $false
        try {
            Move-Item -LiteralPath $nextExecutable -Destination $Executable -Force -ErrorAction Stop
            $replaced = $true
        }
        catch {
            Write-Host "[WARN] Controller replacement failed: $($_.Exception.Message)"
            Restore-ControllerBackup
        }
        if ($replaced) {
            $process = Start-ControllerWithRetry -MaximumAttempts 5
            if ($null -eq $process) {
                Write-Host "[WARN] New controller could not start; rolling back."
                Restore-ControllerBackup
            }
        }
        if ($null -eq $process -or $process.HasExited) {
            $process = Start-ControllerWithRetry
        }
        Remove-Item -LiteralPath $backupExecutable -Force -ErrorAction SilentlyContinue
        $revision = $stable
        Write-Host "[HOT] Controller reloaded."
    }
}
finally {
    if ($null -ne $process -and -not $process.HasExited) {
        Request-GracefulRestart | Out-Null
        if (-not $process.WaitForExit(5000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupExecutable -Force -ErrorAction SilentlyContinue
}
