# ══════════════════════════════════════════════════════════════
#  dsh-wireless.ps1 —— DSH 手机版「无线接入」一键启动
#
#  干什么：
#    1. 找到 Tailscale 给本机分配的 100.x.x.x 地址
#    2. 把反向代理绑到那个地址启动（只绑 Tailscale 网卡）
#    3. 打印手机可以直接打开的【配对链接】
#
#  主人只需要：双击这个脚本（或让它开机自启），然后看屏幕上的链接。
#
#  ⚠️ 本文件含中文，必须存成 UTF-8 with BOM。
# ══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Continue'

$TS      = 'C:\Program Files\Tailscale\tailscale.exe'
$NODE    = 'C:\Program Files\nodejs\node.exe'
$PROXY   = 'D:\蓝色大肥鱼工作区\写出\DSH手机版\_中间件\tools\dsh-proxy.mjs'
$COOKIE  = 'D:\蓝色大肥鱼工作区\写出\DSH手机版\_中间件\cookie.json'
$LOGDIR  = 'C:\dsh-mobile-build'
$LOG     = Join-Path $LOGDIR 'proxy.log'
$ERR     = Join-Path $LOGDIR 'proxy.err'
$PORT    = 18080
$DSHPORT = 19387

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '════════════════════════════════════════════' Cyan
Say '  DSH 手机版 · 无线接入启动器' Cyan
Say '════════════════════════════════════════════' Cyan
Say ''

# ---- 0. 前置检查 ----
foreach ($f in @($TS, $NODE, $PROXY, $COOKIE)) {
    if (-not (Test-Path -LiteralPath $f)) {
        Say "[X] 缺少文件: $f" Red
        Say '    先确认 Tailscale 已安装、cookie.json 已生成。' Yellow
        exit 1
    }
}
Say '[1/5] 前置文件齐全' Green

# ---- 1. DSH 本体在跑吗 ----
$dshUp = Get-NetTCPConnection -LocalPort $DSHPORT -State Listen -ErrorAction SilentlyContinue
if (-not $dshUp) {
    Say "[!] DSH 本体没在 $DSHPORT 上监听 —— 请先打开 DeepSeek Harness 桌面端。" Yellow
    Say '    代理仍会启动，等 DSH 起来后自动可用。' DarkGray
} else {
    Say "[2/5] DSH 本体在跑 (PID $($dshUp[0].OwningProcess))" Green
}

# ---- 2. 拿 Tailscale IP ----
$tsIp = $null
try { $tsIp = (& $TS ip -4 2>$null | Select-Object -First 1) } catch {}
$tsIp = "$tsIp".Trim()

if (-not $tsIp -or $tsIp -notmatch '^100\.') {
    Say '[X] 拿不到 Tailscale IP。请确认 Tailscale 已登录：' Red
    & $TS status
    Say ''
    Say '    若显示 Logged out，打开开始菜单里的 Tailscale 登录即可。' Yellow
    exit 1
}
Say "[3/5] Tailscale IP = $tsIp" Green

# ---- 3. 清掉旧代理 ----
Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

# ---- 4. 启动代理（只绑 Tailscale 网卡）----
if (-not (Test-Path -LiteralPath $LOGDIR)) { New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null }

# 配对密钥：每次启动随机生成，一次性
$bytes = New-Object byte[] 8
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pairKey = 'k' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')

$env:PROXY_HOST  = $tsIp
$env:PROXY_PORT  = "$PORT"
$env:COOKIE_FILE = $COOKIE
$env:PAIR_KEY    = $pairKey

Start-Process -FilePath $NODE -ArgumentList $PROXY `
    -RedirectStandardOutput $LOG -RedirectStandardError $ERR -WindowStyle Hidden
Start-Sleep -Seconds 3

$listen = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
    Say "[X] 代理没起来。错误输出：" Red
    Get-Content $ERR -ErrorAction SilentlyContinue | Select-Object -Last 15 | ForEach-Object { Say "    $_" Red }
    exit 1
}
Say "[4/5] 代理已启动，监听 $($listen[0].LocalAddress):$PORT (PID $($listen[0].OwningProcess))" Green

# ---- 5. 自测 ----
$cookieJson = Get-Content -LiteralPath $COOKIE -Raw | ConvertFrom-Json
$hdr = "Cookie: $($cookieJson.cookieName)=$($cookieJson.cookieValue)"
$code = & curl.exe -s -o NUL -w '%{http_code}' -H $hdr "http://${tsIp}:${PORT}/" 2>$null
if ($code -eq '200') {
    Say "[5/5] 隧道自测 200 ✅" Green
} else {
    Say "[5/5] 隧道自测返回 $code（DSH 没开时正常）" Yellow
}

# ---- 打印手机要用的东西 ----
$base = "http://${tsIp}:${PORT}"
Say ''
Say '════════════════════════════════════════════' Cyan
Say '  📱 手机上打开这个链接（一次性配对）' Cyan
Say '════════════════════════════════════════════' Cyan
Say ''
Say "    $base/__pair?k=$pairKey" White
Say ''
Say '  打开后会自动跳转到 DSH。之后直接用：' DarkGray
Say "    $base" DarkGray
Say ''
Say '  ⚠️ 配对链接只能用一次，别提前在电脑上点。' Yellow
Say '  ⚠️ 重启本脚本会生成新链接。' Yellow
Say ''
Say '  手机侧前提：Tailscale App 已登录并处于 Connected。' DarkGray
Say ''

# 把链接存一份，方便手机扫码/复制
$base | Out-File (Join-Path $LOGDIR 'wireless-url.txt') -Encoding utf8 -NoNewline
"$base/__pair?k=$pairKey" | Out-File (Join-Path $LOGDIR 'pair-url.txt') -Encoding utf8 -NoNewline

Say "  链接已存：$(Join-Path $LOGDIR 'pair-url.txt')" DarkGray
Say ''
