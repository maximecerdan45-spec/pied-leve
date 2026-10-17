package app.piedleve;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Module maison : bulle flottante, préparation du téléphone, démarrage avec Waze
        registerPlugin(BubblePlugin.class);
        super.onCreate(savedInstanceState);
        noteAutostart(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        noteAutostart(intent);
    }

    // Ouverte par la veille « Waze » : la page lancera le trajet puis remettra l'appli derrière Waze
    private void noteAutostart(Intent intent) {
        if (intent != null && intent.getBooleanExtra("autostart", false)) {
            intent.removeExtra("autostart");
            // ouverture discrète : pas d'animation (on repart aussitôt derrière Waze)
            overridePendingTransition(0, 0);
            BubblePlugin.autostartPending = true;
            BubblePlugin.fireAutostart();
        }
    }
}
