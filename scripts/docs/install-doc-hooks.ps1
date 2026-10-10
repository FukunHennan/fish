$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
    throw 'This Pro1 directory is not a Git checkout. Clone the repository before installing the hook.'
}
& git -C $root config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) {
    throw 'Could not install the documentation pre-push hook.'
}
Write-Output 'Documentation pre-push hook installed for this checkout.'
