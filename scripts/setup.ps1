param(
    [switch]$SkipVisionInstall,
    [switch]$SkipFrontendInstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$visionDir = Join-Path $projectRoot 'vision'
$controllerDir = Join-Path $projectRoot 'controller'
$venvDir = Join-Path $visionDir '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

Write-Host "项目根目录：$projectRoot"

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw '未找到 Go。请安装 Go 1.23 或更高版本。'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw '未找到 npm。请安装 Node.js LTS。'
}

& (Join-Path $PSScriptRoot 'generate-deployment-config.ps1')

if (-not $SkipVisionInstall) {
    if ($env:FISH_PYTHON) {
        Write-Host "检测到 FISH_PYTHON，保留现有视觉环境：$env:FISH_PYTHON"
        & $env:FISH_PYTHON -c "import sys; print('Python:', sys.executable); print(sys.version)"
        & $env:FISH_PYTHON -m pip install -r (Join-Path $visionDir 'requirements.txt')
    } else {
        if (-not (Test-Path -LiteralPath $venvPython)) {
            if (Get-Command py -ErrorAction SilentlyContinue) {
                py -3 -m venv $venvDir
            } elseif (Get-Command python -ErrorAction SilentlyContinue) {
                python -m venv $venvDir
            } else {
                throw '未找到 Python。请安装 Python 3，或设置 FISH_PYTHON。'
            }
        }
        & $venvPython -m pip install --upgrade pip
        & $venvPython -m pip install -r (Join-Path $visionDir 'requirements.txt')
        Write-Host "已创建项目视觉环境：$venvPython"
    }
}

& (Join-Path $PSScriptRoot 'build-frontend.ps1') -SkipInstall:$SkipFrontendInstall

Push-Location $controllerDir
try {
    go mod download
    go test ./...
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '初始化完成。以后从项目根目录运行：'
Write-Host '  .\scripts\start.ps1'
