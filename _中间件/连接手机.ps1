<#
.SYNOPSIS
    DSH 手机版 —— PC 端一键连接脚本。
.DESCRIPTION
    做三件事：
      1) 检测 USB 手机是否已连接并授权 adb
      2) 建立反向隧道 adb reverse tcp:19387 tcp:19387
      3) 读取本机 DSH 持久密钥，为 authority 127.0.0.1:19387 签发
         一个 30 天有效的浏览器会话 cookie，并通过深链推送给手机 App

    之后在手机上点开「DSH 手机版」即可使用，无需再次授权。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File 连接手机.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 19387,

    # adb 可执行文件：默认用 SDK 自带的，其次用系统 PATH 里的
    [string]$AdbPath
)

$ErrorActionPreference = 'Stop'
$TaskRoot = Split-Path -Parent $PSScriptRoot          # 任务根目录
$Staging  = 'C:\dsh-mobile-build'
$Node     = 'C:\Program Files\nodejs\node.exe'
$Minter   = Join-Path $PSScriptRoot 'tools\dsh-mint-cookie.mjs'

function Write-Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Write-Ok($t)         { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Err($t)        { Write-Host "  [X]  $t" -ForegroundColor Red }
function Write-Info($t)        { Write-Host "  ..   $t" -ForegroundColor Gray }

# ── 0. 定位 adb ───────────────────────────────────────
Write-Step 0 '定位 adb'
if (-not $AdbPath) {
    $candidates = @(
        (Join-Path $Staging 'toolchain\android-sdk\platform-tools\adb.exe'),
        (Join-Path $TaskRoot '_中间件\toolchain\android-sdk\platform-tools\adb.exe'),
        "$env:USERPROFILE\platform-tools\adb.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $AdbPath = $c; break } }
}
if (-not $AdbPath -or -not (Test-Path $AdbPath)) {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { $AdbPath = $cmd.Source }
}
if (-not $AdbPath -or -not (Test-Path $AdbPath)) {
    Write-Err '找不到 adb。请安装 Android SDK platform-tools，或用 -AdbPath 指定。'
    exit 1
}
Write-Ok "adb = $AdbPath"

# ── 1. 检查设备 ───────────────────────────────────────
Write-Step 1 '检查手机连接'
& $AdbPath start-server 2>&1 | Out-Null
$devices = & $AdbPath devices 2>&1 | Out-String
# ⚠️ 必须用 @() 包住：只有一个匹配时 PowerShell 会把数组拆成字符串，
#    随后 $lines[0] 会取到「第一个字符」而不是第一行（实测串号显示成 "1"）。
$lines = @($devices -split "`r?`n" | Where-Object { $_ -match "`tdevice$" -or $_ -match "`tunauthorized$" })
if ($lines.Count -eq 0) {
    Write-Host ''
    Write-Err '没有检测到已连接的手机。'
    Write-Info '请检查：'
    Write-Info '  1. 用数据线把手机接到这台电脑'
    Write-Info '  2. 手机设置里开启「开发者选项」→「USB 调试」'
    Write-Info '  3. 手机上弹出「允许调试」时点允许'
    Write-Host ''
    Write-Host 'adb 当前输出：' -ForegroundColor DarkGray
    Write-Host $devices -ForegroundColor DarkGray
    exit 1
}
$unauth = @($devices -split "`r?`n" | Where-Object { $_ -match "`tunauthorized$" })
if ($unauth.Count -gt 0) {
    Write-Err '手机已连接但未授权调试，请在手机上点「允许」。'
    exit 1
}
$serial = (($lines[0] -split "`t")[0]).Trim()
if ($lines.Count -gt 1) {
    Write-Ok "检测到 $($lines.Count) 台设备，使用第一台：$serial"
} else {
    Write-Ok "已连接设备：$serial"
}

# ── 2. 建立反向隧道 ───────────────────────────────────
Write-Step 2 '建立 USB 反向隧道'
$rev = & $AdbPath reverse "tcp:$Port" "tcp:$Port" 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Err "adb reverse 失败：$rev"
    exit 1
}
$list = & $AdbPath reverse --list 2>&1 | Out-String
if ($list -notmatch [regex]::Escape("tcp:$Port")) {
    Write-Err '反向隧道未建立成功。'
    exit 1
}
Write-Ok "手机访问 127.0.0.1:$Port 即等于访问本机 $Port"

# ── 3. 确认 DSH 在本地监听 ────────────────────────────
Write-Step 3 '确认 DSH 服务在监听'
$ok = $true
try {
    $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 8 "http://127.0.0.1:$Port/manifest.webmanifest"
} catch {
    $code = '000'
}
if ($code -eq '200') {
    Write-Ok "DSH Web 服务在线（manifest 返回 $code）"
} else {
    Write-Host ''
    Write-Err "本机 127.0.0.1:$Port 没有 DSH 服务响应（HTTP $code）。"
    Write-Info '请先打开桌面版 DeepSeek Harness，确认它在运行，再重试本脚本。'
    exit 1
}

# ── 4. 签发浏览器会话 cookie ──────────────────────────
Write-Step 4 '签发浏览器会话 cookie（有效期 30 天）'
if (-not (Test-Path $Node)) {
    Write-Err "找不到 Node.js：$Node"
    exit 1
}
if (-not (Test-Path $Minter)) {
    Write-Err "找不到 cookie 签发脚本：$Minter"
    exit 1
}

# 在脚本所在目录执行，让 cookie.json 落在可控位置
Push-Location $PSScriptRoot
try {
    # 参数顺序：<DSH_HOME> <authority> <有效天数>
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
    $jsonText = & $Node $Minter $dshHome ("127.0.0.1:$Port") 30 2>&1 | Out-String
} catch {
    $jsonText = $_.Exception.Message
} finally {
    Pop-Location
}

# 从输出中解析 JSON（脚本只打印一份 JSON）
$cookie = $null
try { $cookie = $jsonText | ConvertFrom-Json } catch {}
if (-not $cookie -or -not $cookie.cookieValue) {
    Write-Err 'cookie 签发失败：'
    Write-Host $jsonText -ForegroundColor DarkGray
    exit 1
}
Write-Ok "cookie 名：$($cookie.cookieName)"
Write-Ok "有效期至  ：$([DateTimeOffset]::FromUnixTimeMilliseconds($cookie.expiresAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm'))"

# ── 5. 推送深链到手机 ─────────────────────────────────
Write-Step 5 '推送地址到手机 App'
$url = "http://127.0.0.1:$Port"
# 深链：dshmobile://connect?url=..&cookie=<name=value>
# 注意：PowerShell 行首不能出现裸 & （会被当成运算符），故整条写在一行。
$pairing = "$($cookie.cookieName)=$($cookie.cookieValue)"
$deepLink = "dshmobile://connect?url=$([System.Uri]::EscapeDataString($url))&cookie=$([System.Uri]::EscapeDataString($pairing))"

$pkg = 'ai.deepseek.dsh.mobile'
$installed = & $AdbPath shell pm list packages 2>&1 | Out-String
if ($installed -notmatch [regex]::Escape($pkg)) {
    Write-Host ''
    Write-Err "手机上还没安装「DSH 手机版」。"
    Write-Info "先安装："
    Write-Info "  & '$AdbPath' install -r '$(Join-Path $TaskRoot 'dist\DSH手机版-v1.0-debug.apk')'"
    Write-Host ''
    Write-Host '（深链已备好，装好后重跑本脚本即可自动推送）' -ForegroundColor DarkGray
    Write-Host $deepLink -ForegroundColor DarkGray
    exit 1
}

# ⚠️ adb 把状态写入 stderr。在 $ErrorActionPreference='Stop' 下，
#    PS 5.1 会把原生命令的 stderr 当成终止性错误而中断脚本
#    —— 真机实测：App 已在前台时 adb 输出
#    "Warning: Activity not started, intent has been delivered to
#     currently running top-most instance."（这其实是【成功】），
#    却让脚本 exit 1。故此处临时放宽错误策略并显式判定。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$amOut = & $AdbPath shell am start -a android.intent.action.VIEW -d "`"$deepLink`"" 2>&1 | Out-String
$amCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap

$amOk = ($amOut -match 'Starting:') -or ($amOut -match 'Warning: Activity not started')
if (-not $amOk -or $amCode -ne 0) {
    Write-Err '深链推送失败，可手动在 App 里粘贴：'
    Write-Host $deepLink -ForegroundColor DarkGray
    Write-Host $amOut -ForegroundColor DarkGray
    exit 1
}
Write-Ok '已推送，手机应已自动打开 DSH 手机版'

# ── 完成 ──────────────────────────────────────────────
Write-Host ''
Write-Host ('=' * 56) -ForegroundColor Green
Write-Host '  连接完成，手机上可用 DSH 了' -ForegroundColor Green
Write-Host ('=' * 56) -ForegroundColor Green
Write-Host ''
Write-Host '  地址    : ' -NoNewline; Write-Host $url
Write-Host '  设备    : ' -NoNewline; Write-Host $serial
Write-Host '  cookie  : ' -NoNewline; Write-Host '30 天后过期，届时重跑本脚本即可续期'
Write-Host ''
Write-Host '  提示：拔线后连接断开，重插后再跑一次本脚本即可。' -ForegroundColor Gray
Write-Host ''
