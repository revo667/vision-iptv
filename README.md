# Vision

Xtream Codes uyumlu, mor neon cam temalı modern bir IPTV oynatıcısı.
**macOS**, **Windows**, **Android telefon/tablet** ve **Android TV** sürümleri aynı arayüzü paylaşır.

## Özellikler

- **Ana sayfa**: Netflix tarzı hero alanı, kategori satırları, İzlemeye Devam Et ve Listem
- **Filmler / Diziler**: kategori satırları, tam kategori ızgarası (sıralama ve filtre), sezon/bölüm listesi, benzer içerikler
- **Canlı TV**: kategori → kanal listesi → önizleme, yayın akışı (EPG), klavye / kumandayla kanal değiştirme
- **Favori listeleri**: kanallar birden çok, adlandırılabilir favori listesine eklenebilir (★ → liste seç / yeni liste oluştur); listeler yeniden adlandırılabilir, sıralanabilir, silinebilir
- **Oynatıcı**: kaldığın yerden devam, sonraki bölüme otomatik geçiş, hız, PiP, tam ekran
- **İz seçimi**: dosyadaki tüm video / ses / altyazı izleri listelenir; gömülü yazı altyazılar (SRT, ASS, MP4 metin) uygulama içinde gösterilir; seçilen ses ve altyazı dili hatırlanır
- **Harici oynatıcı**: uygulama içinde çalınamayan formatlar için tek tıkla IINA / VLC (macOS), VLC / PotPlayer / MPC-HC (Windows) veya başka bir Android uygulaması
- **Discord Rich Presence** (masaüstü): yalnızca o an izlenen içerik görünür; menüden kapatılabilir
- **Otomatik güncelleme**: tüm sürümler yeni sürümü GitHub Releases'tan alır
- Hesap bilgileri cihazda şifrelenmiş saklanır (macOS anahtar zinciri, Windows DPAPI, Android Keystore)

### Platforma göre oynatma

| | Film / dizi | Canlı TV | AC3 / E-AC3 / DTS ses |
|---|---|---|---|
| macOS / Windows | Chromium (akış ana süreçten geçer, izler ve altyazılar okunur) | hls.js / mpegts.js | Listelenir, harici oynatıcı önerilir |
| Android / Android TV | Media3 (ExoPlayer) | Media3 (önce TS, sonra HLS) | FFmpeg çözücüsüyle uygulama içinde |

Android TV'de arayüz kumandayla gezilir (yön tuşları, OK, Geri). Canlı yayında yukarı/aşağı (veya CH+/CH−) kanal değiştirir, sol tuş kanal listesini açar; filmde sol/sağ 10 sn sarar.

## Geliştirme

```bash
npm install
npm start               # masaüstü uygulamasını çalıştır
npm run dist            # dist/Vision-<sürüm>-mac-arm64.dmg (+ .zip)
npm run dist:win        # dist/Vision-Setup-<sürüm>.exe (Mac'te de derlenebilir)
npm run android         # android/app/build/outputs/apk/release/app-release.apk
npm run android:debug   # hata ayıklama APK'sı
```

Android derlemesi için JDK 21 ve Android SDK (platform 36, build-tools 36.1.0) gerekir.
`android/local.properties` içinde `sdk.dir=...` ya da `ANDROID_HOME` tanımlı olmalı.

Gerçek bir hesap olmadan denemek için sahte sunucu:

```bash
python3 tools/mock_xtream.py   # http://localhost:8765 — kullanıcı: test / şifre: test
```

Android emülatöründen bu sunucuya erişmek için: `adb reverse tcp:8765 tcp:8765`.

İkonlar: `python3 build/make_icon.py` (masaüstü), `npm run android:icons` (Android başlatıcı ikonları + TV banner'ı).

## Sürüm yayınlama ve güncellemeler

`main` dalına her push'ta [.github/workflows/release.yml](.github/workflows/release.yml) çalışır:

1. Sürüm numarası `package.json`'daki ana.ara + çalışma numarasıdır (ör. `1.0.37`).
2. Android APK, Windows kurucusu ve macOS (dmg + zip) paralel derlenir.
3. Hepsi `v1.0.37` adlı tek bir GitHub Release'te yayınlanır.

Uygulamalar açılışta ve birkaç saatte bir yeni sürümü denetler; profil menüsündeki **Güncellemeleri denetle** ile elle de denetlenebilir:

- **Android / Android TV**: APK uygulama içinde indirilir ve sistem yükleyicisiyle kurulur (ilk seferde “bilinmeyen uygulamaları yükleme” izni istenir).
- **Windows**: arka planda indirilir, “Yeniden başlat” ile kurulur.
- **macOS**: zip indirilir, uygulama kapanınca yerinde değiştirilir ve yeniden açılır.

Bir push'ta sürüm çıkmasın istersen commit mesajına `[skip ci]` ekle. Ana/ara sürümü değiştirmek için `package.json`'daki `version` alanını güncelle (ör. `1.1.0` → sonraki sürümler `1.1.<n>`).

### Gerekli GitHub gizli değişkenleri

| Ad | İçerik |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i android/keystore/vision-release.jks` çıktısı |
| `ANDROID_KEYSTORE_PASSWORD` | `android/keystore.properties` içindeki parola |

Tüm APK'lar **aynı anahtarla** imzalanmalıdır; aksi halde Android güncellemeyi kurmaz. Anahtar
(`android/keystore/`) ve `android/keystore.properties` git'e eklenmez — kaybetme, yedekle.

## Notlar

- macOS uygulaması ad-hoc imzalıdır. İnternetten indirilen DMG ilk açılışta sağ tık → **Aç** isteyebilir.
- Windows kurucusu imzasızdır; ilk kurulumda SmartScreen “Yine de çalıştır” isteyebilir.
- Discord durumunda görsel görünmesi için Discord Developer Portal → Rich Presence → Art Assets bölümüne `vision` adında bir görsel yükleyebilirsin (`build/icon.png`).
