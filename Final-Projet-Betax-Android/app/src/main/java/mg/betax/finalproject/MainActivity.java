package mg.betax.finalproject;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Conteneur Android Natif (Interface web et executer dans une app Android). */
public class MainActivity extends Activity {
    private static final int LOCATION_REQUEST_CODE = 4401;
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";

    private WebView webView;
    // Replace this generated value with the final Render URL before building the APK.
    private static final String BACKEND_URL = BuildConfig.BACKEND_URL;
    private String pendingOrigin;
    private GeolocationPermissions.Callback pendingGeolocationCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyNativeTheme("light");

        webView = new WebView(this);
        webView.addJavascriptInterface(new BetaxBridge(), "BetaxAndroid");
        setContentView(webView);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String origin = uri.getScheme() + "://" + uri.getHost();
                if (APP_ORIGIN.equals(origin)) return false;
                String scheme = uri.getScheme();
                if ("mailto".equals(scheme) || "tel".equals(scheme) || "http".equals(scheme) || "https".equals(scheme)) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                // Utilisation de startsWith pour gérer le slash final éventuel
                if (origin == null || !origin.startsWith(APP_ORIGIN)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, true);
                    return;
                }
                pendingOrigin = origin;
                pendingGeolocationCallback = callback;
                requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }, LOCATION_REQUEST_CODE);
            }
        });

        WebView.setWebContentsDebuggingEnabled(true);
        webView.loadUrl(APP_ORIGIN + "/assets/www/index.html");
    }

    private final class BetaxBridge {
        @JavascriptInterface
        public void setTheme(final String theme) {
            runOnUiThread(() -> applyNativeTheme("dark".equals(theme) ? "dark" : "light"));
        }

        @JavascriptInterface
        public void sendChatMessage(final String payloadJson) {
            // Runs network request off the UI thread and returns response to webview
            new Thread(() -> {
                try {
                    URL url = new URL(BACKEND_URL + "/chat");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    conn.setDoOutput(true);
                    byte[] out = payloadJson.getBytes(StandardCharsets.UTF_8);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(out);
                    }
                    int code = conn.getResponseCode();
                    InputStream is = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
                    BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                    String response = sb.toString();
                    final String jsResponse = response
                            .replace("\\", "\\\\")
                            .replace("\"", "\\\"")
                            .replace("\n", "\\n")
                            .replace("\r", "\\r");
                    runOnUiThread(() -> {
                        if (webView != null) {
                            webView.evaluateJavascript("window.handleNativeResponse && window.handleNativeResponse(\"" + jsResponse + "\")", null);
                        }
                    });
                } catch (Exception e) {
                    final String err = (e.getMessage() == null) ? "unknown" : e.getMessage()
                            .replace("\\", "\\\\")
                            .replace("\"", "\\\"")
                            .replace("\n", "\\n");
                    runOnUiThread(() -> {
                        if (webView != null) webView.evaluateJavascript("window.handleNativeError && window.handleNativeError(\"" + err + "\")", null);
                    });
                }
            }).start();
        }
    }

    private void applyNativeTheme(String theme) {
        boolean dark = "dark".equals(theme);
        int background = Color.parseColor(dark ? "#071522" : "#EEF8FF");
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == LOCATION_REQUEST_CODE && pendingGeolocationCallback != null) {
            boolean granted = hasLocationPermission();
            pendingGeolocationCallback.invoke(pendingOrigin, granted, granted);
            pendingGeolocationCallback = null;
            pendingOrigin = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
