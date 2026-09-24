[CmdletBinding()]
param(
    [switch]$SkipPython,
    [switch]$SkipFrontend,
    [switch]$SkipFirmware,
    [switch]$SkipController
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

Require-Command "python"
Require-Command "node"
Require-Command "npm"
Require-Command "go"

$PlatformIO = Get-Command pio -ErrorAction SilentlyContinue
$PlatformIOPath = if ($PlatformIO) { $PlatformIO.Source } else { Join-Path $env:USERPROFILE ".platformio\penv\Scripts\pio.exe" }
if (-not (Test-Path -LiteralPath $PlatformIOPath -PathType Leaf)) {
    throw "PlatformIO executable not found. Install PlatformIO Core 6.2.x in the standard .platformio environment."
}

if (-not $SkipPython) {
    Push-Location (Join-Path $ProjectRoot "vision")
    try {
        python -m pip install -r requirements.txt
    } finally {
        Pop-Location
    }
}

if (-not $SkipFrontend) {
    Push-Location (Join-Path $ProjectRoot "controller/frontend")
    try {
        npm ci
        npm run build
    } finally {
        Pop-Location
    }
}

if (-not $SkipFirmware) {
    & $PlatformIOPath --version
    Push-Location (Join-Path $ProjectRoot "firmware")
    try {
        & $PlatformIOPath run -e seeed_xiao_esp32c3
    } finally {
        Pop-Location
    }
}

if (-not $SkipController) {
    Push-Location (Join-Path $ProjectRoot "controller")
    try {
        go mod download
        go build -o fish-controller-v2.exe ./cmd/fish-controller
    } finally {
        Pop-Location
    }
}

Write-Host "Environment build completed."
