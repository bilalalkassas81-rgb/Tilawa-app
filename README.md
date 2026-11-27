# Tilawa — تلاوة

A free Qur’an recitation companion. Recite out loud and Tilawa follows along word by word, marking wrong and skipped words as you go. Every feature is included, with no subscription, no ads and no account.

## Features

| | |
|---|---|
| **Recitation mistake detection** | Listens while you recite. Correct words turn green, wrong words red, skipped words amber. Works for any passage and has no daily limit. |
| **Qur’an AI voice engine** | Optional. Tarteel AI’s speech model, trained on Qur’an recitation, runs on your device and follows you word by word more closely than the phone’s general dictation. In the Android app it runs natively (whisper.cpp), fast enough to follow as you recite: a one-time download of about __MB__ MB. In the web app it runs in the browser (about 100 MB, and much slower on phones). Then it works offline. Choose it in Settings → Voice engine. |
| **Memorization mode** | Hides the verses and reveals each word only after you recite it. Tap a hidden word, or press “Reveal word”, when you need a hint. |
| **Mistake history** | Each session keeps its mistakes. The Progress tab lists the words you miss most, with a “Practise these verses” button. |
| **Session summary** | Accuracy, mistakes, hints, time, and the exact words to review, with links back to each verse. |
| **Listen back to yourself** | Optionally records your voice during a session so you can replay it (web version). |
| **Test mode** | Opens at a random verse in the surahs you’ve memorized, shows the first two words as a cue, hides the rest, and scores each question. Ends with a results screen and “practise weak spots”. |
| **Memorization plans** | Memorize, Review or Recite a portion (surahs, juz or pages) by a deadline, in order or in reverse. The daily target recalculates if you fall behind. Memorize and Review only count verses recited with the words hidden. |
| **Goals and streaks** | Daily goal in verses, minutes or words, a progress ring, and a day streak. |
| **Khatm planner** | Finish the whole Qur’an in 30 days, 60 days, 6 months, 1 or 2 years. It tracks every verse you recite and adjusts your daily target. |
| **Daily reminder** | A notification at a time you pick (Android app). |
| **Audio recitation** | 12 reciters, repeat each verse 1–10 times or endlessly, loop a range, 0.75×–1.5× speed, lock-screen controls. |
| **Find a verse by voice** | Recite a few words and Tilawa finds the verse. |
| **Search** | Surah names, references like `2:255`, Arabic words, or words in the translation. |
| **Translations** | English, French, Spanish, Indonesian, Turkish, Russian, Urdu, Bengali, Chinese, Swedish, plus transliteration. |
| **Navigation** | 114 surahs, 30 juz, any verse range, previous and next passage. |
| **Bookmarks and notes** | Tap a verse number to bookmark it, add a note, copy it or share it. |
| **Progress dashboard** | Totals, a 14-day chart against your goal, a 114-surah accuracy map, and full session history. |
| **Comfort** | Light and dark themes, adjustable text size, the Uthmani script in the Amiri Quran font, and offline reading. |
| **Backup** | Copy your data as text and restore it on another phone. |

Tilawa only checks the words. It cannot judge tajweed (pronunciation rules), so always learn with a qualified teacher.

## Install it (free)

