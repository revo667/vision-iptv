#!/usr/bin/env python3
"""Geliştirme için sahte Xtream Codes sunucusu.

Kullanım:  python3 tools/mock_xtream.py   (port 8765)
Giriş:     sunucu http://localhost:8765  kullanıcı: test  şifre: test
Arayüzü tarayıcıda da açabilirsin: http://localhost:8765/app/renderer/index.html

Test videoları ilk çalıştırmada ffmpeg ile tools/.mock-media altına üretilir.
"""
import base64
import json
import os
import random
import re
import shutil
import subprocess
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8765"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA = os.path.join(ROOT, "tools", ".mock-media")
USER, PASS = "test", "test"
BASE = f"http://localhost:{PORT}"

random.seed(7)

MOVIE_CATS = [("1", "Aksiyon"), ("2", "Komedi"), ("3", "Dram"), ("4", "Bilim Kurgu"), ("5", "Yetişkin +18")]
SERIES_CATS = [("11", "Yerli Diziler"), ("12", "Yabancı Diziler")]
LIVE_CATS = [("21", "Ulusal"), ("22", "Spor"), ("23", "Haber"), ("24", "Belgesel")]

WORDS = ["Gece", "Kayıp", "Son", "Kızıl", "Sessiz", "Büyük", "Gizli", "Karanlık", "Altın", "Yıldız",
         "Rüzgar", "Deniz", "Şehir", "Kod", "Sınır", "Ateş", "Gölge", "Işık", "Yol", "Oyun"]
NOUNS = ["Operasyon", "Kaçış", "Yolculuk", "Sır", "İz", "Dönüş", "Av", "Görev", "Plan", "Düş"]


def title(i):
    return f"{WORDS[i % len(WORDS)]} {NOUNS[(i * 7) % len(NOUNS)]}" + (f" {i // 20 + 1}" if i >= 20 else "")


MOVIES, SERIES, LIVE = [], [], []
sid = 1000
for cid, _ in MOVIE_CATS:
    for k in range(24):
        sid += 1
        ext = "mkv" if k % 11 == 5 else "mp4"
        MOVIES.append({
            "num": len(MOVIES) + 1, "name": f"TR: {title(sid % 97)} ({2000 + sid % 25})", "stream_type": "movie",
            "stream_id": sid, "stream_icon": f"{BASE}/img/poster/{sid}.svg", "rating": f"{5 + (sid % 45) / 10:.1f}",
            "added": str(1700000000 + sid * 3600), "category_id": cid, "container_extension": ext,
        })
for cid, _ in SERIES_CATS:
    for k in range(16):
        sid += 1
        SERIES.append({
            "num": len(SERIES) + 1, "name": f"{title(sid % 89)} Dizisi", "series_id": sid,
            "cover": f"{BASE}/img/poster/{sid}.svg", "plot": "Bir kasabada başlayan sıradan bir hikaye, herkesin hayatını değiştirecek bir sırra dönüşür.",
            "cast": "Ayşe Yılmaz, Mehmet Demir, Can Kaya", "director": "Selin Aydın", "genre": "Dram, Gerilim",
            "releaseDate": f"{2010 + sid % 14}-03-01", "rating": f"{6 + (sid % 35) / 10:.1f}",
            "backdrop_path": [f"{BASE}/img/backdrop/{sid}.svg"] if k % 3 else [], "category_id": cid,
            "last_modified": str(1700000000 + sid * 3600),
        })
CH_NAMES = {"21": ["TRT 1", "ATV", "Kanal D", "Show TV", "Star TV", "FOX", "TV8", "Kanal 7"],
            "22": ["Spor 1", "Spor 2", "Spor 3", "Arena Spor", "Futbol HD", "Basket TV"],
            "23": ["Haber 24", "Gündem TV", "Ekonomi TV", "Dünya Haber"],
            "24": ["Doğa Belgesel", "Tarih TV", "Bilim Kanalı"]}
