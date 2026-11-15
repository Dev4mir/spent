---
status: accepted (supersedes the on-device transcription part of ADR-0003)
---

# iPhone voice: Safari's own speech recognition, from a home-screen icon that opens in Safari

Speech is turned into text by the browser's built-in `SpeechRecognition` (Apple's recognizer on iPhone, Google's in Chrome, `lang: "ar-EG"`). Claude then parses the transcript with the user's own key; Claude's API cannot take audio. On iPhone, the home-screen icon is added with "Open as Web App" **off**, so it opens in Safari: `SpeechRecognition` is unavailable in standalone home-screen apps (WebKit 225298, still unfixed in iOS 26). Audio going to Apple or Google is accepted in exchange for no server, no second key, and accuracy.

The app holds its own `getUserMedia` mic stream open next to the recognizer. Without it, iOS gives the recognizer silence on every session after the first (start and audiostart fire, then no speech events) until the app is force-closed; with it, every session in a row was heard correctly in testing. The stream is released when the page is hidden, closed or blurred, and after 30 s idle.

**Update:** in later testing, a real standalone home-screen app ("Open as Web App" on, `standalone: true`) also ran `SpeechRecognition` correctly with the getUserMedia workaround. Prefer the standalone app; keep the Safari-icon route as a fallback for iOS versions where standalone refuses.

## Considered Options (all tested on Egyptian Arabic sentences)

- **On-device Whisper (whisper-small, WebGPU):** far too inaccurate, and many seconds per sentence. Rejected.
- **Gemini Flash-Lite with the user's Gemini key:** about half right, and it invented sentences. Rejected; it would also need a second key.
- **Google recognition in desktop Chrome:** accurate. Same API as the chosen option.
- **iPhone keyboard dictation (🎤 on the keyboard):** works in a standalone app, but takes 2–3 taps. Kept as a fallback.

## Consequences

- On iPhone the app runs in a Safari tab with the address bar showing, not full screen.
- The orange mic dot shows while the app is open and in use.
- Audio is processed by Apple or Google, which reverses ADR-0003's "audio never leaves the phone".
- iOS Safari caches scripts hard: version every script URL.
