package app.piedleve;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;

/**
 * Démarrage automatique : surveille (toutes les 2 s, via « Accès aux données d'utilisation »)
 * l'appli au premier plan. Quand Waze s'ouvre et qu'aucun trajet n'est en cours, ouvre
 * Pied Levé une fraction de seconde pour lancer le trajet ; Pied Levé se remet ensuite derrière Waze.
 */
public class WazeWatchService extends Service {

    static final String PREFS = "pied-leve";
    static final String KEY_ON = "autostart";
    static final String WAZE = "com.waze";
    private static final String CHANNEL = "pl-watch";
    private static final int NOTIF_ID = 4242;

    private final Handler handler = new Handler(Looper.getMainLooper());
    // Compte rendu pour le journal de l'appli
    static volatile boolean running = false;
    static volatile long lastTick = 0;
    static volatile String lastForeground = "";
    static volatile int launches = 0;
    static volatile String lastError = "";
    static volatile long lastWazeSeen = 0;
    private String foreground = "";
    // appli au premier plan lors de la vérification précédente (pour repérer le passage à Waze)
    private String prevForeground = "";

    /**
     * « Accès aux données d'utilisation » accordé ? Selon les téléphones, Android répond « autorisé »
     * ou « par défaut » : dans ce dernier cas on vérifie la permission, et en dernier recours on essaie
     * de lire les données (si on y arrive, l'accès est accordé).
     */
    static boolean usageGranted(Context c) {
        try {
            android.app.AppOpsManager ops = (android.app.AppOpsManager) c.getSystemService(Context.APP_OPS_SERVICE);
            int uid = android.os.Process.myUid();
            int mode = Build.VERSION.SDK_INT >= 29
                    ? ops.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, uid, c.getPackageName())
                    : ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, uid, c.getPackageName());
            if (mode == android.app.AppOpsManager.MODE_ALLOWED) return true;
            if (mode == android.app.AppOpsManager.MODE_DEFAULT
                    && c.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                return true;
        } catch (Exception ignored) {
        }
        try {
            UsageStatsManager um = (UsageStatsManager) c.getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            java.util.List<android.app.usage.UsageStats> l = um.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 86400000L, now);
            return l != null && !l.isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    static boolean isOn(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_ON, false);
    }

    static void setOn(Context c, boolean on) {
        SharedPreferences.Editor e = c.getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        e.putBoolean(KEY_ON, on);
        e.apply();
        Intent i = new Intent(c, WazeWatchService.class);
        if (on) {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } else {
            c.stopService(i);
        }
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            try {
                check();
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
            }
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Démarrage avec Waze", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Pied Levé démarre avec Waze")
                .setContentText("Le trajet se lance tout seul quand vous ouvrez Waze.")
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, n);
        running = true;
        handler.post(tick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!isOn(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void check() {
        UsageStatsManager um = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
        if (um == null) return;
        long now = System.currentTimeMillis();
        lastTick = now;
        // Fenêtre glissante de 20 s : Android enregistre parfois l'ouverture d'une appli avec retard.
        // On garde le dernier passage au premier plan trouvé (s'il n'y en a pas, l'appli devant n'a pas changé).
        UsageEvents ev = um.queryEvents(now - 20000, now);
        UsageEvents.Event e = new UsageEvents.Event();
        long bestT = -1;
        String best = null;
        while (ev != null && ev.hasNextEvent()) {
            ev.getNextEvent(e);
            if (e.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND && e.getTimeStamp() >= bestT) {
                bestT = e.getTimeStamp();
                best = e.getPackageName();
            }
        }
        if (best != null) foreground = best;
        lastForeground = foreground;
        BubblePlugin.onForeground(foreground);
        boolean arrived = WAZE.equals(foreground) && !WAZE.equals(prevForeground);
        prevForeground = foreground;
        if (!WAZE.equals(foreground)) return;
        lastWazeSeen = now;
        // On ne réagit qu'au moment où Waze passe devant (quelle que soit l'appli d'avant, Pied Levé compris)
        if (!arrived) return;
        if (BubblePlugin.tripActive) return; // trajet déjà en cours (cas normal après un démarrage automatique)
        final long launchAt = now;
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i == null) return;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        i.putExtra("autostart", true);
        try {
            startActivity(i);
            launches++;
        } catch (Exception ex) {
            lastError = "ouverture de Pied Levé refusée : " + ex.getMessage();
        }
        // Android peut bloquer l'ouverture sans rien dire : si Pied Levé n'est pas passé devant après 3 s,
        // on propose une notification à toucher pour démarrer.
        handler.postDelayed(() -> {
            if (BubblePlugin.lastResumeAt < launchAt && !BubblePlugin.tripActive) {
                lastError = "ouverture bloquée par Android : notification proposée";
                notifyStart();
            }
        }, 3000);
    }

    private static final String CHANNEL_START = "pl-start";
    static final int START_NOTIF_ID = 4243;

    private void notifyStart() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_START, "Démarrer avec Waze", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open == null) return;
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        open.putExtra("autostart", true);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_START)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Waze est ouvert")
                .setContentText("Touchez pour démarrer Pied Levé")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
                .setAutoCancel(true)
                .setTimeoutAfter(120000)
                .setContentIntent(pi)
                .build();
        nm.notify(START_NOTIF_ID, n);
    }
}
