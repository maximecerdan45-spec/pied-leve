package app.piedleve;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Module maison : bulle flottante et préparation du téléphone (autorisations)
        registerPlugin(BubblePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
