package fr.boucherieamiot.scanner;

import android.content.Context;
import android.content.SharedPreferences;

/** Réglages natifs persistants (douchette choisie, écran allumé, surveillance active). */
final class Prefs {
    static final String TARGET_ADDRESS = "target_address";
    static final String TARGET_NAME = "target_name";
    static final String SCANNER_CONNECTED = "scanner_connected";
    static final String KEEP_SCREEN_ON = "keep_screen_on";
    static final String WATCH_ENABLED = "watch_enabled";

    private Prefs() {}

    static SharedPreferences get(Context c) {
        return c.getSharedPreferences("scanner", Context.MODE_PRIVATE);
    }

    static String targetAddress(Context c) { return get(c).getString(TARGET_ADDRESS, null); }
    static String targetName(Context c) { return get(c).getString(TARGET_NAME, null); }
    static boolean scannerConnected(Context c) { return get(c).getBoolean(SCANNER_CONNECTED, false); }
    static boolean keepScreenOn(Context c) { return get(c).getBoolean(KEEP_SCREEN_ON, true); }
    static boolean watchEnabled(Context c) { return get(c).getBoolean(WATCH_ENABLED, true); }

    static void setTarget(Context c, String address, String name) {
        get(c).edit().putString(TARGET_ADDRESS, address).putString(TARGET_NAME, name)
                .putBoolean(SCANNER_CONNECTED, false).apply();
    }

    static void setScannerConnected(Context c, boolean v) { get(c).edit().putBoolean(SCANNER_CONNECTED, v).apply(); }
    static void setKeepScreenOn(Context c, boolean v) { get(c).edit().putBoolean(KEEP_SCREEN_ON, v).apply(); }
    static void setWatchEnabled(Context c, boolean v) { get(c).edit().putBoolean(WATCH_ENABLED, v).apply(); }
}
