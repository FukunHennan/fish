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
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$key = [Convert]::ToHexString($bytes).ToLowerInvariant()
@{ deploymentKey = $key } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
Write-Host "已生成部署配置：$configPath"
