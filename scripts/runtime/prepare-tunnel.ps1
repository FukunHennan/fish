param(
    [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $Root 'config\tunnel.json'
$runtime = Join-Path $Root 'controller\.runtime'
$output = Join-Path $runtime 'cloudflared-live.yml'
$config = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json

if ($config.enabled -isnot [bool]) {
    throw 'tunnel.json enabled must be a boolean.'
}
if ($config.enabled -ne $true) {
    Write-Output 'disabled'
    exit 0
}

if ([string]$config.tunnelId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' -or
    [string]::IsNullOrWhiteSpace($config.credentialsFile) -or
    [string]::IsNullOrWhiteSpace($config.hostname) -or
    [string]::IsNullOrWhiteSpace($config.service)) {
    throw 'tunnel.json is enabled but required fields are missing.'
}

$credentials = [string]$config.credentialsFile
if (-not [IO.Path]::IsPathRooted($credentials)) {
    $credentials = Join-Path $Root $credentials
}
if (-not (Test-Path -LiteralPath $credentials -PathType Leaf)) {
    throw "Cloudflare credentials file not found: $credentials"
}

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$quote = { param([string]$value) ConvertTo-Json -InputObject $value -Compress }
$yaml = @(
    ('tunnel: ' + (& $quote ([string]$config.tunnelId)))
    ('credentials-file: ' + (& $quote $credentials))
    'ingress:'
    ('  - hostname: ' + (& $quote ([string]$config.hostname)))
    ('    service: ' + (& $quote ([string]$config.service)))
    '  - service: http_status:404'
) -join "`n"
[IO.File]::WriteAllText($output, $yaml + "`n", [Text.UTF8Encoding]::new($false))
Write-Output 'enabled'
