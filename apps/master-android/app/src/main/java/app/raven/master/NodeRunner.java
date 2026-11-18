package app.raven.master;

/** The embedded Node.js runtime. It can be started once per app process. */
final class NodeRunner {
    static {
        System.loadLibrary("node");
        System.loadLibrary("ravennode");
    }

    private NodeRunner() {}

    static native int startNode(String[] arguments);
}
