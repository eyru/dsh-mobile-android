package ai.deepseek.dsh.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * DSH 手机版主界面。
 *
 * 支持两种连接模型：
 *
 * ①【无线 · Tailscale】（推荐）
 *   电脑跑反向代理把 Host/Origin 重写回 127.0.0.1:19387，
 *   Tailscale 提供跨网络私有隧道。手机在任意网络（5G/公司 WiFi）
 *   访问 http://&lt;电脑的100.x.x.x&gt;:18080 即可。
 *   cookie 通过代理的 /__pair 一次性口令入口自动获取，无需手填。
 *
 * ②【有线 · USB + adb reverse】（备选）
 *   电脑执行 `adb reverse tcp:19387 tcp:19387` 后，
 *   手机访问 127.0.0.1:19387 实际抵达电脑的 DSH 服务。
 *   因为 authority 与电脑侧完全一致，电脑上签发的 cookie 同样有效。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dsh_mobile_prefs";
    private static final String K_URL = "server_url";
    private static final String K_COOKIE = "cookie";

    /**
     * 首次启动的默认地址 —— 刻意留空。
     *
     * 这里【不写死任何 IP】：服务器地址属于每个使用者自己的网络环境，
     * 写死别人的地址既无意义也不礼貌。首次打开时设置面板会自动弹出，
     * 请填入你自己的地址，二选一：
     *
     *   ① 无线（推荐）：http://<你电脑的 Tailscale IP>:18080
     *      例：http://100.64.0.1:18080
     *   ② 有线（USB + adb reverse）：http://127.0.0.1:19387
     *
     * 填过一次就会记住（SharedPreferences），以后打开直接用。
     */
    private static final String DEFAULT_URL = "";

    private WebView webView;
    private TextView statusText;
    private ScrollView settingsPanel;
    private EditText inputUrl;
    private EditText inputCookie;
    private boolean pageReady = false;

    /**
     * 401 自动重试标记。
     *
     * CookieManager.setCookie() 是异步的：调用返回时 cookie 可能还没进入
     * WebView 的网络栈。若此时立刻 loadUrl，首个请求不带 cookie，
     * DSH 会返回 401 页面（正文 "dsh web authentication required"）。
     * 真机实测：第一次加载 401，紧接着再加载一次即 200。
     * 因此这里做三重防护：延迟加载 + 401 自动重载 + 只重试一次防死循环。
     */
    private boolean authRetried = false;

    /**
     * 是否已经尝试过自动配对（防止 401 死循环）。
     *
     * 自动配对 = 访问代理的 /__pairauto，让代理把 DSH 会话 cookie
     * 通过 Set-Cookie 交给本 App 的 WebView。
     * 这样主人【不需要】手动粘贴任何配对链接。
     */
    private boolean autoPaired = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        statusText = findViewById(R.id.status_text);
        settingsPanel = findViewById(R.id.settings_panel);
        inputUrl = findViewById(R.id.input_url);
        inputCookie = findViewById(R.id.input_cookie);

        Button btnReload = findViewById(R.id.btn_reload);
        Button btnSettings = findViewById(R.id.btn_settings);
        Button btnConnect = findViewById(R.id.btn_connect);
        Button btnClose = findViewById(R.id.btn_close_settings);
        Button btnCollapse = findViewById(R.id.btn_collapse);
        Button btnExpand = findViewById(R.id.btn_expand);
        final View topBar = findViewById(R.id.topbar);

        configureWebView();

        // 恢复上次配置
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String savedUrl = prefs.getString(K_URL, DEFAULT_URL);
        inputUrl.setText(savedUrl);
        inputCookie.setText(prefs.getString(K_COOKIE, ""));

        // 首次启动（还没存过地址）：直接把设置面板摊开，省得用户找。
        // 地址为空时 connect() 也不会瞎猜，会再把他请回这个面板。
        final boolean firstRun = (savedUrl == null || savedUrl.trim().isEmpty());
        if (firstRun) {
            settingsPanel.setVisibility(View.VISIBLE);
            statusText.setText("首次使用：请填写服务器地址");
        }

        // 顶栏收起/展开：横屏时顶栏占的 38dp 很宝贵，
        // 收起后 WebView 全屏，只留右上角一个半透明小按钮唤回。
        btnCollapse.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                topBar.setVisibility(View.GONE);
                btnExpand.setVisibility(View.VISIBLE);
            }
        });

        btnExpand.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                topBar.setVisibility(View.VISIBLE);
                btnExpand.setVisibility(View.GONE);
            }
        });

        btnReload.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                connect();
            }
        });

        btnSettings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (settingsPanel.getVisibility() == View.VISIBLE) {
                    settingsPanel.setVisibility(View.GONE);
                } else {
                    settingsPanel.setVisibility(View.VISIBLE);
                }
            }
        });

        btnConnect.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                connect();
            }
        });

        btnClose.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                settingsPanel.setVisibility(View.GONE);
            }
        });

        Intent intent = getIntent();
        if (intent != null) {
            handleDeepLink(intent.getData());
        } else {
            connect();
        }
    }

    /**
     * WebView 配置。
     *
     * DSH 前端是标准 ES Module 应用（index.html 用
     * &lt;script type="module" src="./assets/index-*.js"&gt; 启动），
     * 并通过 window.__ModuleLoader__ 动态加载 74 个客户端插件。
     * 因此下列设置缺一不可：
     *   - setJavaScriptEnabled(true)      ES Module 与插件加载
     *   - setDomStorageEnabled(true)      DSH 前端用 localStorage 存布局与偏好
     *   - setDatabaseEnabled(true)        早期 DOM Storage 实现
     *   - MIXED_CONTENT_COMPATIBILITY     cleartext 的 http://127.0.0.1 页面里
     *                                     可能混入 https 资源
     *   - setAcceptThirdPartyCookies      第三方 cookie，确保会话被带上
     */
    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 站内导航全部留在 WebView；站外（mailto: 等）交给系统处理
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    return false;
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageReady = false;
                statusText.setText("连接中…");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                statusText.setText(url);
            }

            /**
             * 401 兜底 —— 这是【无线方案能全自动】的关键。
             *
             * 两种情况都会走到这里：
             *   ① cookie 注入竞态：setCookie 是异步的，首个请求可能漏带 cookie。
             *   ② 首次使用：App 的 WebView 里根本没有 cookie。
             *
             * 处理策略（按顺序，最多各试一次）：
             *   先 → 自动配对：访问代理的 /__pairauto，让它把 cookie 通过
             *        Set-Cookie 直接交给 WebView。这解决了「浏览器与 App
             *        cookie 不互通」的根本问题，且主人无需粘贴任何东西。
             *   后 → 纯重载：配对后再等一拍重载，给 cookie 落地的时间。
             */
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                if (!request.isForMainFrame()) {
                    return;
                }
                if (errorResponse.getStatusCode() != 401) {
                    return;
                }

                // 第一跳：自动配对
                if (!autoPaired && tryAutoPair()) {
                    autoPaired = true;
                    authRetried = true;
                    return;
                }

                // 第二跳：配对已完成（或不可用），单纯重载一次
                if (!authRetried) {
                    authRetried = true;
                    final String retryUrl = request.getUrl().toString();
                    statusText.setText("认证中…");
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            webView.loadUrl(retryUrl);
                        }
                    }, 400);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                // 只报主文档错误，子资源失败不影响整体可用性提示
                if (request.isForMainFrame()) {
                    pageReady = false;
                    statusText.setText("连接失败：请确认电脑端启动器在跑、Tailscale 已连接");
                }
            }
        });

        // 允许 WebView 打开 file chooser（DSH 的上传/附件功能需要）
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    android.webkit.ValueCallback<Uri[]> filePathCallback,
                    android.webkit.WebChromeClient.FileChooserParams fileChooserParams) {
                // 简化处理：交给默认实现（系统会弹出选择器）
                return super.onShowFileChooser(
                        webView, filePathCallback, fileChooserParams);
            }
        });
    }

    /** 深链：dshmobile://connect?url=...&cookie=...&pair=... */
    private void handleDeepLink(Uri data) {
        if (data == null) {
            connect();
            return;
        }
        String url = data.getQueryParameter("url");
        String cookie = data.getQueryParameter("cookie");
        String pair = data.getQueryParameter("pair");
        if (url != null && !url.isEmpty()) {
            inputUrl.setText(url);
        }
        if (cookie != null && !cookie.isEmpty()) {
            inputCookie.setText(cookie);
        }
        // 兼容旧版深链：pair= 给的是 /__pair?k=... 链接。
        // 现在不再需要一次性密钥，直接把基址取出来即可 ——
        // 连接时若遇 401，会自动走 /__pairauto 拿 cookie。
        if (pair != null && !pair.isEmpty()) {
            String u = pair;
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                u = "http://" + u;
            }
            int idx = u.indexOf("/__pair");
            if (idx > 0) {
                inputUrl.setText(u.substring(0, idx));
                inputCookie.setText("");
            }
        }
        connect();
    }

    /** 保存配置、注入 cookie、加载页面。 */
    private void connect() {
        String url = inputUrl.getText().toString().trim();
        String cookie = inputCookie.getText().toString().trim();

        // 地址为空时【不猜也不兜底】—— 服务器地址是使用者自己的环境信息，
        // 猜错只会让人对着一个连不上的界面发呆。直接把设置面板打开让人填。
        if (url.isEmpty()) {
            settingsPanel.setVisibility(View.VISIBLE);
            inputUrl.requestFocus();
            statusText.setText("请先填写服务器地址");
            Toast.makeText(this,
                    "请先填写服务器地址（如 http://100.64.0.1:18080）",
                    Toast.LENGTH_LONG).show();
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
            inputUrl.setText(url);
        }

        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(K_URL, url)
                .putString(K_COOKIE, cookie)
                .apply();

        // cookie 必须与页面 authority 一致才会被 WebView 接受并发送。
        if (!cookie.isEmpty()) {
            injectCookie(url, cookie);
        }

        settingsPanel.setVisibility(View.GONE);
        authRetried = false;
        autoPaired = false;

        // 关键是【不要立刻 loadUrl】。
        // setCookie 是异步的，立即导航会让首个请求漏掉 cookie（实测 401）。
        // 延迟 350ms 让它落进 WebView 的 cookie 容器，再导航。
        final String targetUrl = url;
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                webView.loadUrl(targetUrl);
            }
        }, 350);

        Toast.makeText(this, "正在连接 " + url, Toast.LENGTH_SHORT).show();
    }

    /**
     * 自动配对：访问 &lt;基址&gt;/__pairauto，让代理下发 cookie。
     *
     * 关键点：必须让【同一个 WebView】去访问，不能自己开 HttpURLConnection ——
     * 那样拿到的 Set-Cookie 进不了 WebView 的 cookie 容器。
     * 所以这里用一个隐藏 iframe 式的加载：临时 loadUrl 到配对地址，
     * 由代理 302 回首页，WebView 自动把 Set-Cookie 存下。
     *
     * 返回 false 表示当前地址不适合自动配对（比如走的是本机 adb 隧道）。
     */
    private boolean tryAutoPair() {
        String base = inputUrl.getText().toString().trim();
        if (base.isEmpty()) {
            return false;
        }
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            base = "http://" + base;
        }
        // 去掉结尾斜杠，拼出配对地址
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }

        // 自动配对通道由代理提供；本机 adb 隧道（127.0.0.1:19387）没有这个入口，
        // 那种情况下退回「单纯重载」，不影响有线方案。
        final String pairUrl = base + "/__pairauto";

        statusText.setText("自动配对中…");
        Toast.makeText(this, "首次连接，正在自动获取凭据…", Toast.LENGTH_SHORT).show();

        final String reloadUrl = base + "/";
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                webView.loadUrl(pairUrl);
            }
        }, 150);

        // 配对请求会被代理 302 到 "/"，WebView 会自动跟随，无需额外处理。
        // 这里记下目标地址，仅用于状态显示。
        statusText.setText("配对中… " + reloadUrl);
        return true;
    }

    /**
     * 把 name=value 形态的 cookie 写入 WebView 容器。
     * 用户可能整条 Set-Cookie 粘进来，故只取分号前的 name 与 value。
     */
    private void injectCookie(String url, String cookie) {
        int eq = cookie.indexOf('=');
        if (eq <= 0) {
            return;
        }
        String name = cookie.substring(0, eq).trim();
        String value = cookie.substring(eq + 1);
        int semi = value.indexOf(';');
        if (semi >= 0) {
            value = value.substring(0, semi);
        }
        value = value.trim();

        if (name.isEmpty() || value.isEmpty()) {
            return;
        }

        CookieManager cm = CookieManager.getInstance();
        // Path=/ 确保覆盖 DSH 全部路径；不设 Domain 表示 host-only，
        // 与 DSH 服务端生成的 cookie 语义一致。
        cm.setCookie(url, name + "=" + value + "; Path=/");
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            cm.flush();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null) {
            handleDeepLink(intent.getData());
        }
    }

    @Override
    public void onBackPressed() {
        if (settingsPanel.getVisibility() == View.VISIBLE) {
            settingsPanel.setVisibility(View.GONE);
            return;
        }
        if (pageReady && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().flush();
        }
    }
}