for cid, names in CH_NAMES.items():
    for n in names:
        sid += 1
        LIVE.append({"num": len(LIVE) + 1, "name": n, "stream_type": "live", "stream_id": sid,
                     "stream_icon": f"{BASE}/img/logo/{sid}.svg" if sid % 5 else "", "epg_channel_id": f"ch{sid}",
                     "category_id": cid, "tv_archive": 0})


def svg(kind, ident):
    hue = (int(ident) * 47) % 360
    if kind == "logo":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" rx="20" fill="hsl({hue},70%,50%)"/><text x="100" y="74" font-family="Helvetica" font-weight="bold" font-size="40" fill="#fff" text-anchor="middle">{ident % 100}</text></svg>"""
    w, hgt = (1280, 720) if kind == "backdrop" else (400, 600)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{hgt}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl({hue},65%,45%)"/><stop offset="1" stop-color="hsl({(hue+60)%360},70%,12%)"/></linearGradient></defs><rect width="{w}" height="{hgt}" fill="url(#g)"/><circle cx="{w*0.7}" cy="{hgt*0.35}" r="{hgt*0.25}" fill="rgba(255,255,255,0.12)"/><text x="30" y="{hgt-40}" font-family="Helvetica" font-weight="bold" font-size="{hgt/12}" fill="#fff">#{ident}</text></svg>"""


def ensure_media():
    os.makedirs(MEDIA, exist_ok=True)
    mp4 = os.path.join(MEDIA, "movie.mp4")
    if not os.path.exists(mp4):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=90",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=90", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", mp4], check=True)
    hls = os.path.join(MEDIA, "hls", "index.m3u8")
    if not os.path.exists(hls):
        os.makedirs(os.path.dirname(hls), exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4, "-c", "copy", "-f", "hls", "-hls_time", "4",
                        "-hls_playlist_type", "vod", "-hls_segment_filename", os.path.join(MEDIA, "hls", "seg%03d.ts"), hls], check=True)
    ts = os.path.join(MEDIA, "live.ts")
    if not os.path.exists(ts):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4, "-c", "copy", "-f", "mpegts", ts], check=True)


def b64(s):
    return base64.b64encode(s.encode()).decode()


