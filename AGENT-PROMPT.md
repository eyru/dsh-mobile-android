# 给 AI Agent 的复现提示词（Prompt for AI Agents）

> 把这个文件整份交给一个**有终端权限的 AI agent**（Claude Code / Codex / Cursor / DSH 等），
> 它就能在你的机器上把「DSH 手机版」从零复现出来。
>
> 人类用户请直接看 [README.md](README.md)；本文件是**写给 agent 的施工图**。

---

## 使用方式

1. 确认目标机器上**已经装好 DeepSeek Harness 桌面端**并能正常打开（`http://127.0.0.1:19387` 有界面）。
2. 把本文件全文粘给 agent，或让它 `@` 这个文件。
3. agent 会自己判断走到哪一步、缺什么、该问你要什么。

---

## 提示词正文（以下整段交给 agent）

````text
# 任务：把「DSH 手机版」部署到本机，让我的手机能远程使用电脑上的 DeepSeek Harness

## 背景（先读完再动手）

DeepSeek Harness（下称 DSH）是一个桌面 AI agent，Web 界面跑在 http://127.0.0.1:19387。
它**故意不允许** `--host 0.0.0.0`（官方理由："it would expose remote code execution to the network"），
且 Web 界面有登录门禁：不带凭据访问返回 401。

所以「让手机连上 DSH」不能靠改 DSH，只能在外围搭桥。历史上走过两代方案：

- **v1（有线）**：`adb reverse tcp:19387 tcp:19387` 建反向隧道。
  能用，但**每次都要插数据线**，出门即废。
- **v2（无线，目标）**：Tailscale 私有隧道 + 本地反向代理。
  手机在任意网络（5G / 公司 WiFi）都能用。

**你要实现的是 v2。** 仓库里已有全部源码，你的工作是**部署 + 验证**，
不是从零写代码。但你需要理解原理，否则出错时无法定位。

## 核心原理（这三条决定了所有设计）

### 1. DSH 的信任栅栏基于 Host 头
非回环 Host 请求 `/api` 会返回 **403**。所以不能简单地把端口转发出去。

### 2. DSH 的 cookie 绑定 authority
cookie 名 = `dsh-auth-` + `base64url(sha256(authority))`，而 authority 就是 Host 头。
**换一个地址访问，旧 cookie 立刻失效**（表现为 401）。

### 3. 因此需要一个重写 Host 的反向代理
代理监听 `<Tailscale IP>:18080`，转发前把 `Host` / `Origin` / `Sec-Fetch-Site`
一律改写成 `127.0.0.1:19387`。这样 DSH 看到的就是一个本机请求：
- 信任栅栏通过（Host 是回环）
- authority 与签发 cookie 时一致，**旧 cookie 继续有效**
- **DSH 侧零改动**

另外：DSH 的 RPC 走的是 `fetch()` 流式响应，**不是 WebSocket**
（前端 bundle 里 `WebSocket` 出现 0 次）。所以代理必须**原样 pipe、不能缓冲**。

## 执行步骤

### 第 0 步：侦察（不要跳过）

先确认以下事实，**每一项都要实际执行命令验证，不要凭猜测**：

1. DSH 是否在跑：`Get-NetTCPConnection -LocalPort 19387 -State Listen`
2. 当前 shell 是否管理员：
   `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
3. Node 是否可用：`node --version`
4. Tailscale 是否已装：`Test-Path 'C:\Program Files\Tailscale\tailscale.exe'`

把结果报告给用户，然后再继续。

### 第 1 步：装 Tailscale（**需要用户配合，不要自己硬扛**）

⚠️ **重要**：Tailscale 的 Windows 安装包是 MSI，**需要管理员权限**。
如果当前不是管理员：

- ❌ **不要**尝试 `Start-Process -Verb RunAs` —— 那会弹 UAC，**你不能替用户点**
- ❌ **不要**用 `schtasks /Create` 试图提权 —— 普通权限建的任务**跑起来还是普通权限**
- ❌ **不要**去找免安装 zip —— 官方稳定版**只有 MSI 与 EXE**，没有 Windows zip

✅ **正确做法**：写一个安装脚本交给用户，让他右键「使用 PowerShell 运行」，
脚本内部用 `msiexec /quiet` 静默安装。**把不可代劳的那一次点击交给用户，而不是放弃。**

脚本要点：
- 先检查管理员权限，不是就打印清晰的操作指引并退出
- 检查 MSI 是否存在
- 用注册表 Uninstall 键判断是否已安装，避免重复装
- `msiexec /i <msi> /quiet /norestart /l*v <log>`，并**检查退出码**
- 装完 `Start-Service Tailscale`，最后打印登录指引

安装包下载：`https://pkgs.tailscale.com/stable/tailscale-setup-<版本>-amd64.msi`
（版本号可从 `https://pkgs.tailscale.com/stable/?mode=json` 的 `MSIs.amd64` 字段取）

