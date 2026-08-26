param(
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$controllerDir = Join-Path $projectRoot 'controller'
$configPath = Join-Path $projectRoot 'config\deployment.json'
$projectPython = Join-Path $projectRoot 'vision\.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $configPath)) {
    throw '缺少 config/deployment.json。请先运行 .\scripts\setup.ps1'
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw '未找到 Go。请安装 Go 1.23 或更高版本。'
}

if (-not $env:FISH_CONFIG) {
    $env:FISH_CONFIG = $configPath
}
if (-not $env:FISH_PYTHON -and (Test-Path -LiteralPath $projectPython)) {
    $env:FISH_PYTHON = $projectPython
}

if (-not $SkipFrontendBuild) {
    & (Join-Path $PSScriptRoot 'build-frontend.ps1')
}

Write-Host ''
Write-Host 'Fish Control Center 启动配置'
Write-Host "  Root:   $projectRoot"
Write-Host "  Config: $env:FISH_CONFIG"
if ($env:FISH_PYTHON) {
    Write-Host "  Python: $env:FISH_PYTHON"
} else {
    Write-Host '  Python: 自动发现（PATH / Windows py launcher）'
}
Write-Host '  Web:    http://localhost:8081'
Write-Host ''

Push-Location $controllerDir
try {
    go run ./cmd/fish-controller
} finally {
    Pop-Location
}
