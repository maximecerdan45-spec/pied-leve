package app.piedleve;

import android.annotation.SuppressLint;
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
