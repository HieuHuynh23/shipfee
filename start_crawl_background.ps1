# start_crawl_background.ps1
# Khởi động cào menu ngầm trong Windows

$limit = 100
$delay = 4000
$serverDir = "d:\FOOD DELIVERY\server"

Write-Host "======================================================" -ForegroundColor Green
Write-Host "   Khởi động cào menu ngầm (ShipFee Crawler)          " -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host " Giới hạn: $limit quán | Độ trễ: $delay ms"
Write-Host " Đường dẫn log: $serverDir\crawler_fallbacks.log"
Write-Host "------------------------------------------------------"

# Khởi động node chạy ngầm và chuyển hướng log đầu ra thông qua cmd wrapper
Start-Process cmd -ArgumentList "/c node crawl_open_fallbacks.js --limit=$limit --delay=$delay > crawler_fallbacks.log 2>&1" `
    -WorkingDirectory $serverDir `
    -WindowStyle Hidden

Write-Host "🚀 Đã kích hoạt chạy ngầm thành công!" -ForegroundColor Cyan
Write-Host "Bạn có thể đóng cửa sổ terminal này. Tiến trình cào vẫn chạy ngầm dưới nền."
Write-Host "Để theo dõi tiến trình cào đang chạy thời gian thực, chạy lệnh:" -ForegroundColor Gray
Write-Host "Get-Content -Path '$serverDir\crawler_fallbacks.log' -Wait -Tail 20" -ForegroundColor Yellow
