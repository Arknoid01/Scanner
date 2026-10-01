package fr.boucherieamiot.scanner;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;

/**
 * Rappel DLC du matin : tous les jours à 7 h 20, si des lots de la chambre froide ont une DLC
 * à moins de deux jours (dépassée, aujourd'hui ou demain), une notification les liste.
 * L'alarme se reprogramme elle-même pour le lendemain ; elle est aussi reposée au démarrage
 * de la tablette, après une mise à jour et à chaque ouverture de l'app.
 */
public class DlcAlarm extends BroadcastReceiver {
    private static final String TAG = "DlcAlarm";
    static final int HOUR = 7;
    static final int MINUTE = 20;
    private static final String CH_DLC = "dlc";
    private static final int ID_DLC = 3;
    private static final String ACTION = "fr.boucherieamiot.scanner.DLC_CHECK";

    @Override
    public void onReceive(Context c, Intent intent) {
        String a = intent.getAction();
        if (ACTION.equals(a)) check(c);
        schedule(c); // lendemain (ou reprogrammation après changement d'heure)
    }

    /** Programme la prochaine vérification à 7 h 20. */
    static void schedule(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, HOUR);
        next.set(Calendar.MINUTE, MINUTE);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis() + 1000) next.add(Calendar.DAY_OF_YEAR, 1);

        PendingIntent pi = PendingIntent.getBroadcast(c, 0,
                new Intent(c, DlcAlarm.class).setAction(ACTION),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long at = next.getTimeInMillis();
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                // Sans permission d'alarme exacte : Android peut décaler de quelques minutes
                am.setWindow(AlarmManager.RTC_WAKEUP, at, 10 * 60 * 1000L, pi);
            }
        } catch (SecurityException e) {
            am.setWindow(AlarmManager.RTC_WAKEUP, at, 10 * 60 * 1000L, pi);
        }
    }

    static boolean exactAllowed(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || (am != null && am.canScheduleExactAlarms());
    }

    /** Lit la chambre froide et notifie les lots à DLC courte. Renvoie le nombre de lots trouvés. */
    static int check(Context c) {
        List<String> lines = new ArrayList<>();
        int expired = 0;
        try {
            File f = new File(c.getFilesDir(), "data/chambre-froide.json");
            if (!f.exists()) return 0;
            JSONArray stock = new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd", Locale.FRANCE);
            Calendar cal = Calendar.getInstance();
            String today = iso.format(cal.getTime());
            cal.add(Calendar.DAY_OF_YEAR, 1);
            String tomorrow = iso.format(cal.getTime());
            for (int i = 0; i < stock.length(); i++) {
                JSONObject lot = stock.optJSONObject(i);
                if (lot == null) continue;
                String dlc = lot.optString("dlc", "");
                if (dlc.length() != 10 || dlc.compareTo(tomorrow) > 0) continue; // DLC dans 2 jours ou plus
                String when;
                if (dlc.compareTo(today) < 0) { when = "dépassée"; expired++; }
                else if (dlc.equals(today)) when = "aujourd'hui";
                else when = "demain";
                int qty = lot.optInt("qty", 1);
                lines.add("• " + lot.optString("nom", "?") + (qty > 1 ? " ×" + qty : "") + " — DLC " + when);
            }
        } catch (Exception e) {
            Log.w(TAG, "Lecture de la chambre froide impossible", e);
            return 0;
        }
        if (lines.isEmpty()) return 0;
        notify(c, lines, expired);
        return lines.size();
    }

    private static void notify(Context c, List<String> lines, int expired) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CH_DLC, "Rappel DLC du matin", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Lots de la chambre froide à DLC courte, chaque matin à 7 h 20");
        nm.createNotificationChannel(ch);

        Intent open = new Intent(c, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_DLC_ALERT, true);
        PendingIntent pi = PendingIntent.getActivity(c, 3, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String title = lines.size() + " lot" + (lines.size() > 1 ? "s" : "") + " à DLC courte en chambre froide";
        if (expired > 0) title = "🔴 " + title;
        NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle().setBigContentTitle(title);
        for (int i = 0; i < Math.min(lines.size(), 7); i++) style.addLine(lines.get(i));
        if (lines.size() > 7) style.setSummaryText("+ " + (lines.size() - 7) + " autres");

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_DLC)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(lines.get(0).substring(2) + (lines.size() > 1 ? "…" : ""))
                .setStyle(style)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(pi)
                .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(c).notify(ID_DLC, b.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notifications non autorisées", e);
        }
    }
}
