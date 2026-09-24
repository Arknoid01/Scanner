package fr.boucherieamiot.scanner;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Pont entre la page web et Android :
 * fichiers de données, sauvegardes dans Téléchargements, douchette Bluetooth, permissions.
 */
@CapacitorPlugin(
        name = "ScannerNative",
        permissions = {
                @Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_CONNECT}),
                @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS}),
        }
)
public class ScannerNativePlugin extends Plugin {
    private static final String BACKUP_DIR = Environment.DIRECTORY_DOWNLOADS + "/ScannerBoucherie/";
    private static volatile ScannerNativePlugin current;

    @Override
    public void load() { current = this; }

    /** Événement envoyé à la page depuis le service de surveillance. */
    static void emit(String event) {
        ScannerNativePlugin p = current;
        if (p != null) p.notifyListeners(event, new JSObject());
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("appResumed", new JSObject());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent.getBooleanExtra(MainActivity.EXTRA_FROM_SCANNER, false)) {
            notifyListeners("scannerConnected", new JSObject());
        }
        if (intent.getBooleanExtra(MainActivity.EXTRA_DLC_ALERT, false)) {
            MainActivity.pendingDlcAlert = false;
            notifyListeners("dlcAlertOpened", new JSObject());
        }
    }

    // ═══ FICHIERS (dossier privé de l'app) ═══

    private File resolve(String path) throws IOException {
        if (path == null || path.isEmpty() || path.contains("..") || path.startsWith("/")) {
            throw new IOException("Chemin invalide : " + path);
        }
        return new File(getContext().getFilesDir(), path);
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            File f = resolve(call.getString("path"));
            JSObject ret = new JSObject();
            ret.put("exists", f.exists());
            if (f.exists()) ret.put("data", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Lecture impossible", e);
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        try {
            File f = resolve(call.getString("path"));
            String data = call.getString("data", "");
            File dir = f.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("Dossier impossible à créer");
            // Écriture atomique : fichier temporaire puis renommage (jamais de fichier à moitié écrit)
            File tmp = new File(dir, f.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(data.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(f)) throw new IOException("Renommage impossible");
            call.resolve();
        } catch (Exception e) {
            call.reject("Écriture impossible", e);
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        try {
            File f = resolve(call.getString("path"));
            if (f.exists() && !f.delete()) throw new IOException("Suppression impossible");
            call.resolve();
        } catch (Exception e) {
            call.reject("Suppression impossible", e);
        }
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        try {
            File dir = resolve(call.getString("dir"));
            JSArray arr = new JSArray();
            String[] names = dir.list();
            if (names != null) for (String n : names) if (!n.endsWith(".tmp")) arr.put(n);
            JSObject ret = new JSObject();
            ret.put("files", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Liste impossible", e);
        }
    }

    // ═══ SAUVEGARDE dans Téléchargements/ScannerBoucherie ═══

    @PluginMethod
    public void saveBackup(PluginCall call) {
        String filename = call.getString("filename");
        String base64 = call.getString("base64");
        int keep = call.getInt("keep", 14);
        if (filename == null || base64 == null) { call.reject("Paramètres manquants"); return; }
        ContentResolver cr = getContext().getContentResolver();
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        try {
            // Remplace la sauvegarde du jour si elle existe déjà
            for (Backup b : listBackups(cr)) {
                if (b.name.equals(filename)) cr.delete(b.uri, null, null);
            }
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            v.put(MediaStore.Downloads.MIME_TYPE, "application/zip");
            v.put(MediaStore.Downloads.RELATIVE_PATH, BACKUP_DIR);
            v.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = cr.insert(collection, v);
            if (uri == null) throw new IOException("Création du fichier refusée");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new IOException("Écriture refusée");
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            v.clear();
            v.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(uri, v, null, null);

            // Ne garde que les N plus récentes
            List<Backup> all = listBackups(cr);
            Collections.sort(all, (a, b) -> b.name.compareTo(a.name));
            for (int i = keep; i < all.size(); i++) cr.delete(all.get(i).uri, null, null);

            JSObject ret = new JSObject();
            ret.put("path", BACKUP_DIR + filename);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Sauvegarde impossible", e);
        }
    }

    private static final class Backup {
        final String name; final Uri uri;
        Backup(String name, Uri uri) { this.name = name; this.uri = uri; }
    }

    private List<Backup> listBackups(ContentResolver cr) {
        List<Backup> out = new ArrayList<>();
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        try (Cursor c = cr.query(collection,
                new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME},
                MediaStore.Downloads.RELATIVE_PATH + "=? AND " + MediaStore.Downloads.DISPLAY_NAME + " LIKE 'sauvegarde-%'",
                new String[]{BACKUP_DIR}, null)) {
            if (c == null) return out;
            while (c.moveToNext()) {
                long id = c.getLong(0);
                out.add(new Backup(c.getString(1), Uri.withAppendedPath(collection, String.valueOf(id))));
            }
        }
        return out;
    }

    // ═══ DOUCHETTE ET ÉTAT ═══

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject r = new JSObject();
        android.content.Context c = getContext();
        r.put("targetAddress", Prefs.targetAddress(c));
        r.put("targetName", Prefs.targetName(c));
        r.put("scannerConnected", Prefs.scannerConnected(c));
        r.put("serviceRunning", ScannerWatchService.running);
        r.put("watchEnabled", Prefs.watchEnabled(c));
        r.put("keepScreenOn", Prefs.keepScreenOn(c));
        r.put("bluetoothGranted", ScannerWatchService.hasBluetoothPermission(c));
        r.put("notificationsGranted", NotificationManagerCompat.from(c).areNotificationsEnabled());
        r.put("overlayGranted", Settings.canDrawOverlays(c));
        PowerManager pm = c.getSystemService(PowerManager.class);
        r.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        r.put("androidVersion", Build.VERSION.RELEASE);
        r.put("exactAlarmAllowed", DlcAlarm.exactAllowed(c));
        r.put("dlcAlarmTime", String.format(java.util.Locale.FRANCE, "%dh%02d", DlcAlarm.HOUR, DlcAlarm.MINUTE));
        call.resolve(r);
    }

    @PluginMethod
    public void listBondedDevices(PluginCall call) {
        if (!ScannerWatchService.hasBluetoothPermission(getContext())) { call.reject("Permission Bluetooth manquante"); return; }
        BluetoothManager bm = getContext().getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null) { call.reject("Pas de Bluetooth sur cet appareil"); return; }
        JSArray arr = new JSArray();
        try {
            for (BluetoothDevice d : adapter.getBondedDevices()) {
                JSObject o = new JSObject();
                o.put("name", d.getName() != null ? d.getName() : d.getAddress());
                o.put("address", d.getAddress());
                BluetoothClass bc = d.getBluetoothClass();
                // Les douchettes se présentent comme un périphérique d'entrée (clavier)
                o.put("likelyScanner", bc != null && bc.getMajorDeviceClass() == BluetoothClass.Device.Major.PERIPHERAL);
                arr.put(o);
            }
        } catch (SecurityException e) {
            call.reject("Permission Bluetooth manquante"); return;
        }
        JSObject ret = new JSObject();
        ret.put("devices", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void setTarget(PluginCall call) {
        Prefs.setTarget(getContext(), call.getString("address"), call.getString("name"));
        // Redémarre le service pour relire l'état de la nouvelle douchette
        ScannerWatchService.stop(getContext());
        ScannerWatchService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setWatchEnabled(PluginCall call) {
        boolean on = call.getBoolean("enabled", true);
        Prefs.setWatchEnabled(getContext(), on);
        if (on) ScannerWatchService.start(getContext());
        else ScannerWatchService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean on = call.getBoolean("on", true);
        Prefs.setKeepScreenOn(getContext(), on);
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).applyKeepScreenOn(on);
        call.resolve();
    }

    // ═══ RAPPEL DLC DU MATIN ═══

    /** App ouverte à froid depuis la notification DLC ? (le drapeau est consommé) */
    @PluginMethod
    public void takeDlcAlert(PluginCall call) {
        JSObject r = new JSObject();
        r.put("opened", MainActivity.pendingDlcAlert);
        MainActivity.pendingDlcAlert = false;
        call.resolve(r);
    }

    /** Lance la vérification tout de suite (bouton « Tester » des réglages). */
    @PluginMethod
    public void testDlcAlert(PluginCall call) {
        JSObject r = new JSObject();
        r.put("count", DlcAlarm.check(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        openSettings(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.parse("package:" + getContext().getPackageName())), call);
    }

    // ═══ IMPRESSION (window.print n'existe pas dans la WebView) ═══

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "Scanner Boucherie");
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getActivity().getSystemService(android.content.Context.PRINT_SERVICE);
                // Utilise les styles @media print de la page (seule la zone d'impression est visible)
                pm.print(name, getBridge().getWebView().createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Exception e) {
                call.reject("Impression impossible", e);
            }
        });
    }

    // ═══ PERMISSIONS ═══

    @PluginMethod
    public void requestBluetooth(PluginCall call) {
        if (getPermissionState("bluetooth") == PermissionState.GRANTED) { ScannerWatchService.start(getContext()); call.resolve(); return; }
        requestPermissionForAlias("bluetooth", call, "bluetoothResult");
    }

    @PermissionCallback
    private void bluetoothResult(PluginCall call) {
        if (getPermissionState("bluetooth") == PermissionState.GRANTED) {
            ScannerWatchService.start(getContext());
            call.resolve();
        } else {
            call.reject("Permission refusée");
        }
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) { call.resolve(); return; }
        requestPermissionForAlias("notifications", call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        openSettings(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())), call);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        openSettings(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getContext().getPackageName())), call);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openSettings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName())), call);
    }

    @PluginMethod
    public void openBluetoothSettings(PluginCall call) {
        openSettings(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS), call);
    }

    private void openSettings(Intent i, PluginCall call) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Réglage introuvable sur cet appareil", e);
        }
    }
}
