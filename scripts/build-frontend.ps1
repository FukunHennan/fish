param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $projectRoot 'controller\frontend'

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw '未找到 npm。请先安装 Node.js LTS。'
}

Push-Location $frontendDir
try {
    if (-not $SkipInstall -and -not (Test-Path -LiteralPath (Join-Path $frontendDir 'node_modules'))) {
        if (Test-Path -LiteralPath (Join-Path $frontendDir 'package-lock.json')) {
            npm ci
        } else {
            npm install
        }
    }
    npm run build
} finally {
    Pop-Location
}

Write-Host '前端已构建到 controller/internal/web/dist'