**Android:** open the [latest release](https://github.com/bilalalkassas81-rgb/Tilawa-app/releases/latest), download `Tilawa.apk` and open it. If Android asks, allow your browser or Files app to “install unknown apps”.

**iPhone, iPad and any other phone or computer:** open the web app at **https://bilalalkassas81-rgb.github.io/Tilawa-app/**.
- iPhone (Safari): tap Share, then **Add to Home Screen**.
- Android (Chrome): tap ⋮, then **Install app**.

It then opens full screen like a normal app and works offline for reading.

Voice recitation uses the phone’s built-in speech recognition by default: Google on Android and in Chrome, Apple in Safari. It needs an internet connection. In Settings you can switch to the Qur’an AI model instead, which runs on the device and works offline once downloaded.

## How it is built

- `www/`: the whole app in plain HTML, CSS and JavaScript (no build step).
  - `js/match.js`: Arabic normalisation and word-by-word alignment of what was heard against the Uthmani text.
  - `js/speech.js`: native speech recognition in the Android app, the Web Speech API in browsers, or the Qur’an AI engine, all behind one recogniser interface.
  - `js/ai.js`, `js/asr-worker.js`, `js/stream.js`, `js/mic-worklet.js`: the optional Qur’an AI engine. The microphone is read with an AudioWorklet and resampled to 16 kHz; `stream.js` finds speech with a simple energy detector, transcribes the phrase so far whenever the model is free while you recite and once more after you pause (phrases that end while the model is busy go together, so a slow phone keeps up), and drops output that is clearly not what was said. It is not told which verse you are reciting (no prompt), so a wrong word is heard as wrong. The text then goes through the same `match.js` follow-along as the phone engines. Settings shows which model runs and how long its warm-up pass took.
    - **Android app:** the model runs natively with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (pinned release v1.9.5), through a small Capacitor plugin in `android/app/src/main/java/app/tilawa/quran/WhisperPlugin.java` and a JNI layer in `android/app/src/main/cpp/` (`tw.cpp` holds the decoding settings: Arabic, transcribe, greedy, no timestamps, no context, one segment, blank and non-speech tokens suppressed). Gradle builds it with CMake, which fetches whisper.cpp at that tag; it is always compiled optimised, for arm64-v8a and armeabi-v7a (and x86_64 in debug builds, for the emulator). On arm64, ggml is built once per CPU feature set (dot product, fp16, int8 matrix multiply, SVE…) and loads the best one for the phone. It uses up to 4 threads. The key speed-up: the encoder hears only the clip plus a 1 s margin instead of Whisper’s whole 30 s window, so a short phrase costs a fraction of a full pass. The model file (Tarteel’s model converted to ggml and quantized) downloads once from this repository’s [models-v1 release](https://github.com/bilalalkassas81-rgb/Tilawa-app/releases/tag/models-v1), is checked against its SHA-256, and is kept in the app’s storage. The workflow `models.yml` converts the models (whisper.cpp’s `convert-h5-to-ggml.py`, then `whisper-quantize`) and benchmarks the app’s exact decoding (`tests/native/`) on real recitation.
    - **Web app:** the model ([tarteel-ai/whisper-tiny-ar-quran](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran) on phones, [whisper-base-ar-quran](https://huggingface.co/tarteel-ai/whisper-base-ar-quran) on computers, as ONNX exports) runs in a Web Worker with [Transformers.js](https://github.com/huggingface/transformers.js) (WebGPU on computers where available, WebAssembly otherwise), loaded from jsDelivr on first use.
    - `tests/e2e/` runs the app with the real models and real recitation as the microphone, in Chromium and in an Android emulator (GitHub Actions, *Qur'an AI engine check*, started by hand).
  - `js/app.js`: screens, recitation sessions, audio player, goals and progress.
  - `data/`: Qur’an text and translations.
- `android/`: the native Android project ([Capacitor](https://capacitorjs.com)).
- `.github/workflows/`: on every push to `main`, GitHub builds the APK into Releases and publishes the web app to GitHub Pages, both for free.

Run it locally:

```bash
npx http-server www -p 8080
```

## Publishing to app stores later

You do not need a store to share Tilawa: the APK link and the web app link are enough. If you want store listings later:

- **Free:** [Samsung Galaxy Store](https://seller.samsungapps.com), [Huawei AppGallery](https://developer.huawei.com/consumer/en/appgallery) and [F-Droid](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/) accept Android apps without a fee.
- **Google Play:** $25 once. Build a signed release (`./gradlew bundleRelease` with your own keystore) and upload the `.aab` file.
- **Apple App Store:** $99 a year and a Mac with Xcode (`npx cap add ios`).

## Credits

- Mushaf text, pages and printed line layout (Madinah Mushaf, Hafs): [quran-text](https://github.com/quran-ws/quran-text) by quran.ws (CC BY 4.0), from the King Fahd Glorious Qur’an Printing Complex release. See `www/data/QURAN-TEXT-LICENSE.txt`.
- Qur’an font: KFGQPC HAFS Uthmanic Script v3 by the King Fahd Glorious Qur’an Printing Complex, shipped unmodified under its free licence (`www/fonts/KFGQPC-FONT-LICENSE.txt`).

- Qur’an text (Uthmani), translations and transliteration: [quran-json](https://github.com/risan/quran-json) (CC BY-SA 4.0), sourced from Tanzil.net and other open projects. See `www/data/QURAN-JSON-LICENSE.txt`.
- Recitation audio streams from [EveryAyah.com](https://everyayah.com).
- Qur’an AI voice engine: [whisper-base-ar-quran](https://huggingface.co/tarteel-ai/whisper-base-ar-quran) and [whisper-tiny-ar-quran](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran) by [Tarteel AI](https://tarteel.ai) (Apache-2.0), a fine-tune of OpenAI’s Whisper (MIT). In the Android app run with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and ggml by Georgi Gerganov and contributors (MIT); in the web app with [Transformers.js](https://github.com/huggingface/transformers.js) by Hugging Face (Apache-2.0) and ONNX Runtime Web (MIT).
- Fonts: Amiri Quran and Readex Pro (SIL Open Font License), via Fontsource.
