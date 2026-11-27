// JNI side of WhisperNative.java: a thin layer over tw.cpp.
#include <jni.h>
#include <cstdint>
#include <string>
#include "tw.h"
#include "whisper.h"

#ifdef __ANDROID__
#include <android/log.h>
static void log_cb(enum ggml_log_level level, const char * text, void *) {
    const int prio = level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : level == GGML_LOG_LEVEL_WARN ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    __android_log_write(prio, "TilawaWhisper", text);
}
#endif

static std::string str(JNIEnv * env, jstring s) {
    if (!s) return std::string();
    const char * c = env->GetStringUTFChars(s, nullptr);
    std::string r(c ? c : "");
    if (c) env->ReleaseStringUTFChars(s, c);
    return r;
}

// Java's NewStringUTF wants modified UTF-8 and aborts on some invalid sequences: build the string from UTF-16.
static jstring jstr(JNIEnv * env, const std::string & s) {
    std::u16string u;
    for (size_t i = 0; i < s.size();) {
        unsigned char c = s[i];
        uint32_t cp; int len;
        if (c < 0x80) { cp = c; len = 1; }
        else if ((c >> 5) == 6) { cp = c & 0x1f; len = 2; }
        else if ((c >> 4) == 14) { cp = c & 0x0f; len = 3; }
        else if ((c >> 3) == 30) { cp = c & 0x07; len = 4; }
        else { i++; continue; } // stray byte (a token can end mid-character)
        if (i + len > s.size()) break;
        bool ok = true;
        for (int k = 1; k < len; k++) { unsigned char d = s[i + k]; if ((d >> 6) != 2) { ok = false; break; } cp = (cp << 6) | (d & 0x3f); }
        if (!ok) { i++; continue; }
        i += len;
        if (cp >= 0x10000) { cp -= 0x10000; u.push_back((char16_t) (0xD800 + (cp >> 10))); u.push_back((char16_t) (0xDC00 + (cp & 0x3ff))); }
        else u.push_back((char16_t) cp);
    }
    return env->NewString((const jchar *) u.data(), (jsize) u.size());
}

extern "C" {

JNIEXPORT jlong JNICALL Java_app_tilawa_quran_WhisperNative_load(JNIEnv * env, jclass, jstring model, jstring backendDir) {
#ifdef __ANDROID__
    whisper_log_set(log_cb, nullptr);
#endif
    const std::string m = str(env, model), d = str(env, backendDir);
    return (jlong) tw_load(m.c_str(), d.empty() ? nullptr : d.c_str());
}

JNIEXPORT void JNICALL Java_app_tilawa_quran_WhisperNative_free(JNIEnv *, jclass, jlong ctx) {
    tw_free((whisper_context *) ctx);
}

// stats (out): ms, tokens (-1 = the pass failed), audio_ctx
JNIEXPORT jstring JNICALL Java_app_tilawa_quran_WhisperNative_transcribe(JNIEnv * env, jclass, jlong ctx, jfloatArray pcm, jint threads, jint audioCtx, jint beam, jintArray stats) {
    const jsize n = env->GetArrayLength(pcm);
    jfloat * a = env->GetFloatArrayElements(pcm, nullptr);
    tw_result r = tw_transcribe((whisper_context *) ctx, a, (int) n, threads, audioCtx, beam);
    env->ReleaseFloatArrayElements(pcm, a, JNI_ABORT);
    if (stats && env->GetArrayLength(stats) >= 3) {
        jint s[3] = { r.ms, r.tokens, r.audio_ctx };
        env->SetIntArrayRegion(stats, 0, 3, s);
    }
    return jstr(env, r.text);
}

JNIEXPORT jstring JNICALL Java_app_tilawa_quran_WhisperNative_systemInfo(JNIEnv * env, jclass) {
    return jstr(env, tw_system_info());
}

}
