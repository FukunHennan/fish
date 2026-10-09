param(
    [switch]$Check,
    [switch]$Local,
    [switch]$Cpu,
    [switch]$Firmware
)

$options = @()
if ($Check) { $options += '--check' }
if ($Local) { $options += '--local' }
if ($Cpu) { $options += '--cpu' }
if ($Firmware) { $options += '--firmware' }
& node (Join-Path $PSScriptRoot 'bootstrap\setup-windows.mjs') @options
exit $LASTEXITCODE
