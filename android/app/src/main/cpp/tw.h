// Tilawa's use of whisper.cpp, shared by the Android plugin (jni.cpp) and the desktop benchmark (tests/native).
#pragma once
#include <string>

struct whisper_context;

struct tw_result {
    std::string text;
    int ms = 0;        // wall time of the whole pass
    int tokens = 0;    // text tokens decoded
    int audio_ctx = 0; // encoder positions used (1500 = the full 30 s window)
};

// backend_dir: where libggml-cpu-*.so live when ggml is built with GGML_BACKEND_DL (Android arm64), else nullptr.
whisper_context * tw_load(const char * model_path, const char * backend_dir);
void tw_free(whisper_context * ctx);

// pcm: 16 kHz mono. audio_ctx: 0 = the full 30 s window, else this many encoder positions (50 per second of audio;
// raised to cover the clip). Plain transcription in Arabic: no prompt, no context from earlier clips.
tw_result tw_transcribe(whisper_context * ctx, const float * pcm, int n, int threads, int audio_ctx, int beam);

// The CPU features ggml uses, for logs.
std::string tw_system_info();
