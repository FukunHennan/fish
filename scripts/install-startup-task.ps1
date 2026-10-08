$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$launcher = Join-Path $PSScriptRoot "start.bat"

foreach ($path in @($launcher, (Join-Path $root 'config\firmware.json'), (Join-Path $root 'config\program.json'), (Join-Path $root 'config\tunnel.json'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required startup file is missing: $path"
    }
}

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument "/c `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
$description = "Starts the Fish controller, vision service, and configured tunnel through the single Fish launcher after user logon."

Register-ScheduledTask -TaskName "FishStack" -Action $action -Trigger $trigger -Settings $settings -Description $description -Force | Out-Null

Write-Output "FishStack startup task registered. It will run the single launcher at the next user logon."
