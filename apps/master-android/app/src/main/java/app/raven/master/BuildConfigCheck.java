package app.raven.master;

import android.content.Context;
import android.content.pm.ApplicationInfo;

final class BuildConfigCheck {
    private BuildConfigCheck() {}

    /** Test builds write the dashboard token where `adb run-as` can read it; release builds never do. */
    static boolean debuggable(Context ctx) {
        return (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
