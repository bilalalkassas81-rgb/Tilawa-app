package app.tilawa.quran;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WhisperPlugin.class); // the native Qur'an AI engine (whisper.cpp)
        super.onCreate(savedInstanceState);
    }
}
