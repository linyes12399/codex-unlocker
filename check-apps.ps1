Get-Process | Where-Object {
    $_.ProcessName -like '*ChatGPT*' -or $_.ProcessName -like '*Codex*'
} | Select-Object Id, ProcessName, Path | Format-Table -AutoSize
