package com.revo667.vision;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** GitHub Releases üzerinden güncelleme: son sürümü denetle, APK'yı indir, paket yükleyiciyle kur. */
final class Updater {
    interface Events {
        void emit(JSONObject ev);
    }

    private static JSONObject latest; // { version, url, size, notes }
    private static volatile boolean busy;

    private Updater() {
    }

    // "1.2.10" > "1.2.9"
    static int compare(String a, String b) {
        String[] x = a.replaceFirst("^v", "").split("[.\\-+]");
        String[] y = b.replaceFirst("^v", "").split("[.\\-+]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? toInt(x[i]) : 0;
            int q = i < y.length ? toInt(y[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int toInt(String s) {
        try {
            return Integer.parseInt(s.replaceAll("\\D.*$", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    // Uygulamanın ortak ağ katmanı (şifreli DNS yedekli) üzerinden istek
    private static okhttp3.Response get(String url, String accept) throws Exception {
        okhttp3.Request r = new okhttp3.Request.Builder()
                .url(url)
                .header("User-Agent", "Vision-Android/" + BuildConfig.VERSION_NAME)
                .header("Accept", accept)
                .build();
        return Net.client().newCall(r).execute();
    }

    /** Arka planda denetle; sonuç "update" olayı olarak gönderilir. */
    static void check(boolean manual, Events ev) {
        new Thread(() -> {
            JSONObject out = new JSONObject();
            try {
                out.put("type", "update");
                out.put("manual", manual);
                out.put("current", BuildConfig.VERSION_NAME);
                JSONObject rel;
                try (okhttp3.Response c = get("https://api.github.com/repos/" + BuildConfig.UPDATE_REPO + "/releases/latest", "application/vnd.github+json")) {
                    if (c.code() != 200) throw new Exception("HTTP " + c.code());
                    rel = new JSONObject(c.body().string());
                }
                String tag = rel.optString("tag_name", "");
                JSONArray assets = rel.optJSONArray("assets");
                JSONObject apk = null;
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject a = assets.getJSONObject(i);
                        if (a.optString("name").toLowerCase().endsWith(".apk")) {
                            apk = a;
                            break;
                        }
                    }
                }
                boolean newer = !tag.isEmpty() && apk != null && compare(tag, BuildConfig.VERSION_NAME) > 0;
                out.put("available", newer);
                out.put("version", tag.replaceFirst("^v", ""));
                out.put("notes", rel.optString("body", ""));
                if (newer) {
                    JSONObject l = new JSONObject();
                    l.put("version", tag.replaceFirst("^v", ""));
                    l.put("url", apk.getString("browser_download_url"));
                    l.put("size", apk.optLong("size"));
                    latest = l;
                    out.put("size", apk.optLong("size"));
                }
            } catch (Exception e) {
                try {
                    out.put("available", false);
                    out.put("error", e.getMessage() == null ? "bağlantı hatası" : e.getMessage());
                } catch (Exception ignored) {
                }
            }
            ev.emit(out);
        }, "update-check").start();
    }

    /** Bilinmeyen kaynaklardan yükleme izni (Android 8+) */
    static boolean canInstall(Context ctx) {
        return Build.VERSION.SDK_INT < 26 || ctx.getPackageManager().canRequestPackageInstalls();
    }

    static void openInstallPermission(Activity act) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.getPackageName())));
        } catch (ActivityNotFoundException e) {
            try {
                act.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
            } catch (Exception ignored) {
            }
        }
    }

    static void install(Activity act, Events ev) {
        if (busy) return;
        JSONObject l = latest;
        if (l == null) {
            emit(ev, "update-error", "Önce güncellemeleri denetle.");
            return;
        }
        if (!canInstall(act)) {
            emit(ev, "update-permission", "Güncellemeyi kurmak için Vision'a “bilinmeyen uygulamaları yükleme” izni ver, sonra tekrar dene.");
            act.runOnUiThread(() -> openInstallPermission(act));
            return;
        }
        busy = true;
        new Thread(() -> {
            File file = new File(act.getCacheDir(), "update.apk");
            try {
                okhttp3.Response c = get(l.getString("url"), "application/octet-stream");
                if (c.code() != 200) {
                    c.close();
                    throw new Exception("İndirme hatası (HTTP " + c.code() + ")");
                }
                long total = c.body().contentLength() > 0 ? c.body().contentLength() : l.optLong("size");
                try (okhttp3.Response cc = c; InputStream in = cc.body().byteStream(); OutputStream out = new FileOutputStream(file)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0;
                    int lastPct = -1;
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : -1;
                        if (pct != lastPct && pct % 5 == 0) {
                            lastPct = pct;
                            JSONObject p = new JSONObject();
                            p.put("type", "update-progress");
                            p.put("pct", pct);
                            ev.emit(p);
                        }
                    }
                }
                emit(ev, "update-installing", "Kurulum başlatılıyor…");
                installApk(act, file);
            } catch (Exception e) {
                emit(ev, "update-error", e.getMessage() == null ? "Güncelleme indirilemedi." : e.getMessage());
            } finally {
                busy = false;
            }
        }, "update-download").start();
    }

    private static void installApk(Context ctx, File apk) throws Exception {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("vision.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            }
            Intent i = new Intent(ctx, InstallReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pending = PendingIntent.getBroadcast(ctx, id, i, flags);
            s.commit(pending.getIntentSender());
        }
    }

    private static void emit(Events ev, String type, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            o.put("message", message);
            ev.emit(o);
        } catch (Exception ignored) {
        }
    }

    static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
        in.close();
        return bo.toString("UTF-8");
    }
}
