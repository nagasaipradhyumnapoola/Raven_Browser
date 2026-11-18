package app.raven.master;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

/** The dashboard: the same one as on the desktop, served by the master on this phone (127.0.0.1 only). */
public class MainActivity extends Activity {
    private WebView web;
    private TextView status;
    private FrameLayout root;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private int waited = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.parseColor("#161514"));
        getWindow().setNavigationBarColor(Color.parseColor("#161514"));
        status = new TextView(this);
        status.setText("Starting Raven Master…");
        status.setTextColor(Color.parseColor("#e9e5df"));
        status.setBackgroundColor(Color.parseColor("#161514"));
        status.setGravity(Gravity.CENTER);
        status.setTextSize(16);
        // Android 15 draws apps under the status and navigation bars; keep the content clear of them.
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#161514"));
        root.setOnApplyWindowInsetsListener((View v, WindowInsets insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        root.addView(status, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        MasterService.start(this);
        waitForMaster();
    }

    private void waitForMaster() {
        new Thread(() -> {
            boolean ok = MasterService.ready() && MasterService.token != null;
            ui.post(() -> {
                if (ok) showDashboard();
                else if (MasterService.lastError != null) status.setText("Raven Master could not start:\n" + MasterService.lastError);
                else {
                    waited++;
                    if (waited > 40) status.setText("Still starting… (first start unpacks files, it can take a minute)");
                    ui.postDelayed(this::waitForMaster, 400);
                }
            });
        }).start();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showDashboard() {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#161514"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                // Links to the outside open in the phone's browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                    // no browser
                }
                return true;
            }
        });
        web.loadUrl("http://127.0.0.1:" + MasterService.DASH_PORT + "/#t=" + MasterService.token);
        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