### 第 2 步：让用户登录 Tailscale

装完后 `tailscale status` 会显示 `Logged out` 并给出一个
`https://login.tailscale.com/a/xxxx` 链接。

**把这个链接原样给用户**，让他用 Google / GitHub / Microsoft 账号登录。
手机端也要装 Tailscale 并登录**同一个账号**。

登录成功后 `tailscale ip -4` 会返回 `100.x.x.x`。**记下这个地址。**

### 第 3 步：启动反向代理

代理脚本已在仓库里：`_中间件/tools/dsh-proxy.mjs`（Node 零依赖）。

环境变量：

| 变量 | 含义 | 建议值 |
|---|---|---|
| `PROXY_HOST` | 监听地址 | **`<Tailscale IP>`** ← 只绑 Tailscale 网卡 |
| `PROXY_PORT` | 监听端口 | `18080` |
| `COOKIE_FILE` | cookie 文件路径 | `_中间件/cookie.json` |
| `PAIR_KEY` | 手动配对密钥 | 随机生成 |

⚠️ **不要把 `PROXY_HOST` 设成 `0.0.0.0`** —— 那会让同局域网的其他设备也能访问。
只绑 Tailscale 网卡时，**局域网与公网都摸不到这个端口**，这是整个方案的安全基石。

### 第 4 步：签发 cookie

cookie 必须为 authority `127.0.0.1:19387` 签发（因为代理会把 Host 重写成它）。

算法（读 DSH 的 `app.asar` 得到）：

```
cookie 名  = 'dsh-auth-' + base64url( sha256(authority) )
cookie 值  = 'v1.' + base64url(JSON payload) + '.' + base64url( HMAC-SHA256(secret, body) )
payload    = { version: 1, authority, issuedAt, expiresAt }
secret     = $DSH_HOME/.credentials.yaml 里
             client-connection/browser-session → payload.secret（32 字节）
```

仓库里的 `_中间件/tools/dsh-mint-cookie.mjs` 已实现这个算法，
用法：`node dsh-mint-cookie.mjs <DSH_HOME> <authority> <days>`。

⚠️ **这是用户用自己的机器、自己的凭据、给自己的手机开门**，走的还是 DSH 自己定义的协议。
**不要把这个方法用在任何第三方的系统或账号上。**

### 第 5 步：验证（**必须实测，不要假设**）

按顺序跑这几条，**每条都要看实际返回码**：

```bash
# 1. 经代理带 cookie 访问首页 → 期望 200
curl -s -o NUL -w "%{http_code}" -H "Cookie: <name>=<value>" http://<TailscaleIP>:18080/

# 2. 不带 cookie → 期望 401（证明鉴权仍生效，代理没拆锁）
curl -s -o NUL -w "%{http_code}" http://<TailscaleIP>:18080/

# 3. 静态资源 → 期望 200
curl -s -o NUL -w "%{http_code}" -H "Cookie: ..." http://<TailscaleIP>:18080/manifest.webmanifest

# 4. 局域网 IP 上应当【连不上】（证明只绑了 Tailscale 网卡）
curl -s -o NUL -w "%{http_code}" --max-time 4 http://<局域网IP>:18080/

# 5. 自动配对通道 → 期望 302
curl -s -o NUL -w "%{http_code}" http://<TailscaleIP>:18080/__pairauto
```

