package app.piedleve;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Module maison : bulle flottante par-dessus les autres applis
        registerPlugin(BubblePlugin.class);
        super.onCreate(savedInstanceState);
        // Android 13+ : autorisation d'afficher la notification « Pied Levé en route »,
        // nécessaire pour que le GPS continue quand une autre appli (Waze) est devant.
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
    }
}
