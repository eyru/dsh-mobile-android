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
 * 连接模型（USB + adb reverse）：
 *   电脑执行 `adb reverse tcp:19387 tcp:19387` 后，
 *   手机访问 127.0.0.1:19387 实际抵达电脑的 DSH 服务。
 *   因为 authority 与电脑侧完全一致（127.0.0.1:19387），
 *   电脑上签发的浏览器会话 cookie 在手机侧同样有效。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dsh_mobile_prefs";
    private static final String K_URL = "server_url";
    private static final String K_COOKIE = "cookie";

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
        inputUrl.setText(prefs.getString(K_URL, "http://127.0.0.1:19387"));
        inputCookie.setText(prefs.getString(K_COOKIE, ""));

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
             * 401 兜底：cookie 注入有竞态时，首个请求会拿到 401。
             * 此处延迟 400ms 重载一次（那时 cookie 已进容器），只重试一次。
             */
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                if (!request.isForMainFrame()) {
                    return;
                }
                if (errorResponse.getStatusCode() == 401 && !authRetried) {
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
                    statusText.setText("连接失败：请确认数据线、USB 调试与电脑端连接脚本");
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

    /** 深链：dshmobile://connect?url=...&cookie=... */
    private void handleDeepLink(Uri data) {
        if (data == null) {
            connect();
            return;
        }
        String url = data.getQueryParameter("url");
        String cookie = data.getQueryParameter("cookie");
        if (url != null && !url.isEmpty()) {
            inputUrl.setText(url);
        }
        if (cookie != null && !cookie.isEmpty()) {
            inputCookie.setText(cookie);
        }
        connect();
    }

    /** 保存配置、注入 cookie、加载页面。 */
    private void connect() {
        String url = inputUrl.getText().toString().trim();
        String cookie = inputCookie.getText().toString().trim();

        if (url.isEmpty()) {
            url = "http://127.0.0.1:19387";
            inputUrl.setText(url);
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
