# DSH 手机版（APK）

[中文](README.md) · [**English**](README.en.md)

让手机访问这台电脑上的 DeepSeek Harness。**两种连法**：

| 方式 | 要插线吗 | 能在外面用吗 | 适合 |
|---|---|---|---|
| **① 无线（推荐）** | ❌ 不用 | ✅ 5G / 任意 WiFi | 日常使用 |
| ② 有线（USB） | ✅ 要 | ❌ 只能在家 | 应急 / 无 Tailscale 时 |

**纯客户端**，不在手机上运行 DSH 本体，也不改动 DSH 的任何配置。

> 零第三方依赖 · 25 KB · minSdk 24 / targetSdk 34 · 已在 vivo V2254A（Android 16）实机跑通

---

## 快速开始 · 无线（推荐）

**前提**：电脑与手机都装好 [Tailscale](https://tailscale.com/download) 并登录**同一个账号**。

```bash
# 1. 电脑上启动代理（会打印手机要用的地址）
powershell -ExecutionPolicy Bypass -File _中间件/dsh-wireless.ps1

# 2. 安装 APK（首次需要一次 adb；之后不再需要数据线）
adb install -r dist/DSH手机版-v1.0-debug.apk
```

**3. 手机上打开 App → 填入脚本打印的地址**（形如 `http://100.x.x.x:18080`）→ 点「连接」。

首次连接时 App 会**自动获取凭据**，你不需要手动填任何 cookie。
之后打开即用，**不需要数据线、不需要同一个 WiFi**。

> 想开机自动就绪？`_中间件/dsh-wireless.ps1` 已在启动文件夹里放了快捷方式，登录即自动运行。

## 快速开始 · 有线（备选）

```bash
# 1. 安装 APK（手机需已开启 USB 调试并授权本机）
adb install -r dist/DSH手机版-v1.0-debug.apk

# 2. 一键连接（建隧道 + 签发 cookie + 推给 App）
powershell -ExecutionPolicy Bypass -File _中间件/连接手机.ps1

# 3. 手机上点开「DSH 手机版」
```

之后**拔线即断，重插再跑一次第 2 步即可**（cookie 30 天有效，不必重新配对）。

### 目录说明

| 路径 | 内容 |
|---|---|
| `app/` | Android 源码（纯 framework API，无 Gradle 工程） |
| `_中间件/tools/` | 构建、签发与代理脚本（`_中间件` 是「内部工具」的意思） |
| `_中间件/dsh-wireless.ps1` | **无线方案一键启动器**（取 IP → 起代理 → 打印地址） |
| `_中间件/tailscale-install.ps1` | Tailscale 静默安装（需管理员权限运行一次） |
| `_中间件/tools/dsh-proxy.mjs` | 反向代理（无线方案的核心，Node 零依赖） |
| `_中间件/连接手机.ps1` | 有线方案一键连接脚本 |
| `dist/` | 编译好的 APK |
| `验收截图/` | 真机验证截图 |
| `无线接入方案.md` | 无线方案的完整设计说明与实测证据 |

---

## 一、为什么是这条路

让手机连上 DSH 有两个硬障碍，都来自 DSH 自己的设计：

**障碍 1：DSH 故意不开放网络访问。**

`dsh web --host 0.0.0.0` 会在启动时被直接拒绝，官方理由是
"it would expose remote code execution to the network"。
webserver 的 `host` 参数也只认 `127.0.0.1` 与 `0.0.0.0` 两值。
这不是疏漏，是作者有意为之 —— DSH 是一套能跑任意 shell 命令的 agent，
暴露到网络等于把机器交出去。

**障碍 2：DSH 的 Web 界面有登录门禁。**

不带凭据请求 `http://127.0.0.1:19387/` 返回 **401**。

**障碍 3（无线方案特有）：cookie 绑定 Host 头。**

cookie 名 = `dsh-auth-` + `base64url(sha256(authority))`，而 authority 就是 Host 头。
所以换一个地址访问，旧 cookie 立刻失效 —— 这也是为什么不能简单地把端口转发出去。

## 二、两个障碍分别怎么过的

### 1. 用 adb 反向隧道，让网络访问根本不存在

```
adb reverse tcp:19387 tcp:19387
```

这条命令让**手机的** `127.0.0.1:19387` 转发到**电脑的** `127.0.0.1:19387`。
手机以为在访问自己，实际走的是数据线。

好处是决定性的：

- DSH 全程只听 `127.0.0.1`，**没有任何网络暴露面**
- 不碰 DSH 任何配置、不改 profile、不装插件
- 手机访问的 authority 是 `127.0.0.1:19387`，与电脑侧**完全一致**
  —— 这一条是下一个障碍能过的关键

### 2. 用 DSH 自己的持久密钥签发会话 cookie

DSH 的认证机制（读 `app.asar` 得来）是：

- 每个进程启动时生成一个**随机令牌**，`dsh web` 打印带 `?token=...` 的 URL
- `GET /?token=...` 凭令牌换取一个**绑定 authority 的签名 cookie**
- 之后所有请求带这个 cookie
- cookie 签名密钥**持久化在本机**：`C:\Users\hrcsn\.dsh\.credentials.yaml`
  的 `client-connection/browser-session` → `payload.secret`（32 字节）

随机令牌只活在内存里，外部拿不到。但**长期有效的凭据是 cookie**，
而 cookie 的签名密钥就在本机。于是照它的算法自签：

```
cookie 名 = 'dsh-auth-' + base64url( sha256(authority) )
cookie 值 = 'v1.' + base64url(JSON payload) + '.' + base64url( HMAC-SHA256(secret, body) )
payload   = { version: 1, authority, issuedAt, expiresAt }
```

**这不是破解。** DSH 的安全边界（拒绝 `0.0.0.0`）防的是"公网暴露"；
这里做的是用户用自己的机器、自己的凭据、给自己的手机开一扇门，
走的还是 DSH 自己定义的协议。默认有效期 30 天。

> 前提是这台机器和这份凭据都是用户自己的。
> **对方的系统、别人的账号，一律不适用。**

---

## 二·五、无线方案是怎么做到的

上面的 adb 方案能用，但**每次都要插线**。无线方案要解决三个新问题：

| 问题 | 解法 |
|---|---|
| 手机怎么找到电脑？ | **Tailscale** 私有加密隧道（P2P 打洞，无需公网 IP） |
| DSH 只认回环 Host 怎么办？ | **本地反向代理**把 `Host`/`Origin` 重写回 `127.0.0.1:19387` |
| cookie 绑定 Host，换地址就失效？ | 代理重写 Host 后 authority 不变，**旧 cookie 继续有效** |

### 代理只做三件事

```js
// _中间件/tools/dsh-proxy.mjs（Node 零依赖）
// 1) 监听 <Tailscale IP>:18080
// 2) 转发前把 Host / Origin / Sec-Fetch-Site 改写成 127.0.0.1:19387
// 3) 响应原样 pipe，不缓冲（DSH 的 RPC 是流式 fetch，缓冲会破坏流式语义）
```

**DSH 侧零改动** —— 升级、重装、换机器都不影响这套东西。

### 实测证据

用同一份 cookie 做对照实验：

| 测试 | 直连（伪装 Host） | 经代理 |
|---|---|---|
| `GET /` | **401** | **200**（38,927 字节，与直连逐字节一致） |
| `GET /api` | **403**（信任栅栏） | **404**（栅栏已过，路由未认领） |
| 不带 cookie | — | **401**（鉴权仍生效） |

→ 代理**只是搬门，没有拆锁**：DSH 的信任栅栏和 cookie 校验都还在工作。

### 凭据怎么进手机（两条通道）

手机首次访问会拿到 401。代理提供两个配对入口：

| 通道 | 路径 | 说明 |
|---|---|---|
| 自动 | `/__pairauto` | **App 用**。免密钥、可重复使用 |
| 手动 | `/__pair?k=<密钥>` | 浏览器用。密钥每次启动随机生成、**用完即焚** |

App 收到 401 时会**自动**访问 `/__pairauto`，代理回 `302 + Set-Cookie`，
**WebView 自己接住 cookie** 然后重载 —— 用户全程零操作。

> ⚠️ **`/__pairauto` 免密钥的安全依据**：代理**只绑 Tailscale 网卡**，
> 能连到这个端口的前提是「已经在这条 tailnet 里」，网络层已由 Tailscale 认证。
> 局域网与公网都摸不到这个端口。
>
> **如果你把 `PROXY_HOST` 改成 `0.0.0.0`，必须同时删掉这个通道。**

## 三、怎么用

### 首次

1. 手机开「开发者选项」→「USB 调试」，用数据线连电脑，弹窗点「允许」
2. 在电脑上跑：

```powershell
powershell -ExecutionPolicy Bypass -File "_中间件\连接手机.ps1"
```

这个脚本会自动做完全部五件事：找 adb → 查设备 →
建反向隧道 → 确认 DSH 在线 → 签发 cookie 并推送到手机。

3. 手机上点开「DSH 手机版」

### 日常

拔线后连接断开。重插后再跑一次 `连接手机.ps1` 即可。
cookie 30 天内有效，期间不必重新签。

### 手动安装 APK（脚本会检测到未安装并给出命令）

```bash
adb install -r "dist/DSH手机版-v1.0-debug.apk"
```

## 四、App 里能设置什么

点右上角 **≡** 打开设置面板：

| 项 | 说明 |
|---|---|
| 服务器地址 | 默认 `http://127.0.0.1:19387`，一般不用改 |
| 认证 Cookie | `dsh-auth-xxx=v1.xxx.yyy` 形态。**留空则只能访问公开资源**，看不到会话。连接脚本会自动推送填好 |

设置保存在本地，下次启动自动恢复。

## 五、实现说明

### 技术栈

- **零第三方依赖**：纯 Android framework API，不用 Gradle / AndroidX /
  不联网拉任何包
- 语言 Java 17，minSdk 24（Android 7.0），targetSdk 34

### 手工构建流水线

不用 Gradle，七步全手工（`_中间件\tools\build-apk.mjs`）：

```
① aapt2 compile   逐资源编译为 .flat
② aapt2 link      生成基础 APK + 自动生成 R.java
③ javac           编译 Java + R.java → .class
④ d8              .class → classes.dex
⑤ jar             把 classes.dex 装进 APK
⑥ zipalign        4 字节对齐
⑦ apksigner       RSA 2048 签名
```

一条命令重新构建：

```bash
node "_中间件/tools/build-apk.mjs"
```

### WebView 配置要点

DSH 前端是标准 ES Module 应用，靠
`<script type="module" src="./assets/index-*.js">` 启动，
并通过 `window.__ModuleLoader__` 动态加载 **74 个客户端插件**
（`index.html` 里的 `__DSH_BOOT__.entries`）。
因此下面几项缺一不可：

- `setJavaScriptEnabled(true)` —— ES Module 与插件加载
- `setDomStorageEnabled(true)` —— DSH 用 localStorage 存布局与偏好
- `MIXED_CONTENT_COMPATIBILITY_MODE` —— cleartext 页面里可能混入 https 资源
- `setAcceptThirdPartyCookies(true)` —— 确保会话 cookie 被带上

cookie 通过 `CookieManager.setCookie(url, name=value; Path=/)` 在
**首个请求前**注入，所以 DSH 的 Session 能直接建立，不需要用户手动登录。

### 深链

`连接手机.ps1` 通过 `adb shell am start -d "dshmobile://connect?url=...&cookie=..."`
把地址和 cookie 一次性推给 App，App 收到后自动连上，无需手动输入。

## 六、验证结果

### 构建期验证

| 项 | 结果 |
|---|---|
| APK 构建 | ✅ 七步流水线全通，产物 25.1 KB |
| 签名 | ✅ `apksigner verify` 通过，**v2 + v3 方案均为 true**（Android 11+ 可装） |
| 证书 | ✅ `CN=DSH Mobile, OU=DSH, O=DeepSeek`，RSA 2048 |
| badging | ✅ 包名 / 启动 Activity / 应用名 / minSdk 24 / 两个权限全部正确 |
| APK 内部结构 | ✅ classes.dex + resources.arsc + 全部资源在位 |
| dex 非空壳 | ✅ 主类、8 个关键方法、WebChromeClient、5 个资源 id 均在 |
| 认证链路（PC 侧） | ✅ 自签 cookie 请求根路径 → **HTTP 200** |
| 前端资源 | ✅ `index.js` / `vendor.js` / 两个 CSS 均 200 |

### ✅ 真机验证（2026-10-14 12:15，vivo V2254A / Android 16）

| 项 | 结果 |
|---|---|
| 安装 | ✅ `adb install` Success |
| 反向隧道 | ✅ `UsbFfs tcp:19387 tcp:19387` |
| **WebView 渲染 DSH** | ✅ **完整渲染 —— 鲸鱼 logo、「探索未至之境」、侧边栏、输入框全部正常** |
| **74 个动态插件** | ✅ 加载成功（「自动化任务」面板完整渲染，中文正常） |
| **API 实时数据** | ✅ 工作区显示 **「蓝色大肥鱼工作区」**、余额 **¥8.00** —— 均为电脑端实时数据，非静态页面 |
| **WebSocket 长连接** | ✅ 前端能拿到实时状态（余额/工作区名），证明 RPC 通道通 |
| 深链自动连接 | ✅ 单次推送即成功，无需手动输入 |
| 连接脚本 | ✅ 五步全过，**exit code 0**，设备串号显示正确 |
| **横屏布局** | ✅ 顶栏不再遮挡 DSH 标题栏与 `···`/`⊞` 按钮（**用户实机反馈后修复**） |
| **收起/展开顶栏** | ✅ 双向验证：收起后 WebView 全屏、把手在右边缘；点把手可复原 |

### 仍未验证

- 触摸长按 / 手势操作的手感
- 软键盘弹出时输入框是否被遮挡
- 屏幕旋转
- 上传附件的 file chooser（代码已接 `onShowFileChooser`）
- 长时间挂后台后重连

## 七、已知限制

1. **必须插着数据线。** 断开即断开。这是 adb reverse 的固有限制，
   也是它比"开放局域网"安全的根本原因。
2. **DSH 会话不同步。** 手机上看到的就是这台电脑上的会话记录，
   因为 DSH 的会话本来就只存在本机（它没有云同步设计，
   登录的 DeepSeek Platform 账号只管 API 额度）。
3. **cookie 30 天过期。** 过期后重跑 `连接手机.ps1` 即可。
4. **一次只能连一台。** 多台手机同时插着时，adb reverse 对每个 serial 生效，
   但脚本默认取第一台。
5. **竖屏布局偏挤。** DSH 前端是为桌面宽屏设计的，手机竖屏下侧边栏占位较多，
   横屏体验更好。

## 八、文件清单

```
.
├── README.md                             ← 本文件（中文）
├── README.en.md                          ← English
├── app\src\main\
│   ├── AndroidManifest.xml
│   ├── java\ai\deepseek\dsh\mobile\MainActivity.java
│   └── res\
│       ├── layout\activity_main.xml
│       ├── values\{strings,colors,styles}.xml
│       ├── drawable\{ic_whale_fg,ic_launcher_foreground}.xml
│       └── mipmap-*\ic_launcher.png
├── dist\DSH手机版-v1.0-debug.apk        ← 交付物
├── 验收截图\                             ← 真机验证截图
└── _中间件\                              ← 内部工具
    ├── 连接手机.ps1                     ← 一键连接
    └── tools\
        ├── build-apk.mjs                ← 构建脚本
        ├── dsh-mint-cookie.mjs          ← cookie 签发器
        ├── make-icon.py                 ← 图标生成
        └── {diag,parse-boot,readline}.mjs
```

> ⚠️ **不入库的文件**：构建工具链（约 1 GB，脚本会按需下载/指定路径）、
> `cookie.json`（**已签名的会话凭据，等同钥匙**）、签名密钥。
> 详见 `.gitignore`。
>
> 构建暂存区默认在 `C:\dsh-mobile-build\`（ASCII 路径，原因见坑 3），
> 里面是工具链副本与中间产物，可随时删除，重跑构建会自动重建。

## 九、八个踩过的坑

### 1. ⚠️ `CookieManager.setCookie()` 是异步的，不能紧接着 `loadUrl()`

**这是唯一一个只有真机才暴露的 bug。** 第一版 `connect()` 里这样写：

```java
injectCookie(url, cookie);
webView.loadUrl(url);          // ← 太快了
```

结果手机上打开是 DSH 的 **401 页面**（正文 `dsh web authentication required`），
而电脑上同样的 cookie 用 curl 测是 200。

**根因**：`setCookie()` 调用返回时，cookie 可能还没进入 WebView 的网络栈。
首个请求因此不带 cookie，被 DSH 拒掉。

**证据**：连续推送两次深链 —— 第一次 401（截图 73 KB 空白页），
第二次就正常（截图 519 KB 完整界面）。cookie 在第 1 次之后才进容器。

**修复（三重防护）**：

```java
// ① 延迟 350ms 再导航，给 setCookie 落地时间
webView.postDelayed(new Runnable() {
    public void run() { webView.loadUrl(targetUrl); }
}, 350);

// ② onReceivedHttpError 捕获主文档 401，延迟 400ms 自动重载
// ③ authRetried 标志确保只重试一次，避免死循环
```

修复后**清空 App 数据 + 单次深链推送直接成功**，已真机复验。

### 2. aapt2 compile 的 `-o` 必须是目录

`aapt2 compile <file> -o <某个文件>` 时它按 **zip** 写（magic = `PK\x03\x04`），
link 阶段必然报：

```
error: failed to read file: magic value is 0x04034b50 but AAPT expects 0x54504141
```

传**目录**才产出正确的 `.flat`（magic = `AAPT`）。实测确认过两边的头四字节。

### 3. aapt2 无法 stat 含中文的路径

工具链放在**含中文的路径**下时，aapt2 报：

```
Failed to stat file '...\android-34\android.jar': No such file or directory
```

尽管 `Test-Path` 明明为 True。解决办法是把工具链复制到 ASCII 路径
`C:\dsh-mobile-build\toolchain\`，构建脚本会优先用它。

### 4. `.ps1` 必须有 UTF-8 BOM（**反复踩**）

无 BOM 的 `.ps1` 被 Windows PowerShell 按 GBK 解析，中文全乱，
然后报一堆毫不相干的 `Missing closing '}'`（位置全是假的）。

写入时必须用：

```powershell
[System.IO.File]::WriteAllText($f, $c, (New-Object System.Text.UTF8Encoding($true)))
```

⚠️ **这条不是"记住一次就免疫"的坑。** 我用 `write` 写好脚本、补了 BOM、
跑通了；之后又用 `edit` 改了一处 —— `edit` 重写文件时会**剥掉 BOM**，
于是同样的假错误又回来一次。真机联调时又栽了第三次。

→ **凡是编辑过 `.ps1`，就必须重新验一次前三个字节是不是 `EF BB BF`。**
→ 另：`[System.Management.Automation.PSParser]::Tokenize()` 检查**会通过**
  （按当前会话编码读），而 `powershell -File` 起新进程按 BOM 判定 ——
  **"自检通过"和"真能跑"是两件事。**

### 5. PowerShell 把数组拆成标量，导致设备串号显示成 "1"

真机联调时脚本输出 `已连接设备：1`，而不是 `<device-serial>`。

**根因**：`Where-Object` 只匹配到一条时，PowerShell 会把结果**从数组拆成字符串**，
随后 `$lines[0]` 取到的是**第一个字符** `"1"`，不是第一行。

```powershell
# ❌ 只有一台设备时 $lines 是字符串
$lines = $devices -split "`r?`n" | Where-Object { $_ -match "`tdevice$" }

# ✅ 强制数组
$lines = @($devices -split "`r?`n" | Where-Object { $_ -match "`tdevice$" })
```

**同一类坑**：`$unauth.Count` 在单元素时也不可靠，同样要用 `@()` 包住。

### 6. `$ErrorActionPreference='Stop'` 会把 adb 的**状态提示**当成致命错误

真机联调时脚本在第 5 步 exit 1 报错，但手机其实**已经成功打开了 App**。

**根因**：adb 把状态写入 **stderr**。App 已在前台时 adb 输出：

```
Warning: Activity not started, intent has been delivered to currently
running top-most instance.
```

这**是成功**（深链已送达运行中的实例），但在 `$ErrorActionPreference='Stop'`
下 PS 5.1 把原生命令的 stderr 当成终止性错误，脚本随即中断。

**修复**：临时放宽错误策略 + 显式判定输出内容。

```powershell
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$amOut = & $AdbPath shell am start -a android.intent.action.VIEW -d "..." 2>&1 | Out-String
$ErrorActionPreference = $prev
$amOk = ($amOut -match 'Starting:') -or ($amOut -match 'Warning: Activity not started')
```

→ **推广**：任何调用原生命令并可能产生 stderr 的地方，
  **不要靠 `$LASTEXITCODE` 单独判定**，要看输出内容。

### 7. ⚠️ 顶栏「浮」在 WebView 之上会盖住 DSH 自己的控件

**2026-10-14 12:22 用户实机反馈**：「横过来会舒服很多，但是顶端栏太宽了导致我点不到关侧边栏」。

**病因**：第一版布局把顶栏当成**浮层**：

```xml
<FrameLayout>
    <WebView android:layout_height="match_parent" />   <!-- 满高 -->
    <LinearLayout id=topbar android:layout_gravity="top" />  <!-- 浮在上面 -->
    <Space android:layout_height="44dp" />              <!-- 无效！推不动 match_parent 的 WebView -->
</FrameLayout>
```

WebView 是 `match_parent`，那个 `<Space>` **完全不起作用**（我当时以为它能"预留"空间）。
结果顶栏**物理遮挡**了 WebView 顶部 44dp，
而 DSH 自己标题栏右侧的「分栏」`⊞`、「更多」`···` 等按钮**正好在这一条里**，全部点不到。

**正确做法**：让顶栏占**真实布局高度**，WebView 在它下面填满剩余空间。

```xml
<FrameLayout>
    <LinearLayout android:orientation="vertical">
        <LinearLayout id=topbar android:layout_height="38dp" />
        <WebView android:layout_height="0dp" android:layout_weight="1" />
    </LinearLayout>
    <!-- 其余浮层放这里 -->
</FrameLayout>
```

→ **凡是自绘控件，默认要占布局空间，不要浮在内容之上** ——
  浮层只适合"短暂出现"的东西（弹窗、Toast），不适合常驻工具栏。

**顺带加了「收起」**：横屏时 38dp 很宝贵，点 `▴` 收起顶栏后 WebView 全屏，
只在**右边缘垂直居中**留一条 22×72dp 的半透明把手 `‹`。

⚠️ **把手位置也是试出来的**：先放右上角，结果**盖住了 DSH 的 `⊞` 按钮**；
右下角是鲸鱼挂件的地盘。最后放右边缘垂直居中 —— 那里是内容区右侧空白，几乎不挡任何可点元素。

### 8. 别照着缩略图估点击坐标，用 `uiautomator` 量

**2026-10-14 12:27 实测。** 我要点自己加的「收起」按钮，凭缩放后的截图估了个
`(2586, 222)`，点下去**毫无反应**。dump 出真实层级：

```
btn_collapse   bounds=[2904,144][3032,264]  中心=(2968,204)
status_text    bounds=[154,174][2688,233]   ← 我点的位置其实在这里
```

原来那一下打在**状态文字**上了。差 380px。

→ **精确点击一律先量**：

```powershell
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml
# 按 resource-id 取 bounds，算中心
```

→ 缩略图只适合"看个大概"，**不适合算坐标**——
  尤其是有多次缩放（设备 1.05×、预览再缩）时误差会叠加。

### 附带两个小坑

- JDK 下载失败后用 `curl -C -` 断点续传**换镜像**，会把两个源的残片
  拼进同一个 zip →「本地文件头已损坏」。**删文件重下，不要续传。**
- 测 HTTP 认证必须用 `curl.exe`。PowerShell 的 `Invoke-WebRequest`
  会改写 `Cookie` 头格式，同一个 cookie 它测出 401、curl 测出 200。

## 十、小结：真机验证救了什么

这个项目的 **4 个坑里有 3 个是只有真机才能发现的**：

| 坑 | 电脑上能发现吗 |
|---|---|
| `setCookie` 与 `loadUrl` 竞态 | ❌ 电脑上 curl 测 cookie 一直是 200，完全看不出来 |
| 设备串号显示成 "1" | ❌ 没有真机时 `$lines` 为空，走的是"无设备"分支，压根执行不到那行 |
| adb Warning 被当致命错误 | ❌ 同上，App 不在前台就不会产生那个 Warning |

**所以「编译通过 + 签名有效 + 电脑侧链路通」不等于"能用"。**
这一轮如果停在"APK 构建成功"就收工，交付的会是一个打开就显示 401 的应用。
