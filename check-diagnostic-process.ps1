Get-CimInstance Win32_Process -Filter 'Name="node.exe"' | Where-Object {
    $_.CommandLine -like '*cdp-trace*' -or $_.CommandLine -like '*trace-network*'
} | Select-Object ProcessId, CommandLine
