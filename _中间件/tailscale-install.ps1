# ══════════════════════════════════════════════════════════════
#  tailscale-install.ps1 —— 安装 Tailscale（管理员权限）
#
#  用途：DSH 手机版「无线接入方案」第二步的电脑侧准备。
#        装完 + 登录后，手机就能在任意网络下连到电脑上的 DSH。
#
#  ⚠️ 必须右键「使用 PowerShell 运行」，让它弹 UAC /
#     或在已提权的 PowerShell 窗口里执行。
#     普通权限装不了（MSI 需要管理员），会报错退出。
#
#  做法：静默安装已下好的 MSI，然后启动服务 + 设开机自启。
#        不弹任何安装界面，不需要主人点下一步。
# ══════════════════════════════════════════════════════════════

# 本文件含中文，必须带 UTF-8 BOM 保存，否则 PowerShell 5.1 按 GBK 解析会报错。

$MSI = 'C:\dsh-mobile-build\tailscale\ts.msi'
$LOG = 'C:\dsh-mobile-build\tailscale\install.log'

Write-Host ''
Write-Host '════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '  DSH 手机版 · Tailscale 安装' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''

# ---- 0. 权限检查 ----
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '[X] 当前不是管理员权限。' -ForegroundColor Red
    Write-Host ''
    Write-Host '    请这样做：' -ForegroundColor Yellow
    Write-Host '      1. 打开文件资源管理器，进到' -ForegroundColor Yellow
    Write-Host '         D:\蓝色大肥鱼工作区\写出\DSH手机版\_中间件\' -ForegroundColor White
    Write-Host '      2. 右键  tailscale-install.ps1' -ForegroundColor White
    Write-Host '      3. 选   「使用 PowerShell 运行」' -ForegroundColor White
    Write-Host '      4. 弹出 UAC 窗口时点「是」' -ForegroundColor Yellow
    Write-Host ''
    Read-Host '按回车退出'
    exit 1
}
Write-Host '[1/5] 管理员权限 OK' -ForegroundColor Green

# ---- 1. 安装包在不在 ----
if (-not (Test-Path -LiteralPath $MSI)) {
    Write-Host "[X] 找不到安装包: $MSI" -ForegroundColor Red
    Write-Host '    请重新下载后重试。' -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 1
}
$sizeMB = [math]::Round((Get-Item -LiteralPath $MSI).Length / 1MB, 1)
Write-Host "[2/5] 安装包就位 ($sizeMB MB)" -ForegroundColor Green

# ---- 2. 已装过就跳过 ----
$already = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                                'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
          Where-Object { $_.GetValue('DisplayName') -like '*Tailscale*' }
if ($already) {
    $ver = ($already | Select-Object -First 1).GetValue('DisplayVersion')
    Write-Host "[!] Tailscale 已安装（版本 $ver），跳过安装步骤。" -ForegroundColor Yellow
} else {
    Write-Host '[3/5] 正在静默安装（约 20-40 秒，无界面）...' -ForegroundColor Cyan
    $p = Start-Process -FilePath 'msiexec.exe' `
                        -ArgumentList '/i', "`"$MSI`"", '/quiet', '/norestart', '/l*v', "`"$LOG`"" `
                        -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        Write-Host "[X] msiexec 退出码 $($p.ExitCode)，安装失败。" -ForegroundColor Red
        Write-Host "    日志: $LOG" -ForegroundColor Yellow
        Read-Host '按回车退出'
        exit 1
    }
    Write-Host '     安装完成。' -ForegroundColor Green
}

# ---- 3. 确认 tailscale.exe ----
$TS = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $TS)) {
    Write-Host "[X] 装了但找不到 $TS" -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

# ---- 4. 启动服务 + 等它就绪 ----
Write-Host '[4/5] 启动 Tailscale 服务 ...' -ForegroundColor Cyan
& $TS status 2>&1 | Out-Null          # 往往会顺带把服务拉起来
$svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') {
    Start-Service -Name 'Tailscale'
}
Start-Sleep -Seconds 3

# ---- 5. 结果 + 下一步 ----
Write-Host ''
Write-Host '[5/5] 安装阶段完成。当前状态：' -ForegroundColor Green
Write-Host ''
& $TS status
Write-Host ''
Write-Host '════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '  下一步（需要主人自己做）' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''
Write-Host '  现在已经装好了，但【还没登录】。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  登录方式二选一：' -ForegroundColor Yellow
Write-Host ''
Write-Host '    方式 A · 图形界面（推荐，最省事）' -ForegroundColor White
Write-Host '      开始菜单搜 "Tailscale" → 打开 → 点 Log in →' -ForegroundColor Gray
Write-Host '      浏览器会自动打开认证页，用 Google / GitHub / ' -ForegroundColor Gray
Write-Host '      Microsoft 任一账号登录即可。' -ForegroundColor Gray
Write-Host ''
Write-Host '    方式 B · 命令行' -ForegroundColor White
Write-Host '      以管理员身份运行：' -ForegroundColor Gray
Write-Host '        & "C:\Program Files\Tailscale\tailscale.exe" up' -ForegroundColor White
Write-Host '      它会打印一个 https://login.tailscale.com/... 链接，' -ForegroundColor Gray
Write-Host '      复制到浏览器打开并登录。' -ForegroundColor Gray
Write-Host ''
Write-Host '  登录后，主人的电脑就有一个 100.x.x.x 的地址了。' -ForegroundColor Cyan
Write-Host '  然后告诉鱼鱼，剩下的（代理配置、手机连接）鱼鱼来做。' -ForegroundColor Cyan
Write-Host ''
Read-Host '按回车关闭'
