package fr.boucherieamiot.scanner;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Service de premier plan (notification permanente) qui garde l'app en vie
 * et écoute la connexion Bluetooth de la douchette choisie.
 * Quand elle se connecte, l'app passe au premier plan.
 */
public class ScannerWatchService extends Service {
    private static final String TAG = "ScannerWatch";
    private static final String CH_WATCH = "surveillance";
    private static final String CH_ALERT = "douchette";
    private static final int ID_WATCH = 1;
    private static final int ID_ALERT = 2;

    static volatile boolean running = false;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            String target = Prefs.targetAddress(ctx);
            if (device == null || target == null) return;
            String address;
            try { address = device.getAddress(); } catch (SecurityException e) { return; }
            if (!target.equalsIgnoreCase(address)) return;

            boolean connected = BluetoothDevice.ACTION_ACL_CONNECTED.equals(intent.getAction());
            Prefs.setScannerConnected(ctx, connected);
            updateWatchNotification();
            ScannerNativePlugin.emit(connected ? "scannerConnected" : "scannerDisconnected");
            if (connected) bringAppToFront();
        }
    };

    /** Démarre la surveillance si elle est activée et si la permission Bluetooth est accordée. */
    static void start(Context c) {
        if (!Prefs.watchEnabled(c) || !hasBluetoothPermission(c)) return;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, ScannerWatchService.class));
        } catch (Exception e) {
            Log.w(TAG, "Démarrage du service impossible", e);
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ScannerWatchService.class));
    }

    static boolean hasBluetoothPermission(Context c) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || ContextCompat.checkSelfPermission(c, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        try {
            ServiceCompat.startForeground(this, ID_WATCH, buildWatchNotification(),
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE : 0);
        } catch (Exception e) {
            Log.w(TAG, "startForeground refusé", e);
            stopSelf();
            return;
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
        filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        Prefs.setScannerConnected(this, isTargetConnectedNow());
        updateWatchNotification();
        running = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        try { unregisterReceiver(receiver); } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void bringAppToFront() {
        Intent i = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_FROM_SCANNER, true);
        // Avec « Superposition sur d'autres apps », Android autorise le passage au premier plan depuis l'arrière-plan
        if (Settings.canDrawOverlays(this)) {
            try {
                startActivity(i);
                return;
            } catch (Exception e) {
                Log.w(TAG, "Passage au premier plan refusé", e);
            }
        }
        // Sinon : notification à toucher
        PendingIntent pi = PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CH_ALERT)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("Douchette connectée")
                .setContentText("Touchez pour ouvrir le scanner")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(ID_ALERT, n);
    }

    // Tentative de lecture de l'état actuel (API cachée : si Android refuse, on suppose « déconnectée »)
    private boolean isTargetConnectedNow() {
        String target = Prefs.targetAddress(this);
        if (target == null) return false;
        try {
            BluetoothAdapter adapter = getSystemService(BluetoothManager.class).getAdapter();
            if (adapter == null) return false;
            BluetoothDevice d = adapter.getRemoteDevice(target);
            return (boolean) BluetoothDevice.class.getMethod("isConnected").invoke(d);
        } catch (Exception e) {
            return false;
        }
    }

    private void createChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_WATCH, "Surveillance douchette", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CH_ALERT, "Douchette connectée", NotificationManager.IMPORTANCE_HIGH));
    }

    private Notification buildWatchNotification() {
        String name = Prefs.targetName(this);
        String text;
        if (name == null) text = "Aucune douchette choisie — ouvrez les réglages";
        else if (Prefs.scannerConnected(this)) text = name + " : connectée";
        else text = "En attente de " + name;
        PendingIntent open = PendingIntent.getActivity(this, 1,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CH_WATCH)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("Scanner Boucherie actif")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(open)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    private void updateWatchNotification() {
        getSystemService(NotificationManager.class).notify(ID_WATCH, buildWatchNotification());
    }
}
