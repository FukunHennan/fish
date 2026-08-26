$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $projectRoot 'config'
$configPath = Join-Path $configDir 'deployment.json'

if (Test-Path -LiteralPath $configPath) {
    Write-Host "部署配置已存在：$configPath"
    exit 0
}

New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}
$key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$json = @{ deploymentKey = $key } | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $json + [Environment]::NewLine, $utf8NoBom)
Write-Host "已生成部署配置：$configPath"
