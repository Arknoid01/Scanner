package fr.boucherieamiot.scanner;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Relance la surveillance de la douchette au démarrage de la tablette et après une mise à jour de l'app. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            ScannerWatchService.start(context);
        }
    }
}
