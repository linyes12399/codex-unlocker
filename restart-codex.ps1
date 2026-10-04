Get-Process | Where-Object { 
    $_.ProcessName -eq 'Codex' -or 
    $_.ProcessName -eq 'ChatGPT' -or
    $_.ProcessName -eq 'codex' -or
    $_.ProcessName -eq 'chatgpt'
} | ForEach-Object {
    Write-Host "Killing process: $($_.ProcessName) (PID: $($_.Id))"
    Stop-Process -Id $_.Id -Force
}

Start-Sleep -Seconds 2
Write-Host "Done. Please manually restart the Codex app."