**第 4 条特别重要** —— 它是安全性的直接证据。如果局域网能连上，说明绑错了。

### 第 6 步：手机端

**方式 A · 浏览器**（最快验证）
手机浏览器打开 `http://<TailscaleIP>:18080/__pair?k=<PAIR_KEY>`，会自动种 cookie 并跳转。

**方式 B · App**（正式使用）
仓库 `dist/DSH手机版-v1.0-debug.apk`，安装后填入地址即可。
App 收到 401 时会**自动**访问 `/__pairauto` 拿 cookie，用户零操作。

装 APK：`adb install -r dist/DSH手机版-v1.0-debug.apk`
⚠️ 国产 ROM（vivo/OPPO/小米）会在手机上弹确认框，**需要用户点一下**；
`INSTALL_FAILED_ABORTED: User rejected permissions` 通常就是用户还没点，**重试即可**。

### 第 7 步：固化（可选但推荐）

写一个一键启动脚本，做这几件事：
1. 取 Tailscale IP
2. 清掉旧的代理进程
3. 用正确的环境变量启动代理
4. **自测返回 200**
5. 打印手机要用的配对链接

再把它放进启动文件夹（`shell:startup`）实现开机自启。

## 硬性要求

1. **每一步都要实际验证，不要假设成功。** 说"已完成"之前必须跑命令确认。
2. **DSH 侧零改动。** 不改它的配置、不装插件、不改 profile。
3. **代理只绑 Tailscale 网卡。** 绝不绑 `0.0.0.0`。
4. **遇到需要用户操作的步骤（UAC、手机确认、账号登录），明确告诉用户做什么**，
   不要自己硬试，也不要跳过。
5. **不要碰任何第三方系统。** 这套方法只适用于用户自己的机器和自己的凭据。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 手机访问返回 401 | 手机侧没有 cookie | 走 `/__pair?k=` 或让 App 走 `/__pairauto` |
| `/api` 返回 403 | Host 不是回环，代理没生效 | 检查代理是否真的改写了 Host |
| `/api` 返回 404 | 正常 —— 栅栏已过，只是该路由不存在 | 无需处理 |
| 局域网也能访问 18080 | `PROXY_HOST` 绑错了 | 改成 Tailscale IP |
| 配对链接提示"已使用过" | 一次性密钥被消耗了 | 重启代理拿新密钥；**不要用 curl 去"测试"它** |
| `.ps1` 报一堆语法错误 | 文件丢了 UTF-8 BOM | 用 `UTF8Encoding($true)` 重写 |
| `tailscale up` 挂住不动 | 它在等浏览器认证 | 正常，把链接给用户 |

## 交付标准

做完后，向用户报告：

- [ ] `tailscale status` 显示电脑与手机都在线
- [ ] 代理监听在 `<Tailscale IP>:18080`（**不是** `0.0.0.0`）
- [ ] 带 cookie 访问返回 200
- [ ] 不带 cookie 返回 401
- [ ] **局域网 IP 访问被拒绝**
- [ ] 手机在**关闭 WiFi、只开流量**的情况下能打开 DSH

最后一条是整件事的验收标准 —— **它证明用户真的摆脱了数据线。**
````

---

## 附：这个提示词为什么这样写

| 设计 | 原因 |
|---|---|
| 开头讲清两代方案的来龙去脉 | agent 知道**为什么**要这么做，出错时能自己推理，而不是照抄命令 |
| 把三条核心原理前置 | 所有设计都从它们推导出来；不理解的 agent 会在 Host 重写这一步走偏 |
| 明确列出"不要做什么" | `RunAs` 提权、找免安装 zip、绑 `0.0.0.0` —— 这三条是实际踩过的坑 |
| 要求"实际执行命令验证" | 防止 agent 报告"已完成"但实际没做 |
| 验收标准最后一条是"关 WiFi 用流量" | 这是**唯一**能证明目标达成的方式 |
| 常见问题表 | 把实测遇到的 7 类问题直接给出，省掉 agent 的排查时间 |
