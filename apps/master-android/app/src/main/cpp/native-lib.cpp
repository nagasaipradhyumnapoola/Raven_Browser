// Starts the embedded Node.js runtime (nodejs-mobile) with the master's script, and sends its output to logcat.
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"

static int pipeOut[2];
static int pipeErr[2];

static void *pump(void *arg) {
    int fd = *static_cast<int *>(arg);
    int prio = fd == pipeErr[0] ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') n--;
        buf[n] = 0;
        __android_log_write(prio, "RavenMaster", buf);
    }
    return nullptr;
}

static void redirectOutput() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(pipeOut) == 0 && pipe(pipeErr) == 0) {
        dup2(pipeOut[1], STDOUT_FILENO);
        dup2(pipeErr[1], STDERR_FILENO);
        pthread_t a, b;
        pthread_create(&a, nullptr, pump, &pipeOut[0]);
        pthread_detach(a);
        pthread_create(&b, nullptr, pump, &pipeErr[0]);
        pthread_detach(b);
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_app_raven_master_NodeRunner_startNode(JNIEnv *env, jclass, jobjectArray arguments) {
    jsize count = env->GetArrayLength(arguments);
    // Node expects all arguments in one contiguous block of memory.
    std::vector<std::string> args;
    size_t total = 0;
    for (jsize i = 0; i < count; i++) {
        auto js = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(js, nullptr);
        args.emplace_back(c);
        total += args.back().size() + 1;
        env->ReleaseStringUTFChars(js, c);
        env->DeleteLocalRef(js);
    }
    char *block = static_cast<char *>(calloc(total, 1));
    std::vector<char *> argv(count);
    char *pos = block;
    for (jsize i = 0; i < count; i++) {
        memcpy(pos, args[i].c_str(), args[i].size());
        argv[i] = pos;
        pos += args[i].size() + 1;
    }
    redirectOutput();
    return jint(node::Start(count, argv.data()));
}
