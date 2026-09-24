$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$launcher = Join-Path $PSScriptRoot "start.bat"
$runtime = Join-Path $root "controller\.runtime"
$tunnel = Join-Path $runtime "cloudflared.exe"
$config = Join-Path $runtime "cloudflared-live.yml"

foreach ($path in @($launcher, $tunnel, $config)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required startup file is missing: $path"
    }
}

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument "/c `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
$description = "Starts the Fish controller, vision service, and Cloudflare Tunnel through the single Fish launcher after user logon."

Register-ScheduledTask -TaskName "FishStack" -Action $action -Trigger $trigger -Settings $settings -Description $description -Force | Out-Null

Write-Output "FishStack startup task registered. It will run the single launcher at the next user logon."
