# Registers a scheduled task that runs the monitor at logon and restarts it on failure.
# Set optional env vars (TELEGRAM_BOT_TOKEN, etc.) as user environment variables before running this.
$dir = $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\monitor.js`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "OmniaTicketMonitor" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "OmniaTicketMonitor"
"Task installed and started. Remove with: Unregister-ScheduledTask -TaskName OmniaTicketMonitor"
