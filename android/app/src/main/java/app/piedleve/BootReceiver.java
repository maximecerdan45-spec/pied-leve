package app.piedleve;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Après un redémarrage du téléphone : relance la veille « démarrage avec Waze » si elle était activée. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && WazeWatchService.isOn(context)) {
            try {
                WazeWatchService.setOn(context, true);
            } catch (Exception ignored) {
            }
        }
    }
}
