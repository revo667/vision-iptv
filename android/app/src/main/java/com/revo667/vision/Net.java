package com.revo667.vision;

import android.util.Log;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.dnsoverhttps.DnsOverHttps;

/**
 * Uygulamanın tüm IPTV bağlantıları (API ve video) için ortak HTTP istemcisi.
 * - Ad çözümleme: şifreli DNS (Cloudflare, Google) ve sistem DNS'i paralel; şifreli olan tercih edilir
 * - IPv4 adresleri önce denenir (bozuk IPv6 bağlantısında takılmasın)
 */
final class Net {
    private static OkHttpClient client;

    private Net() {
    }

    static synchronized OkHttpClient client() {
        if (client == null) {
            OkHttpClient bootstrap = new OkHttpClient.Builder()
                    .callTimeout(4, TimeUnit.SECONDS)
                    .build();
            Dns cloudflare = doh(bootstrap, "https://cloudflare-dns.com/dns-query", "1.1.1.1", "1.0.0.1");
            Dns google = doh(bootstrap, "https://dns.google/dns-query", "8.8.8.8", "8.8.4.4");
            client = new OkHttpClient.Builder()
                    .dns(new SmartDns(cloudflare, google))
                    .connectTimeout(8, TimeUnit.SECONDS) // adres başına; sonraki adrese geçilir
                    .readTimeout(40, TimeUnit.SECONDS)
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .retryOnConnectionFailure(true)
                    .build();
        }
        return client;
    }

    private static Dns doh(OkHttpClient bootstrap, String url, String... ips) {
        try {
            List<InetAddress> boot = new ArrayList<>();
            for (String ip : ips) boot.add(InetAddress.getByName(ip)); // IP yazımı: DNS sorgusu yapmaz
            return new DnsOverHttps.Builder().client(bootstrap).url(HttpUrl.get(url)).bootstrapDnsHosts(boot).build();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Şifreli DNS (DoH) ve sistem DNS'i paralel sorgulanır; DoH yanıtı tercih edilir.
     * Böylece sağlayıcı DNS'i alan adını engellese ya da sahte adrese yönlendirse bile gerçek adres
     * kullanılır; DoH engelliyse veya yerel ağ adıysa sistem DNS'i devreye girer, beklemeden.
     * IPv4 adresleri önce gelir (bozuk IPv6 bağlantısında takılmasın).
     */
    private static final class SmartDns implements Dns {
        private static final ExecutorService POOL = Executors.newCachedThreadPool();
        private final Dns[] secure;
        private final Map<String, Object[]> cache = new ConcurrentHashMap<>(); // ad → {adresler, bitiş}

        SmartDns(Dns... secure) {
            this.secure = secure;
        }

        @Override
        @SuppressWarnings("unchecked")
        public List<InetAddress> lookup(String host) throws UnknownHostException {
            Object[] hit = cache.get(host);
            if (hit != null && (long) hit[1] > System.currentTimeMillis()) return (List<InetAddress>) hit[0];
            Future<List<InetAddress>> doh = POOL.submit(() -> {
                for (Dns d : secure) {
                    if (d == null) continue;
                    try {
                        List<InetAddress> r = d.lookup(host);
                        if (!r.isEmpty()) return r;
                    } catch (Exception ignored) {
                    }
                }
                return Collections.emptyList();
            });
            Future<List<InetAddress>> sys = POOL.submit(() -> Dns.SYSTEM.lookup(host));
            List<InetAddress> r = await(doh, 2500);                  // 1) şifreli DNS (kısa süre tanı)
            if (r.isEmpty()) r = await(sys, 20000);                  // 2) sistem DNS'i
            if (r.isEmpty()) r = await(doh, 8000);                   // 3) şifreli DNS geç geldiyse
            if (r.isEmpty()) throw new UnknownHostException("Unable to resolve host \"" + host + "\"");
            List<InetAddress> out = ipv4First(r);
            cache.put(host, new Object[]{out, System.currentTimeMillis() + 5 * 60 * 1000});
            return out;
        }

        private static List<InetAddress> await(Future<List<InetAddress>> f, long ms) {
            try {
                List<InetAddress> r = f.get(ms, TimeUnit.MILLISECONDS);
                return r != null ? r : Collections.emptyList();
            } catch (Exception e) {
                return Collections.emptyList();
            }
        }

        private static List<InetAddress> ipv4First(List<InetAddress> in) {
            List<InetAddress> out = new ArrayList<>();
            for (InetAddress a : in) if (a instanceof Inet4Address) out.add(a);
            for (InetAddress a : in) if (!(a instanceof Inet4Address)) out.add(a);
            return out;
        }
    }
}
