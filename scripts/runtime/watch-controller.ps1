param(
    [Parameter(Mandatory = $true)][string]$ControllerDir,
    [Parameter(Mandatory = $true)][string]$Executable
)

$ErrorActionPreference = "Stop"
$nextExecutable = [IO.Path]::ChangeExtension($Executable, ".next.exe")

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
    return Start-Process -FilePath $Executable -WorkingDirectory $ControllerDir -NoNewWindow -PassThru
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
    $process = Start-Controller
    while ($true) {
        Start-Sleep -Milliseconds 750
        if ($process.HasExited) {
            $code = $process.ExitCode
            Write-Host "[WARN] Fish Controller exited with code $code; restarting in 5 seconds."
            Start-Sleep -Seconds 5
            $process = Start-Controller
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

        if (-not (Request-GracefulRestart)) {
            Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
            $revision = $stable
            continue
        }
        if (-not $process.WaitForExit(10000)) {
            Write-Host "[WARN] Controller did not exit after graceful restart request; keeping the current binary."
            Remove-Item -LiteralPath $nextExecutable -Force -ErrorAction SilentlyContinue
            $revision = $stable
            continue
        }
        Move-Item -LiteralPath $nextExecutable -Destination $Executable -Force
        $process = Start-Controller
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
}
