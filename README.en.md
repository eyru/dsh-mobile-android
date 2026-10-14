# DSH Mobile (APK)

**English** · [中文](README.md)

Access DeepSeek Harness running on your PC from your phone. **Two ways to connect:**

| Mode | Cable needed? | Works outside home? | For |
|---|---|---|---|
| **① Wireless (recommended)** | ❌ No | ✅ 5G / any Wi-Fi | Everyday use |
| ② Wired (USB) | ✅ Yes | ❌ Home only | Fallback / no Tailscale |

**Client-only** — it does not run DSH on the phone, and it does not touch your DSH configuration.

> Zero third-party dependencies · 25 KB · minSdk 24 / targetSdk 34 · verified on a real vivo V2254A (Android 16)

---

## Quick start · Wireless (recommended)

**Prerequisite**: install [Tailscale](https://tailscale.com/download) on **both** the PC and the phone,
and sign in with the **same account**.

```bash
# 1. Start the proxy on your PC (it prints the address for your phone)
powershell -ExecutionPolicy Bypass -File _中间件/dsh-wireless.ps1

# 2. Install the APK (adb is needed once; no cable after this)
adb install -r dist/DSH手机版-v1.0-debug.apk
```

**3. Open the app → enter the address the script printed** (e.g. `http://100.x.x.x:18080`) → tap Connect.

On first connect the app **fetches its credential automatically** — you never type a cookie.
After that, just open the app. **No cable, no need to be on the same Wi-Fi.**

> Want it ready at boot? `_中间件/dsh-wireless.ps1` is already in your Startup folder.

## Quick start · Wired (fallback)

```bash
# 1. Install the APK (USB debugging must be enabled and this PC authorized)
adb install -r dist/DSH手机版-v1.0-debug.apk

# 2. One-shot connect (tunnel + cookie + push to the app)
powershell -ExecutionPolicy Bypass -File _中间件/连接手机.ps1

# 3. Tap "DSH 手机版" on your phone
```

Unplugging the cable drops the connection; **plug it back in and re-run step 2**
(the cookie is valid for 30 days, so there is no re-pairing).

### Layout

| Path | What it is |
|---|---|
| `app/` | Android source (plain framework API, no Gradle project) |
| `_中间件/tools/` | Build, cookie-minting and proxy scripts (`_中间件` means "internal tooling") |
| `_中间件/dsh-wireless.ps1` | **Wireless one-shot launcher** (resolve IP → start proxy → print address) |
| `_中间件/tailscale-install.ps1` | Silent Tailscale install (run once as administrator) |
| `_中间件/tools/dsh-proxy.mjs` | Reverse proxy — the heart of the wireless mode (zero-dependency Node) |
| `_中间件/连接手机.ps1` | Wired-mode one-shot connect script |
| `dist/` | The compiled APK |
| `验收截图/` | Real-device verification screenshots |
| `无线接入方案.md` | Full design notes and measured evidence for the wireless mode |

---

## 1. Why this approach

There are two hard blockers to connecting a phone to DSH, and both come from DSH's own design.

**Blocker 1: DSH deliberately refuses network access.**

`dsh web --host 0.0.0.0` is rejected at startup, with the stated reason:
*"it would expose remote code execution to the network."*
The webserver's `host` option only accepts `127.0.0.1` and `0.0.0.0`.
This is not an oversight — DSH is an agent that can run arbitrary shell commands,
and exposing it to the network means handing over the machine.

**Blocker 2: the DSH web UI requires authentication.**

Requesting `http://127.0.0.1:19387/` without credentials returns **401**.

## 2. How each blocker is solved

### 1. An adb reverse tunnel makes network access unnecessary

```
adb reverse tcp:19387 tcp:19387
```

This forwards the **phone's** `127.0.0.1:19387` to the **PC's** `127.0.0.1:19387`.
The phone thinks it is talking to itself; the traffic actually goes over the cable.

The benefits are decisive:

- DSH keeps listening on `127.0.0.1` only — **zero network exposure**
- No DSH config is touched, no profile edited, no plugin installed
- The authority the phone uses is `127.0.0.1:19387`, **identical** to the PC's
  — and that is exactly what makes the next blocker solvable

### 2. Sign a session cookie with DSH's own persistent key

DSH's authentication works like this (found by reading `app.asar`):

- Each process generates a **random launch token** at startup, and `dsh web`
  prints a URL carrying `?token=...`
- `GET /?token=...` exchanges that token for an **authority-bound signed cookie**
- Every later request carries that cookie
- The cookie signing key is **persisted locally**, in
  `$DSH_HOME/.credentials.yaml` under
  `client-connection/browser-session` → `payload.secret` (32 bytes)

The launch token only ever lives in memory and cannot be obtained from outside.
But the **long-lived credential is the cookie**, and its signing key sits on this machine.
So we just sign one ourselves, using DSH's own algorithm:

```
cookie name  = 'dsh-auth-' + base64url( sha256(authority) )
cookie value = 'v1.' + base64url(JSON payload) + '.' + base64url( HMAC-SHA256(secret, body) )
payload      = { version: 1, authority, issuedAt, expiresAt }
```

**This is not an exploit.** DSH's security boundary (refusing `0.0.0.0`)
guards against *public exposure*; what happens here is a user opening a door
for their own phone, using their own machine and their own credentials,
over a protocol DSH itself defines. Default lifetime is 30 days.

> This only applies when the machine and the credential are the user's own.
> **It does not apply to someone else's system or someone else's account.**

---

## 2b. How the wireless mode works

The adb approach above works, but it **needs the cable every time**. Wireless mode solves three new problems:

| Problem | Solution |
|---|---|
| How does the phone find the PC? | **Tailscale** private encrypted tunnel (P2P hole-punching, no public IP needed) |
| DSH only trusts loopback hosts | **Local reverse proxy** rewrites `Host`/`Origin` back to `127.0.0.1:19387` |
| The cookie is bound to the Host, so changing address breaks it | After the rewrite the authority is unchanged, so the **existing cookie stays valid** |

### The proxy does exactly three things

```js
// _中间件/tools/dsh-proxy.mjs  (zero-dependency Node)
// 1) Listen on <Tailscale IP>:18080
// 2) Before forwarding, rewrite Host / Origin / Sec-Fetch-Site to 127.0.0.1:19387
// 3) Pipe the response through untouched — no buffering
//    (DSH's RPC is streaming fetch; buffering would break streaming semantics)
```

**Zero changes on the DSH side** — upgrades, reinstalls and machine swaps don't affect any of this.

### Measured evidence

Same cookie, two paths:

| Request | Direct (spoofed Host) | Through the proxy |
|---|---|---|
| `GET /` | **401** | **200** (38,927 bytes, byte-identical to direct) |
| `GET /api` | **403** (trust fence) | **404** (fence passed, route simply unclaimed) |
| No cookie | — | **401** (auth still enforced) |

→ The proxy **moves the door, it does not remove the lock**: DSH's trust fence and cookie check both still run.

### How the credential reaches the phone (two channels)

A phone's first request gets a 401. The proxy exposes two pairing endpoints:

| Channel | Path | Notes |
|---|---|---|
| Automatic | `/__pairauto` | **For the app.** No key, reusable |
| Manual | `/__pair?k=<key>` | For browsers. Key is random per launch and **burned after one use** |

On a 401 the app **automatically** hits `/__pairauto`; the proxy replies `302 + Set-Cookie`
and the **WebView stores the cookie itself**, then reloads — zero user action.

> ⚠️ **Why `/__pairauto` can be keyless**: the proxy binds **only the Tailscale interface**,
> so reaching that port already requires being on your tailnet — the network layer is
> authenticated by Tailscale. Neither the LAN nor the public internet can reach it.
>
> **If you ever change `PROXY_HOST` to `0.0.0.0`, you must delete this channel.**

## 3. Usage

### First time

1. On the phone, enable *Developer options* → *USB debugging*, connect the cable,
   and tap *Allow* on the prompt.
2. On the PC, run:

```powershell
powershell -ExecutionPolicy Bypass -File "_中间件\连接手机.ps1"
```

The script does all five steps automatically: locate adb → check the device →
create the reverse tunnel → confirm DSH is up → mint a cookie and push it to the phone.

3. Tap **DSH 手机版** on the phone.

### Day to day

The connection drops when you unplug. Plug back in and re-run `连接手机.ps1`.
The cookie lasts 30 days, so there is nothing to re-pair.

### Installing the APK manually

```bash
adb install -r "dist/DSH手机版-v1.0-debug.apk"
```

## 4. App settings

Tap **≡** in the top bar to open the settings panel:

| Field | Notes |
|---|---|
| Server URL | Defaults to `http://127.0.0.1:19387`; normally no need to change |
| Auth cookie | Form `dsh-auth-xxx=v1.xxx.yyy`. **Leaving it empty only gets you public assets** — no session. The connect script fills it in for you. |

Settings are stored locally and restored on next launch.

## 5. Implementation notes

### Stack

- **Zero third-party dependencies**: plain Android framework API. No Gradle,
  no AndroidX, no package downloads at build time.
- Java 17, minSdk 24 (Android 7.0), targetSdk 34

### Hand-rolled build pipeline

No Gradle — seven manual steps (`_中间件\tools\build-apk.mjs`):

```
1  aapt2 compile   compile each resource into a .flat
2  aapt2 link      produce the base APK + generated R.java
3  javac           compile Java + R.java into .class
4  d8              .class -> classes.dex
5  jar             pack classes.dex into the APK
6  zipalign        4-byte alignment
7  apksigner       RSA 2048 signature
```

One command rebuilds everything:

```bash
node "_中间件/tools/build-apk.mjs"
```

### WebView settings that matter

The DSH frontend is a standard ES Module app, bootstrapped by
`<script type="module" src="./assets/index-*.js">` and loading
**74 client plugins** dynamically through `window.__ModuleLoader__`
(see `__DSH_BOOT__.entries` in `index.html`). None of the following can be omitted:

- `setJavaScriptEnabled(true)` — ES Modules and plugin loading
- `setDomStorageEnabled(true)` — DSH stores layout and preferences in localStorage
- `MIXED_CONTENT_COMPATIBILITY_MODE` — a cleartext page may pull in https assets
- `setAcceptThirdPartyCookies(true)` — make sure the session cookie is sent

The cookie is injected with `CookieManager.setCookie(url, name=value; Path=/)`
**before the first request**, so the DSH session is established immediately and
the user never has to log in manually.

### Deep link

`连接手机.ps1` uses
`adb shell am start -d "dshmobile://connect?url=...&cookie=..."`
to hand both the address and the cookie to the app in one shot. The app connects
automatically — nothing to type.

## 6. Verification results

### Build-time

| Item | Result |
|---|---|
| APK build | ✅ all seven steps pass, 25.1 KB |
| Signature | ✅ `apksigner verify` passes, **v2 + v3 both true** (required for Android 11+) |
| Certificate | ✅ `CN=DSH Mobile, OU=DSH, O=DeepSeek`, RSA 2048 |
| badging | ✅ package / launcher activity / app label / minSdk 24 / both permissions all correct |
| APK contents | ✅ classes.dex + resources.arsc + all resources present |
| dex is not a stub | ✅ main class, 8 key methods, WebChromeClient and 5 resource ids all present |
| Auth chain (PC side) | ✅ self-signed cookie on the root path → **HTTP 200** |
| Frontend assets | ✅ `index.js` / `vendor.js` / both CSS files return 200 |

### ✅ Real device (2026-10-14 12:15, vivo V2254A / Android 16)

| Item | Result |
|---|---|
| Install | ✅ `adb install` Success |
| Reverse tunnel | ✅ `UsbFfs tcp:19387 tcp:19387` |
| **WebView renders DSH** | ✅ **fully rendered — whale logo, sidebar, composer, all normal** |
| **74 dynamic plugins** | ✅ loaded (the "Automated Tasks" panel renders completely, Chinese text intact) |
| **Live API data** | ✅ workspace name and balance shown — real values from the PC, not a static page |
| **WebSocket** | ✅ the frontend receives live state, proving the RPC channel works |
| Deep-link auto-connect | ✅ a single push is enough, nothing to type |
| Connect script | ✅ all five steps pass, **exit code 0**, device serial shown correctly |
| **Landscape layout** | ✅ top bar no longer covers DSH's title bar or its `···` / `⊞` buttons (**fixed after user feedback**) |
| **Collapse / expand top bar** | ✅ verified both ways: collapsed gives full-screen WebView with an edge handle; tapping it restores the bar |

### Not yet verified

- Feel of long-press / gesture interaction
- Whether the software keyboard covers the composer
- Screen rotation beyond landscape
- The file chooser for attachments (wired up via `onShowFileChooser`)
- Reconnect after a long time in the background

## 7. Known limitations

1. **The cable must stay plugged in.** Unplugging disconnects. This is inherent
   to `adb reverse` — and it is precisely why it is safer than opening the LAN.
2. **DSH sessions do not sync.** What you see on the phone is the session
   history on that PC, because DSH sessions live only on the local machine
   (there is no cloud sync; the DeepSeek Platform login only covers API quota).
3. **The cookie expires after 30 days.** Re-run `连接手机.ps1`.
4. **One phone at a time.** `adb reverse` applies per serial, but the script
   picks the first device by default.
5. **Portrait is cramped.** The DSH frontend is designed for a wide desktop
   window; landscape is noticeably better.

## 8. File layout

```
.
├── README.md                             ← Chinese
├── README.en.md                          ← this file
├── app\src\main\
│   ├── AndroidManifest.xml
│   ├── java\ai\deepseek\dsh\mobile\MainActivity.java
│   └── res\
│       ├── layout\activity_main.xml
│       ├── values\{strings,colors,styles}.xml
│       ├── drawable\{ic_whale_fg,ic_launcher_foreground}.xml
│       └── mipmap-*\ic_launcher.png
├── dist\DSH手机版-v1.0-debug.apk        ← the deliverable
├── 验收截图\                             ← real-device screenshots
└── _中间件\                              ← internal tooling
    ├── 连接手机.ps1                     ← one-shot connect
    └── tools\
        ├── build-apk.mjs                ← build script
        ├── dsh-mint-cookie.mjs          ← cookie minter
        ├── make-icon.py                 ← icon generator
        └── {diag,parse-boot,readline}.mjs
```

> ⚠️ **Not committed**: the build toolchain (~1 GB), `cookie.json`
> (**a signed session credential — effectively a key**), and signing keys.
> See `.gitignore`.
>
> The build staging area defaults to `C:\dsh-mobile-build\` (an ASCII path —
> reason in pitfall 3). It holds a toolchain copy and intermediate artifacts;
> delete it freely, the build recreates it.

## 9. Eight pitfalls hit along the way

### 1. ⚠️ `CookieManager.setCookie()` is asynchronous — you cannot call `loadUrl()` right after

**This is the only bug that surfaced exclusively on a real device.** The first
version of `connect()` did this:

```java
injectCookie(url, cookie);
webView.loadUrl(url);          // ← too early
```

The phone showed DSH's **401 page** (`dsh web authentication required`),
while the very same cookie tested as 200 with curl on the PC.

**Root cause**: when `setCookie()` returns, the cookie may not have reached the
WebView network stack yet. The first request therefore goes out without it and
DSH rejects it.

**Evidence**: pushing the deep link twice in a row — the first time gave the 401
page (73 KB screenshot), the second rendered the full UI (519 KB screenshot).
The cookie had only landed in the jar after the first attempt.

**Fix (three layers)**:

```java
// 1) delay navigation 350ms so setCookie can settle
webView.postDelayed(new Runnable() {
    public void run() { webView.loadUrl(targetUrl); }
}, 350);

// 2) onReceivedHttpError catches a main-frame 401 and reloads after 400ms
// 3) an authRetried flag ensures exactly one retry, so there is no loop
```

After the fix, **clearing app data plus a single deep-link push works directly** —
re-verified on the device.

### 2. `aapt2 compile -o` must be a directory

With `aapt2 compile <file> -o <some file>`, aapt2 writes a **zip**
(magic `PK\x03\x04`), and `link` then always fails with:

```
error: failed to read file: magic value is 0x04034b50 but AAPT expects 0x54504141
```

Passing a **directory** produces a proper `.flat` (magic `AAPT`).
Both four-byte headers were verified directly.

### 3. aapt2 cannot `stat` paths containing non-ASCII characters

With the toolchain under a **path containing Chinese characters**, aapt2 reports:

```
Failed to stat file '...\android-34\android.jar': No such file or directory
```

…even though `Test-Path` returns `True` and the file is right there.
The fix is to copy the toolchain to an ASCII path
(`C:\dsh-mobile-build\toolchain\`), which the build script prefers.

### 4. `.ps1` files need a UTF-8 BOM (**hit repeatedly**)

A `.ps1` without a BOM is parsed as GBK by Windows PowerShell, the Chinese text
turns to garbage, and it then reports a pile of unrelated
`Missing closing '}'` errors (at entirely bogus positions).

When writing, use:

```powershell
[System.IO.File]::WriteAllText($f, $c, (New-Object System.Text.UTF8Encoding($true)))
```

⚠️ **This is not a "remember once and you're immune" pitfall.** I wrote the
script with `write`, added the BOM, and it ran. Then I made one edit with
`edit` — which rewrites the file and **strips the BOM** — and the same fake
errors came back. During device debugging it bit me a third time.

→ **After editing any `.ps1`, re-check that the first three bytes are `EF BB BF`.**
→ Also: `[System.Management.Automation.PSParser]::Tokenize()` **will pass**
  (it reads with the current session's encoding), while `powershell -File`
  starts a new process that decides by BOM —
  **"my syntax check passed" and "it actually runs" are two different things.**

### 5. PowerShell collapses a single-element array, so the serial printed as "1"

During device debugging the script printed `已连接设备：1` instead of
`<device-serial>`.

**Root cause**: when `Where-Object` matches exactly one item, PowerShell
**unwraps the array into a scalar string**, and `$lines[0]` then returns the
**first character** `"1"` rather than the first line.

```powershell
# ❌ with a single device, $lines is a string
$lines = $devices -split "`r?`n" | Where-Object { $_ -match "`tdevice$" }

# ✅ force an array
$lines = @($devices -split "`r?`n" | Where-Object { $_ -match "`tdevice$" })
```

**Same family**: `$unauth.Count` is equally unreliable for a single element —
wrap it in `@()` too.

### 6. `$ErrorActionPreference='Stop'` turns adb's **status message** into a fatal error

During device debugging the script exited 1 at step 5, even though the phone had
**already successfully opened the app**.

**Root cause**: adb writes status to **stderr**. When the app is already in the
foreground, adb prints:

```
Warning: Activity not started, intent has been delivered to currently
running top-most instance.
```

This **is success** (the deep link reached the running instance), but under
`$ErrorActionPreference='Stop'` PowerShell 5.1 treats a native command's stderr
as a terminating error and aborts the script.

**Fix**: relax the preference temporarily and inspect the output text.

```powershell
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$amOut = & $AdbPath shell am start -a android.intent.action.VIEW -d "..." 2>&1 | Out-String
$ErrorActionPreference = $prev
$amOk = ($amOut -match 'Starting:') -or ($amOut -match 'Warning: Activity not started')
```

→ **In general**: whenever you call a native command that may write to stderr,
  **do not decide success from `$LASTEXITCODE` alone** — look at the output.

### 7. ⚠️ A top bar **floating above** the WebView covers DSH's own controls

**User feedback on the real device, 2026-10-14 12:22**: "landscape is much more
comfortable, but the top bar is too wide and now I can't tap the close-sidebar button."

**Cause**: the first layout treated the top bar as an **overlay**:

```xml
<FrameLayout>
    <WebView android:layout_height="match_parent" />   <!-- full height -->
    <LinearLayout id=topbar android:layout_gravity="top" />  <!-- floats above -->
    <Space android:layout_height="44dp" />              <!-- useless! cannot push a match_parent WebView -->
</FrameLayout>
```

The WebView is `match_parent`, so that `<Space>` **did nothing at all**
(I had assumed it would "reserve" room). The top bar therefore **physically
covered** the top 44dp of the WebView — which is exactly where DSH's own
title-bar buttons (`⊞` split view, `···` more) live. All of them became untappable.

**Correct layout**: let the top bar occupy **real layout height**, with the
WebView filling the remaining space below it.

```xml
<FrameLayout>
    <LinearLayout android:orientation="vertical">
        <LinearLayout id=topbar android:layout_height="38dp" />
        <WebView android:layout_height="0dp" android:layout_weight="1" />
    </LinearLayout>
    <!-- other overlays go here -->
</FrameLayout>
```

→ **A persistent custom control should occupy layout space; it should not float
  above content.** Overlays are for things that appear briefly — dialogs, toasts —
  not for a permanent toolbar.

**A collapse button was added too**: 38dp is precious in landscape, so tapping
`▴` hides the bar and gives the WebView the full screen, leaving only a
22×72dp translucent handle `‹` at the **right edge, vertically centered**.

⚠️ **The handle position was also found by trial**: top-right first, which
**covered DSH's `⊞` button**; bottom-right belongs to the whale widget. The
right edge, vertically centered, lands in empty space right of the content area.

### 8. Do not estimate tap coordinates from a thumbnail — measure with `uiautomator`

**Measured 2026-10-14 12:27.** Trying to tap the collapse button I had added
myself, I estimated `(2586, 222)` from a scaled screenshot and the tap
**did nothing**. Dumping the real hierarchy showed:

```
btn_collapse   bounds=[2904,144][3032,264]  center=(2968,204)
status_text    bounds=[154,174][2688,233]   ← where my tap actually landed
```

The tap had hit the **status text**, 380px off.

→ **Always measure before a precise tap**:

```powershell
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml
# match resource-id, read bounds, compute the center
```

→ A thumbnail is fine for "roughly what's on screen", but **not for computing
  coordinates** — especially when scaling compounds (device capture 1.05×, then
  preview downscale).

### Two smaller gotchas

- After a failed JDK download, using `curl -C -` to resume from a **different
  mirror** splices fragments from two sources into one zip
  ("local file header is corrupt"). **Delete the file and re-download; do not resume.**
- To test HTTP auth, use `curl.exe`. PowerShell's `Invoke-WebRequest` rewrites
  the `Cookie` header format — the same cookie tested 401 with it and 200 with curl.

## 10. Postscript: what real-device testing actually caught

**Three of the four real bugs in this project were only discoverable on a real device:**

| Pitfall | Discoverable on PC? |
|---|---|
| `setCookie` / `loadUrl` race | ❌ curl on the PC always returned 200 — completely invisible |
| Serial printing as "1" | ❌ with no device, `$lines` is empty and the code takes the "no device" branch, never reaching that line |
| adb warning treated as fatal | ❌ same — the warning only appears when the app is already in the foreground |

**So "it compiles, the signature is valid, and the PC-side chain works" is not the
same as "it works."** Had this stopped at "APK built successfully", what shipped
would have been an app that opens straight to a 401.
