package app.tilawa.quran;

import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Qur'an AI voice engine in the Android app: Tarteel AI's Qur'an Whisper model run natively with whisper.cpp,
 * many times faster than in the WebView. The page keeps the microphone and finds the phrases (www/js/stream.js) and
 * sends each clip here.
 *
 * load({url, file, sha256?, size?, threads?, warmCtx?}): downloads the model once into the app's files (progress
 *   events "progress" {loaded, total}), loads it and times one pass -> {model, ms, threads, cores, system}
 * transcribe({audio: base64 16-bit PCM, 16 kHz mono, audioCtx?, beam?}) -> {text, ms, tokens, audioCtx}
 * unload(), cached({file}) -> {cached, size}
 * Every call runs in order on one background thread.
 */
@CapacitorPlugin(name = "Whisper")
public class WhisperPlugin extends Plugin {
    private static final String TAG = "TilawaWhisper";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private long ctx = 0;
    private String loadedFile = null;
    private int threads = 4;

    private File modelDir() {
        File d = new File(getContext().getFilesDir(), "models");
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    private static String safeName(String f) {
        return f == null ? null : f.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    @PluginMethod
    public void cached(PluginCall call) {
        String f = safeName(call.getString("file"));
        File m = f == null ? null : new File(modelDir(), f);
        JSObject r = new JSObject();
        r.put("cached", m != null && m.isFile() && m.length() > 0);
        r.put("size", m != null && m.isFile() ? m.length() : 0);
        call.resolve(r);
    }

    @PluginMethod
    public void load(PluginCall call) {
        final String url = call.getString("url");
        final String file = safeName(call.getString("file"));
        final String sha = call.getString("sha256");
        final Integer reqThreads = call.getInt("threads");
        final int warmCtx = call.getInt("warmCtx", 0);
        if (url == null || file == null) { call.reject("url and file are needed", "args"); return; }
        worker.execute(() -> {
            try {
                WhisperNative.link();
            } catch (Throwable e) {
                Log.e(TAG, "native library", e);
                call.reject("The Qur’an AI engine does not run on this phone (" + e.getMessage() + ").", "run");
                return;
            }
            try {
                File model = new File(modelDir(), file);
                if (!model.isFile() || model.length() == 0) download(url, model, sha);
                if (ctx != 0 && !file.equals(loadedFile)) { WhisperNative.free(ctx); ctx = 0; loadedFile = null; }
                int cores = Runtime.getRuntime().availableProcessors();
                // ggml's threads wait for each other by spinning: more threads than the cores free for them (the WebView and
                // the microphone need some too) makes every step wait for a thread that is not running. Up to 4 on
                // phones with 8 cores, half the cores on smaller ones.
                threads = reqThreads != null && reqThreads > 0 ? reqThreads : cores >= 8 ? 4 : Math.max(1, cores / 2);
                long t0 = System.currentTimeMillis();
                if (ctx == 0) {
                    ctx = WhisperNative.load(model.getAbsolutePath(), getContext().getApplicationInfo().nativeLibraryDir);
                    if (ctx == 0) {
                        model.delete(); // most likely a damaged file: download again next time
                        call.reject("The Qur’an AI model could not be loaded.", "run");
                        return;
                    }
                    loadedFile = file;
                    deleteOthers(file);
                }
                long loadMs = System.currentTimeMillis() - t0;
                // one pass over 2 s of quiet: loads everything into memory, and says how fast this phone is
                int[] st = new int[3];
                float[] warm = new float[32000];
                java.util.Random rnd = new java.util.Random(1);
                for (int i = 0; i < warm.length; i++) warm[i] = (float) (rnd.nextGaussian() * 0.002);
                WhisperNative.transcribe(ctx, warm, threads, warmCtx, 1, st);
                int first = st[0];
                WhisperNative.transcribe(ctx, warm, threads, warmCtx, 1, st); // the first pass also sets things up
                JSObject r = new JSObject();
                r.put("model", file);
                r.put("ms", Math.min(first, st[0]));
                r.put("firstMs", first);
                r.put("loadMs", loadMs);
                r.put("threads", threads);
                r.put("cores", cores);
                r.put("size", model.length());
                r.put("system", WhisperNative.systemInfo());
                Log.i(TAG, "loaded " + file + " in " + loadMs + " ms; warm-up " + st[0] + " ms; threads " + threads + "/" + cores + "; " + WhisperNative.systemInfo());
                call.resolve(r);
            } catch (DownloadError e) {
                Log.w(TAG, "download", e);
                call.reject(e.getMessage(), "download");
            } catch (Throwable e) {
                Log.e(TAG, "load", e);
                call.reject(String.valueOf(e.getMessage()), "run");
            }
        });
    }

    @PluginMethod
    public void transcribe(PluginCall call) {
        final String b64 = call.getString("audio");
        final int audioCtx = call.getInt("audioCtx", 0);
        final int beam = call.getInt("beam", 1);
        if (b64 == null) { call.reject("audio is needed", "args"); return; }
        worker.execute(() -> {
            if (ctx == 0) { call.reject("The model is not loaded.", "run"); return; }
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                ShortBuffer s = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
                float[] pcm = new float[s.remaining()];
                for (int i = 0; i < pcm.length; i++) pcm[i] = s.get(i) / 32768f;
                int[] st = new int[3];
                String text = WhisperNative.transcribe(ctx, pcm, threads, audioCtx, beam, st);
                if (st[1] < 0) { call.reject("The Qur’an AI model could not transcribe this.", "run"); return; }
                JSObject r = new JSObject();
                r.put("text", text == null ? "" : text.trim());
                r.put("ms", st[0]);
                r.put("tokens", st[1]);
                r.put("audioCtx", st[2]);
                call.resolve(r);
            } catch (Throwable e) {
                Log.e(TAG, "transcribe", e);
                call.reject(String.valueOf(e.getMessage()), "run");
            }
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        worker.execute(() -> {
            if (ctx != 0) { WhisperNative.free(ctx); ctx = 0; loadedFile = null; }
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(() -> { if (ctx != 0) { WhisperNative.free(ctx); ctx = 0; } });
        worker.shutdown();
    }

    private static class DownloadError extends IOException {
        DownloadError(String m) { super(m); }
    }

    /** Keeps only the model in use (an earlier version or another size would just take space). */
    private void deleteOthers(String keep) {
        File[] fs = modelDir().listFiles();
        if (fs == null) return;
        for (File f : fs) if (!f.getName().equals(keep) && !f.getName().equals(keep + ".part")) f.delete();
    }

    /** Downloads to <file>.part (resuming a broken download), checks the checksum, then renames. */
    private void download(String url, File dest, String sha) throws IOException {
        File part = new File(dest.getPath() + ".part");
        IOException last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            if (attempt > 0) try { Thread.sleep(1500L << attempt); } catch (InterruptedException ignored) {}
            try {
                fetch(url, part);
                last = null;
                break;
            } catch (DownloadError e) {
                throw e;
            } catch (IOException e) {
                last = e;
                Log.w(TAG, "download attempt " + attempt, e);
            }
        }
        if (last != null) throw new DownloadError("The Qur’an AI model could not be downloaded. Check your internet connection.");
        if (sha != null && !sha.isEmpty()) {
            String got = sha256(part);
            if (!got.equalsIgnoreCase(sha)) {
                part.delete();
                throw new DownloadError("The downloaded Qur’an AI model was damaged. Try again.");
            }
        }
        if (!part.renameTo(dest)) throw new IOException("could not save the model");
    }

    private void fetch(String url, File part) throws IOException {
        long have = part.isFile() ? part.length() : 0;
        String u = url;
        HttpURLConnection c = null;
        for (int hop = 0; hop < 6; hop++) { // GitHub release assets redirect to their storage host
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "Tilawa");
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                u = new URL(new URL(u), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            break;
        }
        int code = c.getResponseCode();
        if (code == 416) { c.disconnect(); return; } // already complete
        if (code != 200 && code != 206) {
            c.disconnect();
            if (code == 404 || code == 403) throw new DownloadError("The Qur’an AI model could not be downloaded (" + code + ").");
            throw new IOException("HTTP " + code);
        }
        boolean append = code == 206 && have > 0;
        if (!append) have = 0;
        long len = c.getContentLengthLong();
        long total = len > 0 ? have + len : -1;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
            byte[] buf = new byte[1 << 16];
            long got = have, lastEmit = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit > 300) {
                    lastEmit = now;
                    JSObject p = new JSObject();
                    p.put("loaded", got);
                    p.put("total", total);
                    notifyListeners("progress", p);
                }
            }
            if (total > 0 && got < total) throw new IOException("connection closed at " + got + " of " + total);
        } finally {
            c.disconnect();
        }
    }

    private static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }
}
