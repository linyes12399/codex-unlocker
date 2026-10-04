$conn = Get-NetTCPConnection -LocalPort 8899 -ErrorAction SilentlyContinue
if ($conn) {
    $processId = $conn.OwningProcess
    Write-Host "Killing process $processId on port 8899"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "Done"
} else {
    Write-Host "Port 8899 is free"
}
