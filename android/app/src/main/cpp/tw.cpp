#include "tw.h"
#include "whisper.h"
#include "ggml-backend.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <mutex>
#include <vector>

static std::once_flag backends_once;

// Length of the unit repeated at the end of ids (the same 2+ tokens three times in a row, or one token four times),
// or 0. Recitation never says the same words three times running: that is the model stuck in a loop.
static int repeated_tail(const std::vector<int> & ids) {
    const int n = (int) ids.size();
    for (int p = 1; p <= 16; p++) {
        const int times = p == 1 ? 4 : 3;
        if (times * p > n) break;
        bool rep = true;
        for (int i = 0; i < (times - 1) * p && rep; i++) rep = ids[n - 1 - i] == ids[n - 1 - i - p];
        if (rep) return p;
    }
    return 0;
}

// Ends the text as soon as it starts looping, instead of decoding up to max_tokens of it.
static void stop_loops(whisper_context * ctx, whisper_state *, const whisper_token_data * tokens, int n, float * logits, void *) {
    std::vector<int> ids(n);
    for (int i = 0; i < n; i++) ids[i] = tokens[i].id;
    if (!repeated_tail(ids)) return;
    const int nv = whisper_n_vocab(ctx), eot = whisper_token_eot(ctx);
    for (int v = 0; v < nv; v++) if (v != eot) logits[v] = -INFINITY;
}

whisper_context * tw_load(const char * model_path, const char * backend_dir) {
    std::call_once(backends_once, [&] {
        // With GGML_BACKEND_DL the CPU backend is one of several builds (plain ARMv8.0, dot product, fp16, int8
        // matmul, ...): ggml loads the best one this CPU can run. Without it the CPU backend is linked in.
        if (backend_dir && *backend_dir) ggml_backend_load_all_from_path(backend_dir);
    });
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    cp.flash_attn = true;
    return whisper_init_from_file_with_params(model_path, cp);
}

void tw_free(whisper_context * ctx) {
    if (ctx) whisper_free(ctx);
}

tw_result tw_transcribe(whisper_context * ctx, const float * pcm, int n, int threads, int audio_ctx, int beam) {
    tw_result r;
    const auto t0 = std::chrono::steady_clock::now();
    // at least half a second (whisper.cpp ignores clips under 100 ms), at most the model's 30 s window
    const int min_n = WHISPER_SAMPLE_RATE / 2, max_n = WHISPER_SAMPLE_RATE * 30;
    std::vector<float> buf;
    if (n < min_n) { buf.assign(pcm, pcm + n); buf.resize(min_n, 0.0f); pcm = buf.data(); n = min_n; }
    if (n > max_n) n = max_n;
    const double sec = (double) n / WHISPER_SAMPLE_RATE;

    const int full = whisper_model_n_audio_ctx(ctx);
    // the encoder sees 50 positions per second: never fewer than the clip needs
    int actx = audio_ctx <= 0 ? full : std::max(audio_ctx, (int) std::ceil(n / 320.0) + 1);
    if (actx >= full) actx = full;
    r.audio_ctx = actx;

    whisper_full_params p = whisper_full_default_params(beam > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
    p.n_threads = std::max(1, threads);
    p.language = "ar";
    p.detect_language = false;
    p.translate = false;
    p.no_context = true;      // nothing carried over from the previous clip
    p.no_timestamps = true;
    p.single_segment = true;
    p.print_special = p.print_progress = p.print_realtime = p.print_timestamps = false;
    p.suppress_blank = true;
    p.suppress_nst = true;    // no "[music]", "(applause)" and the like
    p.temperature = 0.0f;
    p.temperature_inc = 0.0f; // no re-decoding at higher temperatures: stream.js drops a stuck output instead
    p.greedy.best_of = 1;
    p.beam_search.beam_size = std::max(2, beam);
    p.audio_ctx = actx >= full ? 0 : actx;
    // A model stuck repeating itself would otherwise decode up to 224 tokens. The output is fully voweled (about 7
    // tokens a word): this leaves room for fast recitation (3 words a second).
    p.max_tokens = 24 + (int) std::ceil(sec * 20);
    // Deliberately no initial prompt with the expected verse: the model would then "hear" the right word when the
    // reader says a wrong one, hiding the very mistakes the app is there to show.
    p.initial_prompt = nullptr;
    p.logits_filter_callback = stop_loops;

    if (whisper_full(ctx, p, pcm, n) == 0) {
        std::vector<int> ids;
        std::vector<std::string> texts;
        const int ns = whisper_full_n_segments(ctx);
        for (int i = 0; i < ns; i++) {
            const int nt = whisper_full_n_tokens(ctx, i);
            for (int j = 0; j < nt; j++) {
                const int id = whisper_full_get_token_id(ctx, i, j);
                if (id >= whisper_token_eot(ctx)) continue; // special tokens
                ids.push_back(id);
                texts.push_back(whisper_full_get_token_text(ctx, i, j));
            }
        }
        r.tokens = (int) ids.size();
        // a loop that was stopped: keep its words once
        for (int u; (u = repeated_tail(ids)) > 0;) {
            const int keep = (int) ids.size() - (u == 1 ? 3 : 2 * u);
            ids.resize(keep);
            texts.resize(keep);
        }
        for (const auto & t : texts) r.text += t;
    } else {
        r.text.clear();
        r.tokens = -1;
    }
    r.ms = (int) std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    return r;
}

std::string tw_system_info() {
    return whisper_print_system_info();
}
