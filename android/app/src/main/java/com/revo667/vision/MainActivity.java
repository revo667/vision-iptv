package com.revo667.vision;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/www/renderer/index.html";

    private WebView web;
    private FrameLayout root;
    private Stores stores;
    private WebViewAssetLoader assets;
    private boolean isTv;
    private volatile boolean editing;
    private int imeBottom;
    private long lastBack;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        stores = new Stores(this);
        isTv = detectTv(this);

        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#09080E"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#09080E"));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // TV: tam ekran. Telefon/tablet: durum ve gezinme çubukları görünür, içerik aralarına oturur
        if (isTv) hideSystemBars();
        else if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);

        // Sistem çubukları ve ekran klavyesi kadar boşluk bırak (kenardan kenara düzende adjustResize çalışmaz)
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top = 0, left = 0, right = 0, bottom, ime;
            if (Build.VERSION.SDK_INT >= 30) {
                ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                bottom = ime;
                if (!isTv) {
                    android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    top = bars.top;
                    left = bars.left;
                    right = bars.right;
                    bottom = Math.max(ime, bars.bottom);
                }
            } else {
                ime = isTv ? insets.getSystemWindowInsetBottom() : 0; // eski sürümlerde pencere klavyeye göre zaten küçülür
                bottom = ime;
            }
            boolean was = imeBottom > 0;
            imeBottom = ime;
            v.setPadding(left, top, right, bottom);
            if (was != (ime > 0)) emitSimple("ime", ime > 0);
            return insets;
        });

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // IPTV görselleri çoğunlukla http
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        assets = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost()) && ApiProxy.PATH.equals(u.getPath())) return ApiProxy.handle(u);
                return assets.shouldInterceptRequest(u);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openUrl(u.toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d("VisionWeb", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "VisionAndroid");

        PlayerSession.listener = this::emit;

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        if (state == null) web.loadUrl(START_URL);
        else web.restoreState(state);
        web.requestFocus();
    }

    static boolean detectTv(Context ctx) {
        UiModeManager ui = (UiModeManager) ctx.getSystemService(Context.UI_MODE_SERVICE);
        if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        PackageManager pm = ctx.getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) || pm.hasSystemFeature("android.software.leanback_only");
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && isTv) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        PlayerSession.listener = this::emit;
    }

    @Override
    protected void onPause() {
        web.onPause(); // animasyonları durdurur, JavaScript çalışmaya devam eder
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (PlayerSession.listener != null) PlayerSession.listener = null;
        web.destroy();
        super.onDestroy();
    }

    /* ---------- Geri tuşu: önce arayüz (pencere, arama, sayfa geçmişi), sonra çıkış ---------- */
    private void handleBack() {
        web.evaluateJavascript("window.__vzBack ? window.__vzBack() : false", r -> {
            if ("true".equals(r)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2200) {
                finish();
            } else {
                lastBack = now;
                Toast.makeText(this, "Çıkmak için tekrar geri tuşuna bas", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    private boolean imeVisible() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets in = getWindow().getDecorView().getRootWindowInsets();
            return in != null && in.isVisible(WindowInsets.Type.ime());
        }
        return imeBottom > 0;
    }

    private void showKeyboard() {
        showKeyboard(0);
    }

    // WebView'in giriş bağlantısı hazır olmayabilir: birkaç kez dene
    private void showKeyboard(int attempt) {
        if (!web.hasFocus()) web.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(web, 0);
        if (attempt < 4) web.postDelayed(() -> {
            if (!imeVisible()) showKeyboard(attempt + 1);
        }, 200);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (Build.VERSION.SDK_INT < 33 && k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP && !e.isCanceled()) handleBack();
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    /* ---------- Yardımcılar ---------- */
    void emit(JSONObject ev) {
        final String js = "window.__vzEmit && window.__vzEmit(" + ev.toString() + ")";
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    private void emitSimple(String type, boolean visible) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            o.put("visible", visible);
            emit(o);
        } catch (Exception ignored) {
        }
    }

    private void openUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Bu bağlantıyı açacak uygulama yok", Toast.LENGTH_SHORT).show();
        }
    }

    static boolean openExternal(Activity act, String url, String title) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(url), "video/*");
            if (title != null) {
                i.putExtra("title", title);
                i.putExtra(Intent.EXTRA_TITLE, title);
            }
            act.startActivity(Intent.createChooser(i, "Şununla oynat"));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------- Arayüze açılan köprü (window.VisionAndroid) ---------- */
    private class Bridge {
        @JavascriptInterface
        public String info() {
            try {
                JSONObject o = new JSONObject();
                o.put("platform", "android");
                o.put("tv", isTv);
                o.put("version", BuildConfig.VERSION_NAME);
                o.put("versionCode", BuildConfig.VERSION_CODE);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
                return o.toString();
            } catch (Exception e) {
                return "{\"platform\":\"android\"}";
            }
        }

        @JavascriptInterface
        public String getAccount() {
            return stores.getAccount();
        }

        @JavascriptInterface
        public boolean setAccount(String json) {
            return stores.setAccount(json);
        }

        @JavascriptInterface
        public String storeAll() {
            return stores.libraryAll();
        }

        @JavascriptInterface
        public void storeSet(String key, String json) {
            stores.librarySet(key, json);
        }

        @JavascriptInterface
        public void storeSetMany(String json) {
            stores.librarySetMany(json);
        }

        @JavascriptInterface
        public void play(String opts) {
            PlayerSession.pendingOpts = opts;
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, PlayerActivity.class)));
        }

        @JavascriptInterface
        public void updatePlayer(String json) {
            PlayerActivity p = PlayerSession.active;
            if (p != null) p.update(json);
        }

        @JavascriptInterface
        public boolean openExternal(String url, String title) {
            if (url == null || !url.matches("^https?://.*")) return false;
            runOnUiThread(() -> MainActivity.openExternal(MainActivity.this, url, title));
            return true;
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (url != null && url.matches("^https?://.*")) runOnUiThread(() -> MainActivity.this.openUrl(url));
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Vision", text));
            });
        }

        @JavascriptInterface
        public void setEditing(boolean on) {
            editing = on;
        }

        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(MainActivity.this::showKeyboard);
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }

        @JavascriptInterface
        public void checkUpdate(boolean manual) {
            Updater.check(manual, MainActivity.this::emit);
        }

        @JavascriptInterface
        public void installUpdate() {
            Updater.install(MainActivity.this, MainActivity.this::emit);
        }
    }
}
