package com.revo667.vision;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Hesap bilgileri (Android Keystore ile şifreli) ve kütüphane kayıtları (favori listeleri, geçmiş, ayarlar). */
final class Stores {
    private static final String KEY_ALIAS = "vision-account";
    private final SharedPreferences account;
    private final SharedPreferences library;

    Stores(Context ctx) {
        account = ctx.getSharedPreferences("account", Context.MODE_PRIVATE);
        library = ctx.getSharedPreferences("library", Context.MODE_PRIVATE);
    }

    /* ---------- Hesap ---------- */

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    synchronized String getAccount() {
        String data = account.getString("data", null);
        if (data == null) return null;
        try {
            byte[] all = Base64.decode(data, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    synchronized boolean setAccount(String json) {
        if (json == null || json.equals("null")) {
            return account.edit().remove("data").commit();
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] enc = c.doFinal(json.getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[iv.length + enc.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(enc, 0, all, iv.length, enc.length);
            return account.edit().putString("data", Base64.encodeToString(all, Base64.NO_WRAP)).commit();
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------- Kütüphane ---------- */

    String libraryAll() {
        JSONObject o = new JSONObject();
        try {
            for (Map.Entry<String, ?> e : library.getAll().entrySet()) {
                if (e.getValue() instanceof String) o.put(e.getKey(), e.getValue());
            }
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    void librarySet(String key, String json) {
        if (key == null || key.length() > 200) return;
        SharedPreferences.Editor ed = library.edit();
        if (json == null) ed.remove(key); else ed.putString(key, json);
        ed.apply(); // Android, etkinlik durmadan önce bekleyen yazmaları tamamlar
    }

    void librarySetMany(String json) {
        try {
            JSONObject o = new JSONObject(json);
            SharedPreferences.Editor ed = library.edit();
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                ed.putString(k, o.getString(k));
            }
            ed.apply();
        } catch (Exception ignored) {
        }
    }
}
