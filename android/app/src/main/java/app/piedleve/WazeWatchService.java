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
    private String foreground = "";
    private boolean handledThisWazeSession = false;
    private long lastQuery = 0;

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
            handler.postDelayed(this, 2000);
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
        lastQuery = System.currentTimeMillis() - 5000;
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
        UsageEvents ev = um.queryEvents(lastQuery, now);
        lastQuery = now;
        UsageEvents.Event e = new UsageEvents.Event();
        while (ev != null && ev.hasNextEvent()) {
            ev.getNextEvent(e);
            if (e.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) foreground = e.getPackageName();
        }
        lastForeground = foreground;
        if (!WAZE.equals(foreground)) {
            // Waze n'est plus devant (sauf si c'est Pied Levé lui-même) : la prochaine ouverture de Waze relancera un trajet
            if (!getPackageName().equals(foreground)) handledThisWazeSession = false;
            return;
        }
        if (handledThisWazeSession || BubblePlugin.tripActive) return;
        handledThisWazeSession = true;
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i == null) return;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("autostart", true);
        try {
            startActivity(i);
            launches++;
        } catch (Exception ex) {
            lastError = "ouverture de Pied Levé refusée : " + ex.getMessage();
        }
    }
}
