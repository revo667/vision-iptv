package com.revo667.vision;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.BaseAdapter;
import android.widget.ListView;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {
    private ExoPlayer player;
    private PlayerView view;
    private DefaultTrackSelector selector;

    private String kind = "movie";
    private JSONArray items = new JSONArray();
    private JSONArray channels = new JSONArray();
    private int index;
    private int urlIdx;

    private View topBar, channelPanel, nextCard, errorPanel;
    private TextView title, subtitle, osd, liveBadge, btnChannels, btnExternal, btnBack;
    private TextView nextTitle, btnNextNow, btnNextCancel, errTitle, errText;
    private ListView channelList;
    private ChannelAdapter adapter;

    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable hideOsd = () -> osd.setVisibility(View.GONE);
    // TV'de kontrol çubuğunda odak varken Media3 otomatik gizlemiyor: tuşa basılmazsa kapat
    private final Runnable autoHide = () -> {
        boolean overlay = channelPanel.getVisibility() == View.VISIBLE || errorPanel.getVisibility() == View.VISIBLE
                || nextCard.getVisibility() == View.VISIBLE;
        if (player != null && player.isPlaying() && !overlay) view.hideController();
    };
    private Runnable zapLoad;
    private Runnable nextTick;
    private int nextCountdown;
    private boolean closedSent;
    private String initialAudio, initialText;
    private boolean tracksSeen;
    private boolean ended;
    private final java.util.Set<Integer> consumed = new java.util.HashSet<>(); // basılması yakalanan tuşlar

    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            emitProgress(false);
            h.postDelayed(this, 5000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String raw = PlayerSession.pendingOpts;
        if (raw == null) {
            finish();
            return;
        }
        JSONObject opts;
        try {
            opts = new JSONObject(raw);
            kind = opts.optString("kind", "movie");
            items = opts.optJSONArray("items") != null ? opts.getJSONArray("items") : new JSONArray();
            channels = opts.optJSONArray("channels") != null ? opts.getJSONArray("channels") : new JSONArray();
            index = opts.optInt("index", 0);
        } catch (Exception e) {
            finish();
            return;
        }
        setContentView(R.layout.activity_player);
        bindViews();
        hideSystemBars();
        PlayerSession.active = this;

        // Oynatıcı: ExoPlayer + cihazın çözemediği sesler için FFmpeg (AC3, E-AC3, DTS, TrueHD…)
        selector = new DefaultTrackSelector(this);
        DefaultTrackSelector.Parameters.Builder p = selector.buildUponParameters();
        String audioLang = opts.optString("audioLang", "");
        String subLang = opts.optString("subLang", "");
        if (!audioLang.isEmpty()) p.setPreferredAudioLanguage(audioLang);
        if (!subLang.isEmpty() && !subLang.equals("off")) p.setPreferredTextLanguage(subLang);
        selector.setParameters(p);

        DefaultRenderersFactory rf = new DefaultRenderersFactory(this)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
                .setEnableDecoderFallback(true);
        // API ile aynı ağ katmanı: şifreli DNS + IPv4 önceliği, http↔https yönlendirmeleri
        OkHttpDataSource.Factory http = new OkHttpDataSource.Factory(Net.client())
                .setUserAgent(ApiProxy.USER_AGENT);
        player = new ExoPlayer.Builder(this, rf)
                .setTrackSelector(selector)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http)))
                .setSeekBackIncrementMs(10000)
                .setSeekForwardIncrementMs(10000)
                .build();
        player.addListener(new Listener());
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            player.addAnalyticsListener(new androidx.media3.exoplayer.util.EventLogger());
        }
        view.setPlayer(player);
        view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) v -> {
            topBar.setVisibility(v == View.VISIBLE ? View.VISIBLE : View.GONE);
            if (v != View.VISIBLE && channelPanel.getVisibility() != View.VISIBLE && nextCard.getVisibility() != View.VISIBLE) view.requestFocus();
        });
        if (view.getSubtitleView() != null) {
            view.getSubtitleView().setStyle(new CaptionStyleCompat(Color.WHITE, Color.TRANSPARENT, Color.TRANSPARENT,
                    CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, null));
            view.getSubtitleView().setFractionalTextSize(0.058f);
        }

        boolean live = isLive();
        liveBadge.setVisibility(live ? View.VISIBLE : View.GONE);
        btnChannels.setVisibility(live && channels.length() > 1 ? View.VISIBLE : View.GONE);
        view.setShowFastForwardButton(!live);
        view.setShowRewindButton(!live);
        view.setShowNextButton(false);
        view.setShowPreviousButton(false);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        if (live) playChannel(index);
        else playItem(index, (long) (items.optJSONObject(index) != null ? items.optJSONObject(index).optDouble("startAt", 0) * 1000 : 0));
        h.postDelayed(progressTick, 5000);
        view.showController(); // başlık ve kontroller birlikte görünüp birlikte gizlensin
        h.postDelayed(autoHide, 5000);
        view.requestFocus();
    }

    private void bindViews() {
        view = findViewById(R.id.player_view);
        topBar = findViewById(R.id.top_bar);
        title = findViewById(R.id.title);
        subtitle = findViewById(R.id.subtitle);
        osd = findViewById(R.id.osd);
        liveBadge = findViewById(R.id.live_badge);
        btnChannels = findViewById(R.id.btn_channels);
        btnExternal = findViewById(R.id.btn_external);
        btnBack = findViewById(R.id.btn_back);
        channelPanel = findViewById(R.id.channel_panel);
        channelList = findViewById(R.id.channel_list);
        nextCard = findViewById(R.id.next_card);
        nextTitle = findViewById(R.id.next_title);
        btnNextNow = findViewById(R.id.btn_next_now);
        btnNextCancel = findViewById(R.id.btn_next_cancel);
        errorPanel = findViewById(R.id.error_panel);
        errTitle = findViewById(R.id.error_title);
        errText = findViewById(R.id.error_text);

        btnBack.setOnClickListener(v -> finish());
        btnExternal.setOnClickListener(v -> openExternal());
        btnChannels.setOnClickListener(v -> showChannels());
        findViewById(R.id.btn_retry).setOnClickListener(v -> retry());
        findViewById(R.id.btn_error_external).setOnClickListener(v -> openExternal());
        findViewById(R.id.btn_error_back).setOnClickListener(v -> finish());
        btnNextNow.setOnClickListener(v -> playNext());
        btnNextCancel.setOnClickListener(v -> {
            h.removeCallbacks(nextTick);
            nextCard.setVisibility(View.GONE);
            view.showController();
        });
        adapter = new ChannelAdapter();
        channelList.setAdapter(adapter);
        channelList.setOnItemClickListener((parent, v, pos, id) -> {
            channelPanel.setVisibility(View.GONE);
            if (pos != index) playChannel(pos);
            view.requestFocus();
        });
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private boolean isLive() {
        return "live".equals(kind);
    }

    /* ---------- Film / dizi ---------- */
    private void playItem(int i, long startMs) {
        JSONObject it = items.optJSONObject(i);
        if (it == null) {
            finish();
            return;
        }
        index = i;
        ended = false;
        tracksSeen = false;
        hideError();
        nextCard.setVisibility(View.GONE);
        title.setText(it.optString("title"));
        subtitle.setText(it.optString("sub"));
        player.setMediaItem(mediaItem(it.optString("url")), Math.max(0, startMs));
        player.prepare();
        player.setPlayWhenReady(true);
        emit("item", null);
    }

    private JSONObject currentItem() {
        return items.optJSONObject(index);
    }

    private void playNext() {
        h.removeCallbacks(nextTick);
        if (index + 1 < items.length()) playItem(index + 1, 0);
        else finish();
    }

    private void showNextCard() {
        JSONObject next = items.optJSONObject(index + 1);
        if (next == null) {
            finish();
            return;
        }
        nextTitle.setText(next.optString("sub", next.optString("title")));
        nextCountdown = 8;
        nextCard.setVisibility(View.VISIBLE);
        btnNextNow.requestFocus();
        nextTick = new Runnable() {
            @Override
            public void run() {
                if (nextCountdown <= 0) {
                    playNext();
                    return;
                }
                btnNextNow.setText("▶  Şimdi oynat (" + nextCountdown + ")");
                nextCountdown--;
                h.postDelayed(this, 1000);
            }
        };
        h.post(nextTick);
    }

    /* ---------- Canlı TV ---------- */
    private JSONObject channel() {
        return channels.optJSONObject(index);
    }

    private void playChannel(int i) {
        JSONObject ch = channels.optJSONObject(i);
        if (ch == null) {
            finish();
            return;
        }
        index = i;
        urlIdx = 0;
        hideError();
        title.setText(ch.optString("name"));
        subtitle.setText(ch.optString("sub", ""));
        adapter.notifyDataSetChanged();
        loadChannelUrl();
        emit("channel", null);
    }

    private void loadChannelUrl() {
        JSONObject ch = channel();
        JSONArray urls = ch != null ? ch.optJSONArray("urls") : null;
        if (urls == null || urlIdx >= urls.length()) {
            showError("Kanal açılamadı", "Kanal şu an yayında olmayabilir.");
            return;
        }
        player.setMediaItem(mediaItem(urls.optString(urlIdx)));
        player.prepare();
        player.setPlayWhenReady(true);
    }

    private void zap(int delta) {
        int n = channels.length();
        if (n < 2) return;
        index = ((index + delta) % n + n) % n;
        JSONObject ch = channel();
        String num = ch.optString("num", "");
        showOsd((num.isEmpty() || num.equals("null") ? "" : num + "   ") + ch.optString("name"));
        title.setText(ch.optString("name"));
        subtitle.setText("");
        if (zapLoad != null) h.removeCallbacks(zapLoad);
        final int target = index;
        zapLoad = () -> playChannel(target);
        h.postDelayed(zapLoad, 450);
    }

    private void showChannels() {
        if (channels.length() < 2) return;
        view.hideController();
        channelPanel.setVisibility(View.VISIBLE);
        channelList.setSelection(Math.max(0, index - 3));
        channelList.post(() -> {
            channelList.setSelection(index);
            channelList.requestFocus();
        });
    }

    /* ---------- Ortak ---------- */
    private MediaItem mediaItem(String url) {
        MediaItem.Builder b = new MediaItem.Builder().setUri(url);
        String path = url.toLowerCase();
        if (path.contains(".m3u8")) b.setMimeType(MimeTypes.APPLICATION_M3U8);
        return b.build();
    }

    private void showOsd(String text) {
        osd.setText(text);
        osd.setVisibility(View.VISIBLE);
        h.removeCallbacks(hideOsd);
        h.postDelayed(hideOsd, 1400);
    }

    private void showError(String t, String msg) {
        errTitle.setText(t);
        errText.setText(msg);
        errorPanel.setVisibility(View.VISIBLE);
        view.hideController();
        findViewById(R.id.btn_retry).requestFocus();
    }

    private void hideError() {
        errorPanel.setVisibility(View.GONE);
    }

    private void retry() {
        hideError();
        if (isLive()) {
            urlIdx = 0;
            loadChannelUrl();
        } else {
            long pos = player.getCurrentPosition();
            player.prepare();
            player.seekTo(pos);
            player.setPlayWhenReady(true);
        }
        view.requestFocus();
    }

    private String currentUrl() {
        if (isLive()) {
            JSONObject ch = channel();
            JSONArray urls = ch != null ? ch.optJSONArray("urls") : null;
            return urls != null && urls.length() > 0 ? urls.optString(Math.min(urlIdx, urls.length() - 1)) : null;
        }
        JSONObject it = currentItem();
        return it != null ? it.optString("url") : null;
    }

    private void openExternal() {
        String url = currentUrl();
        if (url == null) return;
        emitProgress(false);
        player.stop(); // tek bağlantı sınırı: kendi akışımızı kapat
        MainActivity.openExternal(this, url, title.getText().toString());
        finish();
    }

    private String describe(PlaybackException e) {
        Throwable c = e.getCause();
        if (c instanceof HttpDataSource.InvalidResponseCodeException) {
            int code = ((HttpDataSource.InvalidResponseCodeException) c).responseCode;
            if (code == 401 || code == 403) return "Sunucu akışı reddetti (HTTP " + code + "). Hesabın başka bir cihazda açık olabilir.";
            if (code == 404) return "Akış sunucuda bulunamadı (HTTP 404).";
            return "Sunucu hatası (HTTP " + code + ").";
        }
        int code = e.errorCode;
        if (code >= 2000 && code < 3000) return "Ağ hatası: akış sunucudan alınamadı.";
        if (code >= 3000 && code < 4000) return "Akış çözümlenemedi; dosya bozuk ya da desteklenmeyen bir formatta olabilir.";
        if (code >= 4000 && code < 5000) return "Bu içeriğin video/ses formatı cihazında desteklenmiyor. Başka bir oynatıcıyla açmayı deneyebilirsin.";
        return e.getMessage() != null ? e.getMessage() : "Oynatma hatası.";
    }

    private class Listener implements Player.Listener {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) hideError();
            if (state == Player.STATE_ENDED) {
                if (isLive()) {
                    h.postDelayed(PlayerActivity.this::loadChannelUrl, 1000); // yayın koptu → yeniden bağlan
                } else if (!ended) {
                    ended = true;
                    emitProgress(true);
                    if (index + 1 < items.length()) showNextCard();
                    else h.postDelayed(PlayerActivity.this::finish, 1200);
                }
            }
        }

        @Override
        public void onPlayerError(PlaybackException e) {
            if (isLive()) {
                if (e.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                JSONObject ch = channel();
                JSONArray urls = ch != null ? ch.optJSONArray("urls") : null;
                if (urls != null && urlIdx + 1 < urls.length()) {
                    urlIdx++;
                    loadChannelUrl();
                    return;
                }
                showError("Kanal açılamadı", describe(e));
            } else {
                showError("Bu içerik oynatılamadı", describe(e));
            }
        }

        @Override
        public void onTracksChanged(Tracks tracks) {
            if (!tracksSeen && !tracks.getGroups().isEmpty()) {
                tracksSeen = true;
                initialAudio = selectedLang(tracks, C.TRACK_TYPE_AUDIO);
                initialText = selectedLang(tracks, C.TRACK_TYPE_TEXT);
            }
        }
    }

    private static String selectedLang(Tracks tracks, int type) {
        for (Tracks.Group g : tracks.getGroups()) {
            if (g.getType() != type || !g.isSelected()) continue;
            for (int i = 0; i < g.length; i++) {
                if (g.isTrackSelected(i)) {
                    Format f = g.getTrackFormat(i);
                    return f.language != null ? f.language : "und";
                }
            }
        }
        return null;
    }

    /* ---------- Arayüze olaylar ---------- */
    private void emit(String ev, JSONObject extra) {
        try {
            JSONObject o = extra != null ? extra : new JSONObject();
            o.put("type", "player");
            o.put("ev", ev);
            o.put("kind", kind);
            o.put("index", index);
            if (isLive()) {
                JSONObject ch = channel();
                if (ch != null) o.put("id", ch.opt("id"));
            } else {
                JSONObject it = currentItem();
                if (it != null) o.put("key", it.optString("key"));
            }
            PlayerSession.emit(o);
        } catch (Exception ignored) {
        }
    }

    private void emitProgress(boolean done) {
        if (isLive() || player == null) return;
        long dur = player.getDuration();
        if (dur == C.TIME_UNSET || dur <= 0) return;
        try {
            JSONObject o = new JSONObject();
            o.put("pos", (done ? dur : player.getCurrentPosition()) / 1000.0);
            o.put("dur", dur / 1000.0);
            o.put("done", done);
            emit("progress", o);
        } catch (Exception ignored) {
        }
    }

    private void sendClosed() {
        if (closedSent || player == null) return;
        closedSent = true;
        emitProgress(ended);
        try {
            JSONObject o = new JSONObject();
            Tracks t = player.getCurrentTracks();
            String a = selectedLang(t, C.TRACK_TYPE_AUDIO);
            String s = selectedLang(t, C.TRACK_TYPE_TEXT);
            boolean hasText = false;
            for (Tracks.Group g : t.getGroups()) if (g.getType() == C.TRACK_TYPE_TEXT) hasText = true;
            // Yalnızca kullanıcı değiştirdiyse tercih olarak kaydedilsin
            if (a != null && !a.equals(initialAudio)) o.put("audioLang", a);
            if (hasText && (s == null ? initialText != null : !s.equals(initialText))) o.put("subLang", s == null ? "off" : s);
            emit("closed", o);
        } catch (Exception ignored) {
        }
    }

    /* ---------- Arayüzden güncelleme (ör. yayın akışı) ---------- */
    void update(String json) {
        runOnUiThread(() -> {
            try {
                JSONObject o = new JSONObject(json);
                if (isLive()) {
                    JSONObject ch = channel();
                    if (ch != null && String.valueOf(ch.opt("id")).equals(String.valueOf(o.opt("id")))) {
                        ch.put("sub", o.optString("sub"));
                        subtitle.setText(o.optString("sub"));
                    }
                } else if (o.has("sub")) {
                    subtitle.setText(o.optString("sub"));
                }
            } catch (Exception ignored) {
            }
        });
    }

    /* ---------- Kumanda ---------- */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        h.removeCallbacks(autoHide);
        h.postDelayed(autoHide, 5000);
        // Basılması bizde işlenen tuşun bırakılması da oynatıcıya gitmesin (yoksa kontrolleri açar)
        if (e.getAction() == KeyEvent.ACTION_UP && consumed.remove(k)) return true;
        if (Build.VERSION.SDK_INT < 33 && k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP && !e.isCanceled()) handleBack();
            return true;
        }
        boolean overlay = channelPanel.getVisibility() == View.VISIBLE || errorPanel.getVisibility() == View.VISIBLE
                || nextCard.getVisibility() == View.VISIBLE;
        if (!overlay && !view.isControllerFullyVisible()) {
            if (k == KeyEvent.KEYCODE_CHANNEL_UP || k == KeyEvent.KEYCODE_CHANNEL_DOWN) {
                if (down && isLive()) zap(k == KeyEvent.KEYCODE_CHANNEL_UP ? 1 : -1);
                if (down) consumed.add(k);
                return true;
            }
            if (isLive()) {
                if (k == KeyEvent.KEYCODE_DPAD_UP || k == KeyEvent.KEYCODE_DPAD_DOWN) {
                    if (down) { zap(k == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1); consumed.add(k); }
                    return true;
                }
                if (k == KeyEvent.KEYCODE_DPAD_LEFT || k == KeyEvent.KEYCODE_MENU) {
                    if (down) { showChannels(); consumed.add(k); }
                    return true;
                }
            } else if (k == KeyEvent.KEYCODE_DPAD_LEFT || k == KeyEvent.KEYCODE_DPAD_RIGHT) {
                if (down) {
                    consumed.add(k);
                    long step = e.getRepeatCount() > 8 ? 60000 : e.getRepeatCount() > 3 ? 30000 : 10000;
                    long target = player.getCurrentPosition() + (k == KeyEvent.KEYCODE_DPAD_LEFT ? -step : step);
                    long dur = player.getDuration();
                    if (dur != C.TIME_UNSET) target = Math.min(target, dur - 1000);
                    player.seekTo(Math.max(0, target));
                    showOsd((k == KeyEvent.KEYCODE_DPAD_LEFT ? "⏪  " : "⏩  ") + fmt(Math.max(0, target)) + (dur != C.TIME_UNSET ? " / " + fmt(dur) : ""));
                }
                return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    private static String fmt(long ms) {
        long s = ms / 1000, hh = s / 3600, mm = (s % 3600) / 60, ss = s % 60;
        return hh > 0 ? String.format("%d:%02d:%02d", hh, mm, ss) : String.format("%d:%02d", mm, ss);
    }

    private void handleBack() {
        if (channelPanel.getVisibility() == View.VISIBLE) {
            channelPanel.setVisibility(View.GONE);
            view.requestFocus();
        } else if (nextCard.getVisibility() == View.VISIBLE) {
            h.removeCallbacks(nextTick);
            nextCard.setVisibility(View.GONE);
            view.requestFocus();
        } else if (errorPanel.getVisibility() != View.VISIBLE && view.isControllerFullyVisible()) {
            view.hideController();
        } else {
            finish();
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (isFinishing()) sendClosed();
        else if (player != null) {
            emitProgress(false);
            player.setPlayWhenReady(false);
        }
    }

    @Override
    protected void onDestroy() {
        sendClosed();
        h.removeCallbacksAndMessages(null);
        if (PlayerSession.active == this) PlayerSession.active = null;
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    /* ---------- Kanal listesi ---------- */
    private class ChannelAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return channels.length();
        }

        @Override
        public Object getItem(int i) {
            return channels.optJSONObject(i);
        }

        @Override
        public long getItemId(int i) {
            return i;
        }

        @Override
        public View getView(int i, View v, ViewGroup parent) {
            if (v == null) v = LayoutInflater.from(PlayerActivity.this).inflate(R.layout.channel_item, parent, false);
            JSONObject ch = channels.optJSONObject(i);
            String num = ch != null ? ch.optString("num", "") : "";
            ((TextView) v.findViewById(R.id.num)).setText(num.equals("null") ? "" : num);
            ((TextView) v.findViewById(R.id.name)).setText(ch != null ? ch.optString("name") : "");
            v.setActivated(i == index);
            return v;
        }
    }
}
