package fr.boucherieamiot.scanner;

import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    static final String EXTRA_FROM_SCANNER = "fromScanner";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScannerNativePlugin.class);
        super.onCreate(savedInstanceState);
        applyKeepScreenOn(Prefs.keepScreenOn(this));
        handleScannerIntent(getIntent());

        // Retour : page précédente dans l'app ; sur la page d'accueil, on met l'app en arrière-plan
        // au lieu de la fermer (elle reste prête pour le prochain scan)
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge().getWebView();
                if (wv.canGoBack()) wv.goBack();
                else moveTaskToBack(true);
            }
        });

        ScannerWatchService.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleScannerIntent(intent);
    }

    // Ouverte par la douchette : on allume l'écran (et on passe devant l'écran de verrouillage sans code)
    private void handleScannerIntent(Intent intent) {
        if (intent != null && intent.getBooleanExtra(EXTRA_FROM_SCANNER, false)) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        setShowWhenLocked(false);
        setTurnScreenOn(false);
    }

    void applyKeepScreenOn(boolean on) {
        runOnUiThread(() -> {
            if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }
}
