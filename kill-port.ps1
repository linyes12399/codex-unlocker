$conn = Get-NetTCPConnection -LocalPort 8899 -ErrorAction SilentlyContinue
if ($conn) {
    $pid = $conn.OwningProcess
    Write-Host "Killing process $pid on port 8899"
    Stop-Process -Id $pid -Force
    Start-Sleep -Seconds 2
    Write-Host "Done"
} else {
    Write-Host "Port 8899 is not in use"
}
