// Desktop benchmark of the Android engine's exact decoding (android/app/src/main/cpp/tw.cpp) on real recitation.
// bench <model.bin> <threads> <margin s, -1 = full 30 s window> <beam> <file.wav>... [--clips 1,5,15 --repeat 3]
// Prints one JSON line per pass: file, seconds of audio, ms, decoded tokens, encoder positions, text.
#include "tw.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iterator>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

static std::vector<float> read_wav(const char * path) { // 16 kHz mono 16-bit PCM
    std::ifstream f(path, std::ios::binary);
    std::vector<char> b((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    std::vector<float> out;
    for (size_t i = 12; i + 8 <= b.size();) {
        uint32_t sz; memcpy(&sz, &b[i + 4], 4);
        if (!memcmp(&b[i], "data", 4)) {
            const int16_t * s = (const int16_t *) &b[i + 8];
            size_t n = std::min<size_t>(sz, b.size() - i - 8) / 2;
            out.resize(n);
            for (size_t k = 0; k < n; k++) out[k] = s[k] / 32768.0f;
            break;
        }
        i += 8 + sz + (sz & 1);
    }
    return out;
}

static std::string esc(const std::string & s) {
    std::string o;
    for (char c : s) { if (c == '"' || c == '\\') o += '\\'; if ((unsigned char) c >= 0x20) o += c; }
    return o;
}

int main(int argc, char ** argv) {
    if (argc < 6) { fprintf(stderr, "usage: bench model threads margin beam file.wav... [--clips 1,5,15 --repeat 3]\n"); return 1; }
    const char * model = argv[1];
    const int threads = atoi(argv[2]), beam = atoi(argv[4]);
    const double margin = atof(argv[3]);
    std::vector<const char *> files; std::vector<double> clips; int repeat = 1;
    for (int i = 5; i < argc; i++) {
        if (!strcmp(argv[i], "--clips") && i + 1 < argc) { for (char * t = strtok(argv[++i], ","); t; t = strtok(nullptr, ",")) clips.push_back(atof(t)); }
        else if (!strcmp(argv[i], "--repeat") && i + 1 < argc) repeat = atoi(argv[++i]);
        else files.push_back(argv[i]);
    }
    whisper_context * ctx = tw_load(model, nullptr);
    if (!ctx) { fprintf(stderr, "could not load %s\n", model); return 1; }
    fprintf(stderr, "%s\n", tw_system_info().c_str());
    auto pass = [&](const char * name, const float * a, int n) {
        const double sec = n / 16000.0;
        const int actx = margin < 0 ? 0 : (int) std::ceil((sec + margin) * 50);
        tw_result r = tw_transcribe(ctx, a, n, threads, actx, beam);
        printf("{\"file\":\"%s\",\"sec\":%.2f,\"ms\":%d,\"tokens\":%d,\"actx\":%d,\"text\":\"%s\"}\n", name, sec, r.ms, r.tokens, r.audio_ctx, esc(r.text).c_str());
        fflush(stdout);
    };
    { std::vector<float> warm(16000, 0.0f); tw_transcribe(ctx, warm.data(), (int) warm.size(), threads, 0, 1); }
    for (const char * f : files) {
        std::vector<float> a = read_wav(f);
        if (clips.empty()) pass(f, a.data(), (int) a.size());
        else for (double c : clips) for (int k = 0; k < repeat; k++) pass(f, a.data(), (int) std::min<size_t>(a.size(), (size_t) (c * 16000)));
    }
    tw_free(ctx);
    return 0;
}
