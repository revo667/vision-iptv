# Vision

Xtream Codes uyumlu, mor neon cam temalı modern bir macOS IPTV oynatıcısı (Electron).

## Özellikler

- **Ana sayfa**: Netflix tarzı hero alanı, kategori satırları, İzlemeye Devam Et ve Listem
- **Filmler / Diziler**: kategori satırları, tam kategori ızgarası (sıralama ve filtre), sezon/bölüm listesi, benzer içerikler
- **Canlı TV**: kategori → kanal listesi → önizleme, yayın akışı (EPG), favori kanallar, klavyeyle kanal değiştirme
- **Oynatıcı**: HLS (hls.js) ve MPEG-TS (mpegts.js) yedekli canlı yayın, kaldığın yerden devam, sonraki bölüme otomatik geçiş, hız, PiP, tam ekran
- **İz seçimi**: video, ses ve altyazı izleri ayrı ayrı seçilebilir; bilgisayardan .srt/.vtt altyazı yüklenebilir
- **Harici oynatıcı**: desteklenmeyen formatlar (MKV/HEVC/AC3) için tek tıkla IINA veya VLC
- **Discord Rich Presence**: yalnızca o an izlenen içerik görünür; menüden kapatılabilir
- Hesap bilgileri yalnızca bu Mac'te, macOS anahtar zinciriyle şifrelenmiş olarak saklanır

## Geliştirme

```bash
npm install
npm start          # uygulamayı çalıştır
npm run dist       # dist/Vision-<sürüm>-arm64.dmg üret
```

Gerçek bir hesap olmadan denemek için sahte sunucu:

```bash
python3 tools/mock_xtream.py   # http://localhost:8765 — kullanıcı: test / şifre: test
```

Uygulama ikonu `python3 build/make_icon.py` ile yeniden üretilebilir.

## Notlar

- DMG ad-hoc imzalıdır. Başka bir Mac'e internetten indirilirse ilk açılışta sağ tık → **Aç** gerekebilir.
- Discord durumunda görsel görünmesi için Discord Developer Portal → Rich Presence → Art Assets bölümüne `vision` adında bir görsel yükleyebilirsin (`build/icon.png`).
