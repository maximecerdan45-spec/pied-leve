package app.piedleve;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AppOpsManager;
import android.os.Process;
import android.content.pm.PackageManager;
import android.os.PowerManager;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bulle flottante « façon Messenger » affichée par-dessus les autres applis (ex. Waze)
 * pendant un trajet : couleur selon le conseil, consigne courte et distance.
 * On peut la déplacer ; la toucher ramène dans Pied Levé.
 */
@CapacitorPlugin(name = "Bubble")
public class BubblePlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private WindowManager.LayoutParams lp;
    private android.widget.FrameLayout bubble;
    private LinearLayout card;
    // Jauge d'approche : la carte se remplit d'orange jusqu'au moment de lever le pied
    private android.graphics.drawable.ClipDrawable fill;
    private float progress = -1f, rate = 0f, fillRate = 0f;
    private android.animation.ValueAnimator fillAnim;
    // Compte à rebours « levez dans … m » : l'appli envoie la distance et la vitesse, la bulle fait défiler
    // les mètres et la jauge d'elle-même (image par image), sans jamais remonter
    private float meters = -1f, mps = 0f, cdBase = -1f;
    private long cdT0 = 0;
    private String cdKey = "", cdShownKey = "", cdText = "";
    private static final float GAUGE_D = 350f;
    private final Runnable cdTick = new Runnable() {
        @Override
        public void run() {
            if (cdBase < 0 || bubble == null || !shown) return;
            countdownDraw();
            main.postDelayed(this, 50);
        }
    };
    private BubbleIcon icon;
    private int curColor = 0;
    private String lastL2 = null;
    private String curIcon = "";
    private TextView line1;
    private TextView line2;
    private GradientDrawable shape;
    private boolean shown = false;
    // Lu par la veille « Waze » : un trajet est-il déjà en cours ?
    static volatile boolean tripActive = false;
    // Appli ouverte par la veille « Waze » : la page doit lancer un trajet
    static volatile boolean autostartPending = false;
    // Dernier passage de Pied Levé au premier plan (la veille vérifie que l'ouverture a bien eu lieu)
    static volatile long lastResumeAt = 0;
    // Fin de trajet demandée par la personne (la veille ne relance pas aussitôt)
    static volatile long lastManualEnd = 0;
    private static BubblePlugin instance;

    @Override
    public void load() {
        instance = this;
        // La veille « Waze » s'arrête quand l'appli est fermée par le système : on la relance à chaque ouverture
        try {
            if (WazeWatchService.isOn(getContext()) && !WazeWatchService.running && usageGranted()) WazeWatchService.setOn(getContext(), true);
        } catch (Exception ignored) {
        }
    }

    /**
     * Appelé chaque seconde par la veille avec l'appli au premier plan : la bulle ne reste
     * que par-dessus Waze (cachée sur l'écran d'accueil ou dans les autres applis).
     */
    static void onForeground(String pkg) {
        final BubblePlugin p = instance;
        if (p == null || pkg == null || pkg.isEmpty()) return;
        if (pkg.equals(p.getContext().getPackageName())) return; // info pas encore à jour : on ne touche à rien
        p.main.post(() -> {
            if (!p.armed || !p.inBack) return;
            if (WazeWatchService.WAZE.equals(pkg)) {
                if (p.canDraw()) p.display();
            } else p.remove();
        });
    }

    static void fireAutostart() {
        if (instance != null) instance.notifyListeners("autostart", new JSObject());
    }

    private boolean usageGranted() {
        return WazeWatchService.usageGranted(getContext());
    }

    @PluginMethod
    public void consumeAutostart(PluginCall call) {
        JSObject r = new JSObject();
        r.put("pending", autostartPending);
        autostartPending = false;
        call.resolve(r);
    }

    /** Remet Pied Levé derrière (Waze revient devant). */
    @PluginMethod
    public void toBack(PluginCall call) {
        final long asked = call.getLong("t", 0L);
        if (getActivity() != null) getActivity().runOnUiThread(() -> {
            getActivity().moveTaskToBack(true);
            getActivity().overridePendingTransition(0, 0); // retour vers Waze sans animation
        });
        JSObject r = new JSObject();
        r.put("queued", asked > 0 ? Math.max(0, System.currentTimeMillis() - asked) : -1);
        call.resolve(r);
    }

    /** État de la veille « Waze », pour le journal. */
    @PluginMethod
    public void watchStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("on", WazeWatchService.isOn(getContext()));
        r.put("usage", usageGranted());
        r.put("running", WazeWatchService.running);
        r.put("ago", WazeWatchService.lastTick == 0 ? -1 : (System.currentTimeMillis() - WazeWatchService.lastTick) / 1000);
        r.put("foreground", WazeWatchService.lastForeground);
        r.put("launches", WazeWatchService.launches);
        r.put("wazeAgo", WazeWatchService.lastWazeSeen == 0 ? -1 : (System.currentTimeMillis() - WazeWatchService.lastWazeSeen) / 1000);
        r.put("lastError", WazeWatchService.lastError);
        call.resolve(r);
    }

    @PluginMethod
    public void setAutoStart(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            WazeWatchService.setOn(getContext(), on && usageGranted());
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }
    // Trajet en cours : la bulle s'affiche d'elle-même quand l'appli passe en arrière-plan
    private boolean armed = false;
    // Pied Levé est derrière une autre appli
    private boolean inBack = false;
    private String color = "#3A4440", text1 = "PIED LEVÉ", text2 = "", iconKind = "wait";
    // Compte rendu pour le journal de l'appli
    private int pauses = 0, shows = 0;
    private String lastError = "";

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getContext().getResources().getDisplayMetrics()));
    }

    private boolean canDraw() {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(getContext());
    }

    /* ===== Préparation du téléphone : état des réglages nécessaires et accès direct à chacun ===== */

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void checkSetup(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        r.put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        r.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS)));
        r.put("overlay", canDraw());
        boolean battery = true;
        if (Build.VERSION.SDK_INT >= 23) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            battery = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        }
        r.put("battery", battery);
        r.put("usage", usageGranted());
        r.put("autostart", WazeWatchService.isOn(ctx) && usageGranted());
        r.put("waze", ctx.getPackageManager().getLaunchIntentForPackage(WazeWatchService.WAZE) != null);
        r.put("maker", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase());
        call.resolve(r);
    }

    /** Ouvre le bon écran pour un réglage. « first » : première tentative (fenêtre d'autorisation Android). */
    @PluginMethod
    public void openSetting(PluginCall call) {
        String what = call.getString("what", "app");
        boolean first = Boolean.TRUE.equals(call.getBoolean("first", true));
        Context ctx = getContext();
        String pkg = ctx.getPackageName();
        try {
            switch (what) {
                case "location":
                    if (first && getActivity() != null) {
                        ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, 11);
                        break;
                    }
                    openAppDetails();
                    break;
                case "notifications":
                    if (first && Build.VERSION.SDK_INT >= 33 && getActivity() != null && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
                        ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 12);
                        break;
                    }
                    if (Build.VERSION.SDK_INT >= 26) {
                        start(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg));
                    } else openAppDetails();
                    break;
                case "overlay":
                    if (Build.VERSION.SDK_INT >= 23) start(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + pkg)));
                    break;
                case "battery":
                    if (Build.VERSION.SDK_INT >= 23) {
                        try {
                            start(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg)));
                        } catch (Exception e) {
                            start(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                        }
                    }
                    break;
                case "usage":
                    // « Accès aux données d'utilisation » : pour savoir quand Waze s'ouvre
                    try {
                        start(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + pkg)));
                    } catch (Exception e) {
                        start(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
                    }
                    break;
                case "xiaomiAuto":
                    // Xiaomi : « Démarrage automatique » (sinon la veille Waze est arrêtée quand l'appli est fermée)
                    try {
                        Intent i = new Intent();
                        i.setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity");
                        start(i);
                    } catch (Exception e) {
                        openAppDetails();
                    }
                    break;
                case "xiaomi":
                    // Xiaomi : « Autres autorisations » (fenêtres pop-up en arrière-plan)
                    try {
                        Intent i = new Intent("miui.intent.action.APP_PERM_EDITOR");
                        i.setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity");
                        i.putExtra("extra_pkgname", pkg);
                        start(i);
                    } catch (Exception e) {
                        openAppDetails();
                    }
                    break;
                default:
                    openAppDetails();
            }
            call.resolve();
        } catch (Exception e) {
            try {
                openAppDetails();
            } catch (Exception ignored) {
            }
            call.resolve();
        }
    }

    private void start(Intent i) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
    }

    private void openAppDetails() {
        start(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
    }

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", canDraw());
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (!canDraw() && Build.VERSION.SDK_INT >= 23) {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    private void readInfo(PluginCall call) {
        color = call.getString("color", color);
        text1 = call.getString("line1", text1);
        text2 = call.getString("line2", text2);
        iconKind = call.getString("icon", iconKind);
        Double p = call.getDouble("progress");
        progress = p == null ? -1f : p.floatValue();
        Double rt = call.getDouble("rate");
        rate = rt == null ? 0f : rt.floatValue();
        Double mm = call.getDouble("meters");
        meters = mm == null ? -1f : mm.floatValue();
        Double sp = call.getDouble("mps");
        mps = sp == null ? 0f : sp.floatValue();
        cdKey = call.getString("key", "");
    }

    private float countdownNow() {
        if (cdBase < 0) return -1f;
        return Math.max(0f, cdBase - mps * (System.currentTimeMillis() - cdT0) / 1000f);
    }

    private static String fmtMeters(float m) {
        if (m < 1000f) return Math.max(10, Math.round(m / 10f) * 10) + " m";
        return String.format(java.util.Locale.FRANCE, "%.1f km", m / 1000f);
    }

    private void countdownDraw() {
        float m = countdownNow();
        if (m < 0) return;
        fill.setLevel(Math.round(Math.max(0f, Math.min(1f, 1f - m / GAUGE_D)) * 10000));
        String t = fmtMeters(m);
        if (!t.equals(cdText)) {
            cdText = t;
            line2.setText(t);
        }
    }

    /** Nouvelle distance reçue : on repart de la plus petite des deux (jamais de retour en arrière), sauf nouvel obstacle. */
    private void countdownSet() {
        float cur = countdownNow();
        boolean fresh = cur < 0 || !cdKey.equals(cdShownKey) || meters > cur + 60f || meters < cur - 80f;
        cdBase = fresh ? meters : Math.min(cur, meters);
        cdT0 = System.currentTimeMillis();
        cdShownKey = cdKey;
        if (fillAnim != null) fillAnim.cancel();
        fillAnim = null;
        main.removeCallbacks(cdTick);
        countdownDraw();
        main.postDelayed(cdTick, 50);
    }

    private void countdownStop() {
        if (cdBase < 0) return;
        cdBase = -1f;
        cdText = "";
        main.removeCallbacks(cdTick);
    }

    /** Début / fin de trajet : la bulle s'affichera d'elle-même quand l'appli passe derrière. */
    @PluginMethod
    public void arm(PluginCall call) {
        armed = Boolean.TRUE.equals(call.getBoolean("active", false));
        if (!armed && Boolean.TRUE.equals(call.getBoolean("manual", false))) lastManualEnd = System.currentTimeMillis();
        tripActive = armed;
        if (armed) {
            // trajet lancé : la notification « Waze est ouvert » n'a plus lieu d'être
            android.app.NotificationManager nm = (android.app.NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(WazeWatchService.START_NOTIF_ID);
        }
        readInfo(call);
        if (!armed) main.post(this::remove);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", canDraw());
        r.put("armed", armed);
        r.put("shown", shown);
        r.put("pauses", pauses);
        r.put("shows", shows);
        r.put("lastError", lastError);
        call.resolve(r);
    }

    @PluginMethod
    public void show(PluginCall call) {
        readInfo(call);
        if (!canDraw()) {
            lastError = "autorisation manquante";
            call.reject("Autorisation « affichage par-dessus d'autres applis » manquante", "NOT_AUTHORIZED");
            return;
        }
        main.post(this::display);
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        readInfo(call);
        main.post(() -> {
            if (bubble != null) apply(color, text1, text2);
        });
        call.resolve();
    }

    // L'appli passe derrière (Waze, écran d'accueil…) : on affiche la bulle si un trajet est en cours
    @Override
    protected void handleOnPause() {
        pauses++;
        inBack = true;
        if (armed) {
            if (canDraw()) main.post(this::display);
            else lastError = "autorisation manquante";
        }
    }

    // Retour dans l'appli : la bulle disparaît
    @Override
    protected void handleOnResume() {
        lastResumeAt = System.currentTimeMillis();
        inBack = false;
        main.post(this::remove);
    }

    private void display() {
        try {
            if (bubble == null) build();
            apply(color, text1, text2);
            if (!shown) {
                // apparition douce
                card.setAlpha(0f);
                card.setScaleX(0.85f);
                card.setScaleY(0.85f);
                card.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(180).start();
                wm.addView(bubble, lp);
                shown = true;
                shows++;
            }
        } catch (Exception e) {
            shown = false;
            lastError = String.valueOf(e.getMessage());
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        main.post(this::remove);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // Appli fermée (retirée des applis récentes…) : le trajet est fini, la veille pourra en relancer un
        armed = false;
        tripActive = false;
        main.post(this::remove);
    }

    private void remove() {
        countdownStop();
        if (shown && bubble != null) {
            try {
                wm.removeView(bubble);
            } catch (Exception ignored) {
            }
        }
        shown = false;
    }

    private void apply(String color, String l1, String l2) {
        int c;
        try {
            c = Color.parseColor(color);
        } catch (Exception e) {
            c = Color.parseColor("#1E7A4C");
        }
        // changement de couleur en fondu, petite impulsion quand il faut lever le pied ou freiner
        if (curColor == 0) shape.setColor(c);
        else if (c != curColor) {
            android.animation.ValueAnimator va = android.animation.ValueAnimator.ofArgb(curColor, c);
            va.setDuration(250);
            va.addUpdateListener(a -> shape.setColor((int) a.getAnimatedValue()));
            va.start();
        }
        if (!iconKind.equals(curIcon)) {
            if (!curIcon.isEmpty() && ("lift".equals(iconKind) || "brake".equals(iconKind) || "stop".equals(iconKind))) {
                card.animate().scaleX(1.08f).scaleY(1.08f).setDuration(120)
                        .withEndAction(() -> card.animate().scaleX(1f).scaleY(1f).setDuration(160).start()).start();
            }
            curIcon = iconKind;
            icon.setKind(iconKind);
        }
        curColor = c;
        // la cagnotte augmente : petit rebond
        if ("kitty".equals(iconKind) && l2 != null && lastL2 != null && !l2.equals(lastL2) && "kitty".equals(curIcon)) {
            card.animate().scaleX(1.06f).scaleY(1.06f).setDuration(110)
                    .withEndAction(() -> card.animate().scaleX(1f).scaleY(1f).setDuration(140).start()).start();
        }
        lastL2 = l2;
        line1.setText(l1);
        line2.setVisibility(l2 == null || l2.isEmpty() ? View.GONE : View.VISIBLE);
        if (meters >= 0) {
            countdownSet();
        } else {
            countdownStop();
            updateFill();
            line2.setText(l2);
        }
    }

    /**
     * Jauge d'approche : remplissage régulier (linéaire) à la vitesse donnée par l'appli, sans attendre
     * la mise à jour suivante ; on ne repart de la valeur reçue que si l'écart devient grand.
     */
    private void updateFill() {
        float cur = fill.getLevel() / 10000f;
        if (progress < 0) {
            if (fillAnim != null) fillAnim.cancel();
            fillAnim = null;
            fillRate = 0f;
            if (cur > 0) {
                android.animation.ValueAnimator out = android.animation.ValueAnimator.ofInt(fill.getLevel(), 0);
                out.setDuration(120);
                out.addUpdateListener(a -> fill.setLevel((int) a.getAnimatedValue()));
                out.start();
            }
            return;
        }
        float p = Math.max(0f, Math.min(1f, progress));
        boolean jump = p > cur + 0.12f || p < cur - 0.3f; // très en retard, ou nouvel obstacle
        boolean running = fillAnim != null && fillAnim.isRunning();
        boolean newRate = Math.abs(rate - fillRate) > fillRate * 0.3f + 0.002f;
        if (running && !jump && !newRate) return;
        if (fillAnim != null) fillAnim.cancel();
        float start = jump ? p : cur;
        fillRate = rate;
        if (rate <= 0.0005f || start >= 1f) {
            fill.setLevel(Math.round(start * 10000));
            fillAnim = null;
            return;
        }
        fillAnim = android.animation.ValueAnimator.ofInt(Math.round(start * 10000), 10000);
        fillAnim.setInterpolator(new android.view.animation.LinearInterpolator());
        fillAnim.setDuration(Math.max(50L, (long) ((1f - start) / rate * 1000f)));
        fillAnim.addUpdateListener(a -> fill.setLevel((int) a.getAnimatedValue()));
        fillAnim.start();
    }

    /** Pictogramme de la bulle : les mêmes dessins que dans l'appli (grille de 48). */
    static class BubbleIcon extends View {
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG), ink = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private String kind = "wait";

        BubbleIcon(Context c) {
            super(c);
            ring.setColor(0x33FFFFFF);
            ink.setColor(Color.WHITE);
            ink.setStyle(Paint.Style.STROKE);
            ink.setStrokeCap(Paint.Cap.ROUND);
            ink.setStrokeJoin(Paint.Join.ROUND);
        }

        void setKind(String k) {
            kind = k == null ? "wait" : k;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas cv) {
            float w = getWidth(), h = getHeight();
            cv.drawCircle(w / 2, h / 2, Math.min(w, h) / 2, ring);
            // dessin en unités de 48, réduit dans le cercle
            float k = Math.min(w, h) / 48f * 0.62f;
            cv.save();
            cv.translate(w / 2 - 24 * k, h / 2 - 24 * k);
            cv.scale(k, k);
            ink.setStrokeWidth(4.2f);
            path.reset();
            switch (kind) {
                case "go":
                    path.moveTo(24, 40); path.lineTo(24, 10);
                    path.moveTo(12, 22); path.lineTo(24, 10); path.lineTo(36, 22);
                    break;
                case "lift":
                case "prep":
                    path.moveTo(14, 38); path.lineTo(34, 38);
                    path.moveTo(24, 30); path.lineTo(24, 8);
                    path.moveTo(15, 17); path.lineTo(24, 8); path.lineTo(33, 17);
                    break;
                case "brake":
                    path.moveTo(24, 16); path.lineTo(24, 28);
                    path.moveTo(24, 35); path.lineTo(24, 35.5f);
                    path.moveTo(6, 41); path.lineTo(24, 6); path.lineTo(42, 41); path.close();
                    break;
                case "stop":
                    path.moveTo(17, 6); path.lineTo(31, 6); path.lineTo(41, 16); path.lineTo(41, 30);
                    path.lineTo(31, 40); path.lineTo(17, 40); path.lineTo(7, 30); path.lineTo(7, 16); path.close();
                    path.moveTo(17, 23); path.lineTo(31, 23);
                    break;
                case "kitty": // tirelire : la cagnotte du trajet
                    path.addOval(new android.graphics.RectF(7, 13, 39, 39), Path.Direction.CW);
                    path.addRoundRect(new android.graphics.RectF(38, 21, 44, 30), 2, 2, Path.Direction.CW);
                    path.moveTo(15, 15); path.lineTo(18, 8); path.lineTo(23, 13);
                    path.moveTo(19, 18); path.lineTo(28, 18);
                    path.moveTo(15, 38); path.lineTo(15, 44);
                    path.moveTo(31, 38); path.lineTo(31, 44);
                    break;
                default:
                    path.addCircle(24, 24, 15, Path.Direction.CW);
                    path.moveTo(24, 15); path.lineTo(24, 24); path.lineTo(30, 28);
            }
            cv.drawPath(path, ink);
            cv.restore();
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private void build() {
        Context ctx = getContext().getApplicationContext();
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        final DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        final int pad = dp(10); // place pour l'ombre

        // Carte arrondie : pictogramme à gauche, consigne et distance à droite
        bubble = new android.widget.FrameLayout(ctx);
        bubble.setPadding(pad, pad, pad, pad);
        bubble.setClipToPadding(false);
        card = new LinearLayout(ctx);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(8), dp(8), dp(16), dp(8));
        shape = new GradientDrawable();
        shape.setCornerRadius(dp(26));
        GradientDrawable fillShape = new GradientDrawable();
        fillShape.setCornerRadius(dp(26));
        fillShape.setColor(0xFFA85E05);
        fill = new android.graphics.drawable.ClipDrawable(fillShape, Gravity.START, android.graphics.drawable.ClipDrawable.HORIZONTAL);
        fill.setLevel(0);
        card.setBackground(new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] { shape, fill }));
        card.setElevation(dp(6));

        icon = new BubbleIcon(ctx);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(dp(42), dp(42));
        ilp.setMarginEnd(dp(10));
        card.addView(icon, ilp);

        LinearLayout col = new LinearLayout(ctx);
        col.setOrientation(LinearLayout.VERTICAL);
        line1 = new TextView(ctx);
        line1.setTextColor(0xE6FFFFFF);
        line1.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        line1.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        line1.setLetterSpacing(0.04f);
        line1.setMaxLines(1);
        line1.setEllipsize(android.text.TextUtils.TruncateAt.END);
        line2 = new TextView(ctx);
        line2.setTextColor(Color.WHITE);
        line2.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        line2.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        line2.setMaxLines(1);
        line2.setIncludeFontPadding(false);
        col.addView(line1, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        col.addView(line2, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        card.addView(col, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        final int cardW = dp(176), cardH = dp(58);
        bubble.addView(card, new android.widget.FrameLayout.LayoutParams(cardW, cardH));
        final int winW = cardW + 2 * pad, winH = cardH + 2 * pad;

        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(winW, winH, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = dm.widthPixels - winW;
        lp.y = Math.round(dm.heightPixels * 0.35f);

        final int slop = dp(8);
        bubble.setOnTouchListener(new View.OnTouchListener() {
            private int startX, startY;
            private float downX, downY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = lp.x;
                        startY = lp.y;
                        downX = e.getRawX();
                        downY = e.getRawY();
                        moved = false;
                        card.animate().scaleX(0.96f).scaleY(0.96f).setDuration(80).start();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (Math.abs(dx) > slop || Math.abs(dy) > slop) moved = true;
                        if (moved) {
                            lp.x = startX + Math.round(dx);
                            lp.y = startY + Math.round(dy);
                            try {
                                wm.updateViewLayout(bubble, lp);
                            } catch (Exception ignored) {
                            }
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        card.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
                        if (!moved) {
                            if (e.getAction() == MotionEvent.ACTION_UP) openApp();
                            return true;
                        }
                        // la bulle se range contre le bord le plus proche
                        int sw = ctx.getResources().getDisplayMetrics().widthPixels;
                        int target = lp.x + winW / 2 < sw / 2 ? 0 : sw - winW;
                        android.animation.ValueAnimator va = android.animation.ValueAnimator.ofInt(lp.x, target);
                        va.setDuration(220);
                        va.setInterpolator(new android.view.animation.DecelerateInterpolator());
                        va.addUpdateListener(a -> {
                            lp.x = (int) a.getAnimatedValue();
                            try {
                                if (shown) wm.updateViewLayout(bubble, lp);
                            } catch (Exception ignored) {
                            }
                        });
                        va.start();
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private void openApp() {
        Context ctx = getContext();
        Intent i = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (i == null) return;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        ctx.startActivity(i);
    }
}
