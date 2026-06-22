# start_server.ps1
# Full-stack launcher: Node.js API (port 3001) + http-server frontend (port 8000)
# Nang cap: dung http-server thay PowerShell HttpListener de ho tro 1000+ user dong thoi
# Usage: powershell.exe -ExecutionPolicy Bypass -File start_server.ps1

$FrontendPort = 8000
$ApiPort      = 3001
$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$serverDir    = Join-Path $scriptDir "server"

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "      ShipFee -- Full Stack Server Launcher v2.0" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   Frontend  : http://localhost:$FrontendPort/customer-app/index.html" -ForegroundColor Yellow
Write-Host "   API       : http://localhost:$ApiPort/api/restaurants" -ForegroundColor Yellow
Write-Host "   API Status: http://localhost:$ApiPort/api/status" -ForegroundColor Yellow
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Check Node.js ---
Write-Host "[CHECK] Kiem tra Node.js..." -ForegroundColor Cyan
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    $nodeFallback = "C:\Program Files\nodejs\node.exe"
    if (-not (Test-Path $nodeFallback)) {
        Write-Host "[ERROR] Khong tim thay Node.js! Tai tai https://nodejs.org" -ForegroundColor Red
        Read-Host "Nhan Enter de thoat"
        exit 1
    }
}
$nodeVersion = (& node --version 2>&1)
Write-Host "[OK] Node.js $nodeVersion san sang." -ForegroundColor Green

# --- 2. Install npm dependencies ---
$nodeModulesPath = Join-Path $serverDir "node_modules"
if (-not (Test-Path $nodeModulesPath)) {
    Write-Host "[INFO] Cai dat npm dependencies lan dau..." -ForegroundColor Yellow
    Push-Location $serverDir
    & npm.cmd install
    Pop-Location
    Write-Host "[OK] Dependencies da cai dat." -ForegroundColor Green
} else {
    # Kiem tra compression da duoc cai dat chua
    $compressionPath = Join-Path $serverDir "node_modules\compression"
    if (-not (Test-Path $compressionPath)) {
        Write-Host "[INFO] Cai dat compression middleware (gzip)..." -ForegroundColor Yellow
        Push-Location $serverDir
        & npm.cmd install compression --save
        Pop-Location
        Write-Host "[OK] compression da cai dat." -ForegroundColor Green
    }
}

# --- 3. Free ports if in use ---
foreach ($port in @($ApiPort, $FrontendPort)) {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conns) {
        Write-Host "[INFO] Port $port dang bi chiem -- dang giai phong..." -ForegroundColor Yellow
        foreach ($conn in $conns) {
            if ($conn.OwningProcess -gt 0) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Seconds 1
        Write-Host "[OK] Port $port da duoc giai phong." -ForegroundColor Green
    }
}

# --- 4. Start Node.js API server ---
Write-Host ""
Write-Host "[START] Khoi dong Node.js API server (port $ApiPort)..." -ForegroundColor Cyan

$serverJsPath = Join-Path $serverDir "server.js"
$apiProcess = Start-Process `
    -FilePath "node.exe" `
    -ArgumentList "`"$serverJsPath`"" `
    -WorkingDirectory $serverDir `
    -PassThru `
    -WindowStyle Minimized

if (-not $apiProcess) {
    Write-Host "[ERROR] Khong the khoi dong API server." -ForegroundColor Red
    Read-Host "Nhan Enter de thoat"
    exit 1
}
Write-Host "[OK] API server dang chay (PID: $($apiProcess.Id))" -ForegroundColor Green

# --- 5. Wait for API to be ready ---
Write-Host "[WAIT] Cho API server khoi dong (toi da 15 giay)..." -ForegroundColor Yellow
$apiReady = $false
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $testResp = Invoke-WebRequest -Uri "http://localhost:$ApiPort/api/status" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($testResp.StatusCode -eq 200) {
            $apiReady = $true
            break
        }
    } catch {
        Write-Host "  ... ($i/15)" -ForegroundColor DarkGray
    }
}
if ($apiReady) {
    Write-Host "[OK] API server san sang!" -ForegroundColor Green
} else {
    Write-Host "[WARN] API server chua phan hoi -- tiep tuc khoi dong frontend..." -ForegroundColor Yellow
}

# --- 6. Start http-server (high-concurrency async Node.js static server) ---
Write-Host ""
Write-Host "[START] Khoi dong Frontend server voi http-server (port $FrontendPort)..." -ForegroundColor Cyan
Write-Host "[INFO]  http-server: async concurrent, gzip compression, Cache-Control, 5000+ user/luc" -ForegroundColor DarkGray

# Flags: -p port | --cors | -c 300 (cache 5 phut) | --gzip (tu dong gzip)
$httpServerArgs = "`"$scriptDir`" -p $FrontendPort --cors -c 300 --gzip"

$httpServerAvailable = Get-Command http-server -ErrorAction SilentlyContinue

$frontendProcess = if ($httpServerAvailable) {
    Start-Process `
        -FilePath "http-server" `
        -ArgumentList $httpServerArgs `
        -WorkingDirectory $scriptDir `
        -PassThru `
        -WindowStyle Minimized
} else {
    # Dung npx de tu tai http-server neu chua cai
    Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList "/c npx --yes http-server $httpServerArgs" `
        -WorkingDirectory $scriptDir `
        -PassThru `
        -WindowStyle Minimized
}

if (-not $frontendProcess) {
    Write-Host "[ERROR] Khong the khoi dong Frontend server." -ForegroundColor Red
} else {
    Write-Host "[OK] Frontend server dang chay (PID: $($frontendProcess.Id))" -ForegroundColor Green
}

Start-Sleep -Seconds 2

# --- 7. Open browser ---
Write-Host ""
Write-Host "  == Mo trinh duyet: http://localhost:$FrontendPort/customer-app/index.html" -ForegroundColor White
Write-Host "  Nhan Ctrl+C de tat ca hai server." -ForegroundColor DarkGray
Write-Host ""

Start-Process "http://localhost:$FrontendPort/customer-app/index.html"

# --- 8. Monitor loop (tu dong khoi dong lai neu API crash) ---
try {
    Write-Host "[RUNNING] Ca hai server dang hoat dong. Nhan Ctrl+C de dung..." -ForegroundColor Green
    while ($true) {
        Start-Sleep -Seconds 5

        if ($apiProcess.HasExited) {
            Write-Host "[WARN] API server da dung bat ngo! Dang khoi dong lai..." -ForegroundColor Yellow
            $apiProcess = Start-Process `
                -FilePath "node.exe" `
                -ArgumentList "`"$serverJsPath`"" `
                -WorkingDirectory $serverDir `
                -PassThru `
                -WindowStyle Minimized
            Write-Host "[OK] API server khoi dong lai (PID: $($apiProcess.Id))" -ForegroundColor Green
        }
    }
} finally {
    Write-Host ""
    Write-Host "[STOP] Dang dung tat ca server..." -ForegroundColor Yellow

    if ($apiProcess -and -not $apiProcess.HasExited) {
        Write-Host "[STOP] Dung API process (PID: $($apiProcess.Id))..." -ForegroundColor Yellow
        Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
    }

    if ($frontendProcess -and -not $frontendProcess.HasExited) {
        Write-Host "[STOP] Dung Frontend process (PID: $($frontendProcess.Id))..." -ForegroundColor Yellow
        Stop-Process -Id $frontendProcess.Id -Force -ErrorAction SilentlyContinue
    }

    Write-Host "[DONE] Tat ca server da dung." -ForegroundColor Cyan
    Write-Host ""
}
