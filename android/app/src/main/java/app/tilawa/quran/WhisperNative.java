package app.tilawa.quran;

/** whisper.cpp through JNI (src/main/cpp). Not thread safe: WhisperPlugin calls it from one thread. */
final class WhisperNative {
    private static Throwable linkError;
    private static boolean linked;

    /** Loads the native library once; throws if this device can't (missing ABI, old CPU). */
    static synchronized void link() {
        if (linked) return;
        if (linkError != null) throw new UnsatisfiedLinkError(linkError.getMessage());
        try {
            System.loadLibrary("tilawa_whisper");
            linked = true;
        } catch (Throwable e) {
            linkError = e;
            throw new UnsatisfiedLinkError(String.valueOf(e.getMessage()));
        }
    }

    /** backendDir: the app's native library folder, where the CPU backends for each feature set are. 0 on failure. */
    static native long load(String modelPath, String backendDir);
    static native void free(long ctx);
    /** pcm: 16 kHz mono. audioCtx: 0 = the full 30 s window. stats (out): ms, tokens (-1 = failed), audio_ctx used. */
    static native String transcribe(long ctx, float[] pcm, int threads, int audioCtx, int beam, int[] stats);
    static native String systemInfo();

    private WhisperNative() {}
}
