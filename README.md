# Tilawa — تلاوة

A free Qur’an recitation companion. Recite out loud and Tilawa follows along word by word, marking wrong and skipped words as you go. Every feature is included, with no subscription, no ads and no account.

## Features

| | |
|---|---|
| **Recitation mistake detection** | Listens while you recite. Correct words turn green, wrong words red, skipped words amber. Works for any passage and has no daily limit. |
| **Memorization mode** | Hides the verses and reveals each word only after you recite it. Tap a hidden word, or press “Reveal word”, when you need a hint. |
| **Mistake history** | Each session keeps its mistakes. The Progress tab lists the words you miss most, with a “Practise these verses” button. |
| **Session summary** | Accuracy, mistakes, hints, time, and the exact words to review, with links back to each verse. |
| **Listen back to yourself** | Optionally records your voice during a session so you can replay it (web version). |
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

Voice recitation uses the phone’s built-in speech recognition: Google on Android and in Chrome, Apple in Safari. It needs an internet connection.

## How it is built

- `www/`: the whole app in plain HTML, CSS and JavaScript (no build step).
  - `js/match.js`: Arabic normalisation and word-by-word alignment of what was heard against the Uthmani text.
  - `js/speech.js`: native speech recognition in the Android app, the Web Speech API in browsers.
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

- Qur’an text (Uthmani), translations and transliteration: [quran-json](https://github.com/risan/quran-json) (CC BY-SA 4.0), sourced from Tanzil.net and other open projects. See `www/data/QURAN-JSON-LICENSE.txt`.
- Recitation audio streams from [EveryAyah.com](https://everyayah.com).
- Fonts: Amiri Quran and Readex Pro (SIL Open Font License), via Fontsource.
