param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,128}$')]
    [string] $KeyId
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path (Split-Path $root -Parent) 'Pro1-runtime'
$target = Join-Path $runtime 'cloudflare-turn-key.json'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$staging = Join-Path $runtime ('.cloudflare-turn-key-' + [guid]::NewGuid().ToString('N') + '.tmp')

# Create a private file before writing the token into it.
New-Item -ItemType File -Path $staging | Out-Null
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = New-Object Security.AccessControl.FileSystemAccessRule($currentUser, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
try {
    Set-Acl -LiteralPath $staging -AclObject $acl
} catch {
    Remove-Item -LiteralPath $staging -Force
    throw
}

$secureToken = Read-Host 'Cloudflare TURN API token (hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'TURN API token is empty.' }
    $content = @{ keyId = $KeyId; apiToken = $token } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($staging, $content, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $staging -Destination $target -Force
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $token = $null
    $content = $null
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force }
}

Write-Host "TURN Key saved outside the project: $target"
