package app.raven.master;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The key that encrypts the master's secrets (provider API keys, gateway TLS key). It is random, and stored only
 * encrypted by a key that lives in the Android Keystore and never leaves it.
 */
final class SecretKey {
    private static final String ALIAS = "raven-master-secrets";

    private SecretKey() {}

    static String hex(Context ctx) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            kg.generateKey();
        }
        javax.crypto.SecretKey wrap = (javax.crypto.SecretKey) ks.getKey(ALIAS, null);
        SharedPreferences prefs = ctx.getSharedPreferences("raven", Context.MODE_PRIVATE);
        String stored = prefs.getString("dataKey", null);
        if (stored != null) {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, wrap, new GCMParameterSpec(128, all, 0, 12));
            return toHex(c.doFinal(all, 12, all.length - 12));
        }
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, wrap);
        byte[] ct = c.doFinal(key);
        byte[] iv = c.getIV();
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        prefs.edit().putString("dataKey", Base64.encodeToString(all, Base64.NO_WRAP)).apply();
        return toHex(key);
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
