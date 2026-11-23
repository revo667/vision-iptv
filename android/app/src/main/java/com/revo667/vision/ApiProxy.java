package com.revo667.vision;

import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * Arayüzün Xtream API isteklerini yerelde karşılar: https://appassets.androidplatform.net/__proxy?u=<adres>
 * IPTV sunucuları CORS başlığı göndermez ve çoğu http'dir; istek uygulamadan, oynatıcı kimliğiyle yapılır.
 */
final class ApiProxy {
    static final String PATH = "/__proxy";
    static final String USER_AGENT = "VLC/3.0.21 LibVLC/3.0.21";

    private ApiProxy() {
    }

    static WebResourceResponse handle(Uri req) {
        String target = req.getQueryParameter("u");
        if (target == null || !(target.startsWith("http://") || target.startsWith("https://"))) {
            return error(400, "Bad Request", false);
        }
        try {
            HttpURLConnection c = open(target);
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) in = new ByteArrayInputStream(new byte[0]);
            String type = c.getContentType();
            String mime = "application/json";
            String charset = "utf-8";
            if (type != null) {
                String[] parts = type.split(";");
                mime = parts[0].trim();
                for (String p : parts) {
                    p = p.trim();
                    if (p.toLowerCase().startsWith("charset=")) charset = p.substring(8).trim();
                }
            }
            if (code < 200 || (code >= 300 && code < 400) || code > 599) code = 502;
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = code < 300 ? "OK" : "Error";
            return new WebResourceResponse(mime, charset, code, reason, headers(false), in);
        } catch (Exception e) {
            return error(502, "Bad Gateway", true);
        }
    }

    // http ↔ https arasındaki yönlendirmeleri de izle (HttpURLConnection bunu kendisi yapmaz)
    static HttpURLConnection open(String url) throws Exception {
        String cur = url;
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(40000);
            c.setRequestProperty("User-Agent", USER_AGENT);
            c.setRequestProperty("Accept", "*/*");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new Exception("redirect without location");
                cur = new URL(new URL(cur), loc).toString();
                continue;
            }
            return c;
        }
        throw new Exception("too many redirects");
    }

    private static Map<String, String> headers(boolean network) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-store");
        if (network) h.put("X-Vision-Error", "network");
        return h;
    }

    private static WebResourceResponse error(int code, String reason, boolean network) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, headers(network), new ByteArrayInputStream(new byte[0]));
    }
}
