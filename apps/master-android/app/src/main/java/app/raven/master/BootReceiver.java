package app.raven.master;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.io.File;

/** Starts the master after the phone restarts, if "Start when you sign in" is on in the dashboard. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        File flag = new File(MasterService.dataDir(ctx), "autostart");
        if ("1".equals(MasterService.readText(flag))) MasterService.start(ctx);
    }
}
