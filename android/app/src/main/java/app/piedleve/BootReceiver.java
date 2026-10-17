package app.piedleve;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Après un redémarrage du téléphone : relance la veille « démarrage avec Waze » si elle était activée. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        // Après un redémarrage du téléphone ou une mise à jour de l'appli
        if ((Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) && WazeWatchService.isOn(context)) {
            try {
                WazeWatchService.setOn(context, true);
            } catch (Exception ignored) {
            }
        }
    }
}