def short_epg(stream_id, limit):
    now = int(time.time())
    start = now - (now % 3600) - 3600
    shows = ["Sabah Haberleri", "Günün Filmi", "Belgesel Kuşağı", "Spor Merkezi", "Akşam Dizisi", "Gece Programı", "Müzik Saati"]
    out = []
    for i in range(int(limit)):
        s = start + i * 3600
        out.append({"title": b64(shows[(int(stream_id) + i) % len(shows)]), "description": b64("Programın kısa açıklaması burada yer alır."),
                    "start_timestamp": str(s), "stop_timestamp": str(s + 3600)})
    return {"epg_listings": out}


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path

        if p.startswith("/app/"):
            rel = os.path.normpath(p[len("/app/"):])
            full = os.path.join(ROOT, rel)
            if rel.startswith("..") or not os.path.isfile(full):
                return self.send_error(404)
            ext = os.path.splitext(full)[1]
            ctype = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript"}.get(ext, "application/octet-stream")
            return self.send_file(full, ctype)

        if p.startswith("/img/"):
            _, _, kind, name = p.split("/", 3)
            body = svg(kind, int(name.split(".")[0])).encode()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)

        if p == "/player_api.php":
            if q.get("username") != USER or q.get("password") != PASS:
                return self.send_json({"user_info": {"auth": 0}})
            a = q.get("action")
            cat = q.get("category_id")
            if not a:
                return self.send_json({
                    "user_info": {"username": USER, "password": PASS, "auth": 1, "status": "Active",
                                  "exp_date": str(int(time.time()) + 86400 * 120), "is_trial": "0",
                                  "active_cons": "0", "max_connections": "1", "allowed_output_formats": ["m3u8", "ts"]},
                    "server_info": {"url": "localhost", "port": str(PORT), "timezone": "Europe/Istanbul"}})
            cats = lambda lst: [{"category_id": c, "category_name": n, "parent_id": 0} for c, n in lst]
            filt = lambda lst: [x for x in lst if not cat or x["category_id"] == cat]
            if a == "get_vod_categories": return self.send_json(cats(MOVIE_CATS))
            if a == "get_series_categories": return self.send_json(cats(SERIES_CATS))
            if a == "get_live_categories": return self.send_json(cats(LIVE_CATS))
            if a == "get_vod_streams": return self.send_json(filt(MOVIES))
            if a == "get_series": return self.send_json(filt(SERIES))
            if a == "get_live_streams": return self.send_json(filt(LIVE))
            if a == "get_short_epg": return self.send_json(short_epg(q.get("stream_id", "1"), q.get("limit", "4")))
            if a == "get_vod_info":
                m = next((x for x in MOVIES if str(x["stream_id"]) == q.get("vod_id")), None)
                if not m: return self.send_json([])
                vid = m["stream_id"]
                return self.send_json({"info": {
                    "movie_image": m["stream_icon"], "backdrop_path": [f"{BASE}/img/backdrop/{vid}.svg"] if vid % 2 else [],
                    "plot": "Eski bir dostun beklenmedik çağrısıyla şehre dönen dedektif, geçmişin hiç kapanmamış hesaplarıyla yüzleşir.",
                    "cast": "Ali Vural, Zeynep Ak, Burak Er", "director": "Deniz Kara", "genre": "Aksiyon, Gerilim",
                    "releasedate": f"{2000 + vid % 25}-05-12", "duration_secs": 5400 + vid % 1800, "duration": "01:30:00",
                    "rating": m["rating"], "youtube_trailer": "", "country": "Türkiye"},
                    "movie_data": {"stream_id": vid, "name": m["name"], "container_extension": m["container_extension"]}})
            if a == "get_series_info":
                s = next((x for x in SERIES if str(x["series_id"]) == q.get("series_id")), None)
                if not s: return self.send_json([])
                eps, eid = {}, s["series_id"] * 100
                for season in range(1, 3 + s["series_id"] % 2):
                    eps[str(season)] = []
                    for e in range(1, 7):
                        eid += 1
                        eps[str(season)].append({"id": str(eid), "episode_num": e, "season": season, "container_extension": "mp4",
                                                 "title": f"{s['name']} - S{season:02d}E{e:02d} - Bölüm Başlığı {e}",
                                                 "info": {"plot": "Bu bölümde karakterler yeni bir sırla karşılaşır.", "duration_secs": 2700,
                                                          "movie_image": f"{BASE}/img/backdrop/{eid}.svg"}})
                return self.send_json({"seasons": [], "info": {**s, "backdrop_path": s["backdrop_path"]}, "episodes": eps})
            return self.send_json([])

        m = re.match(r"^/(live|movie|series)/([^/]+)/([^/]+)/(\d+)\.(\w+)$", p)
        if m:
            kind, user, pw, ident, ext = m.groups()
            if user != USER or pw != PASS:
                return self.send_error(403)
            if kind == "live" and ext == "m3u8":
                if int(ident) % 7 == 0:  # bazı kanallar "kapalı"
                    return self.send_error(404)
                body = open(os.path.join(MEDIA, "hls", "index.m3u8")).read().replace("seg", f"{BASE}/hlsseg/seg").encode()
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if kind == "live":
                return self.send_file(os.path.join(MEDIA, "live.ts"), "video/mp2t")
            if ext == "mkv":
                return self.send_file(os.path.join(MEDIA, "movie.mp4"), "video/x-matroska")
            return self.send_file(os.path.join(MEDIA, "movie.mp4"), "video/mp4")

        if p.startswith("/hlsseg/"):
            return self.send_file(os.path.join(MEDIA, "hls", os.path.basename(p)), "video/mp2t")

        self.send_error(404)

    def do_HEAD(self):
        self.send_response(200)
        self.cors()
        self.end_headers()


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        print("Uyarı: ffmpeg bulunamadı, video testleri çalışmaz.")
    else:
        ensure_media()
    print(f"Sahte Xtream sunucusu: {BASE}  (kullanıcı: {USER} / şifre: {PASS})")
    print(f"Tarayıcı önizleme: {BASE}/app/renderer/index.html")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
