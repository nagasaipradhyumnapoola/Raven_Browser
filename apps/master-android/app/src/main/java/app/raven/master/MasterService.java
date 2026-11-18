package app.raven.master;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Runs the Raven master (Node.js) in the background with an ongoing notification, so phones keep serving
 * other devices while the screen is off.
 */
public class MasterService extends Service {
    static final int DASH_PORT = 47812;
    private static final String CHANNEL = "raven-master";
    private static volatile boolean nodeStarted = false;
    static volatile String token = null;
    static volatile String lastError = null;

    private WifiManager.MulticastLock multicast;
    private PowerManager.WakeLock wake;
    private Thread netWatch;

    static File dataDir(Context ctx) {
        return new File(ctx.getFilesDir(), "MasterServerData");
    }

    static void start(Context ctx) {
        Intent i = new Intent(ctx, MasterService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    /** True once the dashboard answers on this phone. */
    static boolean ready() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", DASH_PORT), 300);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        watchPairingAlerts();
        if (!nodeStarted) {
            nodeStarted = true;
            new Thread(null, this::runNode, "raven-node", 16 * 1024 * 1024).start();
        }
        return START_STICKY;
    }

    private static final String ALERTS = "raven-requests";
    private Thread alertWatch;

    /** A device asks to connect: the master writes pairing-alert.json; show it at once as a heads-up notification. */
    private void watchPairingAlerts() {
        if (alertWatch != null) return;
        alertWatch = new Thread(() -> {
            File f = new File(dataDir(this), "pairing-alert.json");
            long seen = f.lastModified();
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(1000);
                    long m = f.lastModified();
                    if (m == 0 || m == seen) continue;
                    seen = m;
                    byte[] raw = java.nio.file.Files.readAllBytes(f.toPath());
                    org.json.JSONObject o = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
                    showPairingAlert(o.optString("name", "A device"), o.optString("code", ""));
                } catch (InterruptedException e) {
                    return;
                } catch (Exception e) {
                    Log.w("RavenMaster", "pairing alert: " + e.getMessage());
                }
            }
        }, "raven-alerts");
        alertWatch.setDaemon(true);
        alertWatch.start();
    }

    private void showPairingAlert(String name, String code) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ALERTS) == null) {
            NotificationChannel ch = new NotificationChannel(ALERTS, "Connection requests", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("A device asks to use this master.");
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ALERTS) : new Notification.Builder(this);
        b.setContentTitle("A device wants to connect")
                .setContentText("\"" + name + "\" is waiting for approval. Code " + code + ".")
                .setSmallIcon(R.drawable.ic_raven)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        nm.notify(2, b.build());
    }

    private void goForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Raven Master", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while this phone serves other devices.");
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setContentTitle("Raven Master is running")
                .setContentText("Serving internet and AI to your approved devices.")
                .setSmallIcon(R.drawable.ic_raven)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
    }

    private void runNode() {
        try {
            File project = new File(getFilesDir(), "nodejs-project");
            copyAssetsIfNew(project);
            File data = dataDir(this);
            //noinspection ResultOfMethodCallIgnored
            data.mkdirs();
            byte[] t = new byte[24];
            new SecureRandom().nextBytes(t);
            token = android.util.Base64.encodeToString(t, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
            if (BuildConfigCheck.debuggable(this)) writeText(new File(getFilesDir(), "dashboard.token"), token);
            Os.setenv("RAVEN_DASH_TOKEN", token, true);
            Os.setenv("RAVEN_SECRET_KEY", SecretKey.hex(this), true);
            Os.setenv("RAVEN_LAN_IPS", String.join(",", lanAddresses()), true);
            Os.setenv("RAVEN_PLATFORM", "android", true);
            Os.setenv("HOME", getFilesDir().getAbsolutePath(), true);
            Os.setenv("TMPDIR", getCacheDir().getAbsolutePath(), true);

            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            multicast = wifi.createMulticastLock("raven-mdns");
            multicast.setReferenceCounted(false);
            multicast.acquire();
            PowerManager pm = getSystemService(PowerManager.class);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "raven:master");
            wake.acquire();
            startNetWatch(data);

            int code = NodeRunner.startNode(new String[] {
                    "node",
                    new File(project, "raven-master.cjs").getAbsolutePath(),
                    "--data", data.getAbsolutePath(),
                    "--dashboard-port", String.valueOf(DASH_PORT)
            });
            Log.i("RavenMaster", "Node exited with " + code);
        } catch (Throwable e) {
            lastError = String.valueOf(e);
            Log.e("RavenMaster", "Could not start the master", e);
        }
        stopSelf();
    }

    /** Keeps the master told about this phone's Wi-Fi / hotspot addresses (Android may hide them from Node). */
    private void startNetWatch(File data) {
        netWatch = new Thread(() -> {
            String last = "";
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    String now = String.join(",", lanAddresses());
                    if (!now.equals(last)) {
                        writeText(new File(data, "lan-ips.txt"), now);
                        last = now;
                    }
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    return;
                } catch (Exception ignored) {
                    // try again next round
                }
            }
        }, "raven-netwatch");
        netWatch.setDaemon(true);
        netWatch.start();
    }

    static List<String> lanAddresses() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
            // no interfaces visible
        }
        return out;
    }

    private void copyAssetsIfNew(File dest) throws Exception {
        long installed = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        File stamp = new File(dest, ".installed");
        if (stamp.exists() && readText(stamp).equals(String.valueOf(installed))) return;
        deleteTree(dest);
        copyAsset(getAssets(), "nodejs-project", dest);
        writeText(stamp, String.valueOf(installed));
    }

    private static void copyAsset(AssetManager am, String path, File dest) throws Exception {
        String[] list = am.list(path);
        if (list == null || list.length == 0) {
            //noinspection ResultOfMethodCallIgnored
            dest.getParentFile().mkdirs();
            try (InputStream in = am.open(path); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        dest.mkdirs();
        for (String child : list) copyAsset(am, path + "/" + child, new File(dest, child));
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    static void writeText(File f, String s) throws Exception {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(s.getBytes("UTF-8"));
        }
    }

    static String readText(File f) {
        try {
            return new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8").trim();
        } catch (Exception e) {
            return "";
        }
    }

    @Override
    public void onDestroy() {
        if (netWatch != null) netWatch.interrupt();
        if (alertWatch != null) alertWatch.interrupt();
        if (multicast != null && multicast.isHeld()) multicast.release();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
