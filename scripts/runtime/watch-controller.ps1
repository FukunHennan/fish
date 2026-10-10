param(
    [Parameter(Mandatory = $true)][string]$ControllerDir,
    [Parameter(Mandatory = $true)][string]$Executable,
    [int]$ExistingProcessId = 0
)

$ErrorActionPreference = "Stop"
$nextExecutable = [IO.Path]::ChangeExtension($Executable, ".next.exe")
$restartHelper = Join-Path $PSScriptRoot "request-controller-restart.ps1"

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

function Build-Controller([string]$OutputPath) {
    Write-Host "[HOT] Controller source changed; rebuilding..."
    Push-Location $ControllerDir
    try {
        & go build -o $OutputPath ./cmd/fish-controller
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        return $true
    }
    finally {
        Pop-Location
    }
}

function Start-Controller([string]$Path) {
    Write-Host "[HOT] Starting Fish Controller..."
    return Start-Process -FilePath $Path -WorkingDirectory $ControllerDir -NoNewWindow -PassThru -ErrorAction Stop
}

function Start-ControllerWithRetry([string]$Path, [int]$MaximumAttempts = 0) {
    $attempt = 0
    while ($MaximumAttempts -eq 0 -or $attempt -lt $MaximumAttempts) {
        $attempt++
        try {
            $candidate = Start-Controller -Path $Path
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

function Request-GracefulRestart {
    try {
        if (-not (Test-Path -LiteralPath $restartHelper -PathType Leaf)) {
            throw "Restart helper is missing: $restartHelper"
        }
        $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $restartHelper + '"'))
        Start-Process -FilePath "powershell.exe" -ArgumentList $arguments `
            -WorkingDirectory $ControllerDir -WindowStyle Hidden -ErrorAction Stop | Out-Null
        return $true
    }
    catch {
        Write-Host "[WARN] Graceful restart request failed: $($_.Exception.Message)"
        return $false
    }
}

function Wait-ControllerExit([int]$ProcessId, [int]$TimeoutMilliseconds) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

$revision = Get-ControllerRevision
$process = $null
$runningExecutable = $Executable
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
        $process = Start-ControllerWithRetry -Path $runningExecutable
    }
    while ($true) {
        Start-Sleep -Milliseconds 750
        if ($process.HasExited) {
            $code = $process.ExitCode
            Write-Host "[WARN] Fish Controller exited with code $code; restarting in 5 seconds."
            Start-Sleep -Seconds 5
            $process = Start-ControllerWithRetry -Path $runningExecutable
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
        $candidateExecutable = if ([String]::Equals($runningExecutable, $Executable,
            [StringComparison]::OrdinalIgnoreCase)) { $nextExecutable } else { $Executable }
        if (-not (Build-Controller -OutputPath $candidateExecutable)) {
            Write-Host "[WARN] Controller rebuild failed; keeping the current process running."
            $revision = $stable
            continue
        }

        if (-not (Request-GracefulRestart)) {
            $revision = $stable
            continue
        }
        Write-Host "[HOT] Waiting for controller PID $($process.Id) to stop..."
        if (-not (Wait-ControllerExit -ProcessId $process.Id -TimeoutMilliseconds 10000)) {
            Write-Host "[WARN] Controller did not exit after graceful restart request; keeping the current binary."
            $revision = $stable
            continue
        }
        Write-Host "[HOT] Previous controller stopped; starting $candidateExecutable."

        $newProcess = Start-ControllerWithRetry -Path $candidateExecutable -MaximumAttempts 5
        if ($null -eq $newProcess) {
            Write-Host "[WARN] New controller could not start; restarting the previous binary."
            $process = Start-ControllerWithRetry -Path $runningExecutable
        }
        else {
            $process = $newProcess
            $runningExecutable = $candidateExecutable
            Write-Host "[HOT] Controller reloaded from $runningExecutable."
        }
        $revision = $stable
    }
}
catch {
    Write-Host "[ERROR] Fish Controller supervisor stopped: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    throw
}
finally {
    if ($null -ne $process -and -not $process.HasExited) {
        Request-GracefulRestart | Out-Null
        if (-not (Wait-ControllerExit -ProcessId $process.Id -TimeoutMilliseconds 5000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
