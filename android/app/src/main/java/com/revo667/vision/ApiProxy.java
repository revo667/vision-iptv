package com.revo667.vision;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Arayüzün Xtream API isteklerini yerelde karşılar: https://appassets.androidplatform.net/__proxy?u=<adres>
 * IPTV sunucuları CORS başlığı göndermez ve çoğu http'dir; istek uygulamadan, oynatıcı kimliğiyle yapılır.
 * Bağlantı kurulamazsa nedeni X-Vision-Error-Detail başlığıyla arayüze bildirilir.
 */
final class ApiProxy {
    static final String PATH = "/__proxy";
    static final String USER_AGENT = "VLC/3.0.21 LibVLC/3.0.21";

    private ApiProxy() {
    }

    static WebResourceResponse handle(Uri req) {
        String target = req.getQueryParameter("u");
        if (target == null || !(target.startsWith("http://") || target.startsWith("https://"))) {
            return error(400, "Bad Request", "BadUrl: adres http:// veya https:// ile başlamalı");
        }
        Response res = null;
        try {
            Request r = new Request.Builder()
                    .url(target)
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "*/*")
                    .build();
            res = Net.client().newCall(r).execute();
            ResponseBody body = res.body();
            InputStream in = body != null ? body.byteStream() : new ByteArrayInputStream(new byte[0]);
            String mime = "application/json";
            String charset = "utf-8";
            MediaType mt = body != null ? body.contentType() : null;
            if (mt != null) {
                mime = mt.type() + "/" + mt.subtype();
                if (mt.charset() != null) charset = mt.charset().name();
            }
            int code = res.code();
            if (code < 200 || (code >= 300 && code < 400) || code > 599) code = 502;
            String reason = res.message();
            if (reason == null || reason.isEmpty() || !reason.matches("[\\x20-\\x7e]+")) reason = code < 300 ? "OK" : "Error";
            return new WebResourceResponse(mime, charset, code, reason, headers(null), in);
        } catch (Exception e) {
            if (res != null) res.close();
            String host = Uri.parse(target).getHost();
            String detail = e.getClass().getSimpleName() + ": " + (e.getMessage() == null ? "" : e.getMessage());
            Log.w("VisionProxy", "istek başarısız (" + host + "): " + detail);
            return error(502, "Bad Gateway", detail);
        }
    }

    private static Map<String, String> headers(String errorDetail) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-store");
        if (errorDetail != null) {
            h.put("X-Vision-Error", "network");
            try {
                String d = errorDetail.length() > 300 ? errorDetail.substring(0, 300) : errorDetail;
                h.put("X-Vision-Error-Detail", URLEncoder.encode(d, "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return h;
    }

    private static WebResourceResponse error(int code, String reason, String detail) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, headers(detail), new ByteArrayInputStream(new byte[0]));
    }
}
