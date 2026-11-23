package com.revo667.vision;

import org.json.JSONObject;

/** Arayüz ile oynatıcı etkinliği arasındaki köprü (aynı süreç içinde; büyük kanal listeleri Intent'e sığmaz). */
final class PlayerSession {
    interface Listener {
        void onPlayerEvent(JSONObject ev);
    }

    static String pendingOpts;
    static Listener listener;
    static PlayerActivity active;

    private PlayerSession() {
    }

    static void emit(JSONObject ev) {
        Listener l = listener;
        if (l != null) l.onPlayerEvent(ev);
    }
}
