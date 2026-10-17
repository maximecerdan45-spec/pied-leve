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
import android.graphics.Color;
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
    private LinearLayout bubble;
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
    private String color = "#5A6560", text1 = "PIED LEVÉ", text2 = "";
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
        if (armed) {
            if (canDraw()) main.post(this::display);
            else lastError = "autorisation manquante";
        }
    }

    // Retour dans l'appli : la bulle disparaît
    @Override
    protected void handleOnResume() {
        lastResumeAt = System.currentTimeMillis();
        main.post(this::remove);
    }

    private void display() {
        try {
            if (bubble == null) build();
            apply(color, text1, text2);
            if (!shown) {
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
            c = Color.parseColor("#24965C");
        }
        shape.setColor(c);
        line1.setText(l1);
        line2.setText(l2);
        // texte plus petit s'il est long (ex. « 50 km/h »), pour tenir sur une ligne
        line2.setTextSize(TypedValue.COMPLEX_UNIT_SP, l2 != null && l2.length() > 6 ? 14 : 18);
        line2.setVisibility(l2 == null || l2.isEmpty() ? View.GONE : View.VISIBLE);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void build() {
        Context ctx = getContext().getApplicationContext();
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        int size = dp(88);

        bubble = new LinearLayout(ctx);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setGravity(Gravity.CENTER);
        bubble.setPadding(dp(8), dp(8), dp(8), dp(8));
        shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setStroke(dp(3), Color.WHITE);
        bubble.setBackground(shape);
        bubble.setElevation(dp(8));

        line1 = new TextView(ctx);
        line1.setTextColor(Color.WHITE);
        line1.setTypeface(Typeface.DEFAULT_BOLD);
        line1.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        line1.setGravity(Gravity.CENTER);
        line1.setMaxLines(2);
        line1.setLineSpacing(0, 0.9f);

        line2 = new TextView(ctx);
        line2.setTextColor(Color.WHITE);
        line2.setTypeface(Typeface.DEFAULT_BOLD);
        line2.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        line2.setGravity(Gravity.CENTER);
        line2.setMaxLines(1);

        bubble.addView(line1, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        bubble.addView(line2, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(size, size, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        lp.x = dm.widthPixels - size - dp(12);
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
                        if (!moved) openApp();
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
