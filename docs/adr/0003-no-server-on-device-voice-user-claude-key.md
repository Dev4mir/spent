# No server: on-device transcription plus the user's own Claude API key

The app is static files only. Each Utterance is transcribed on the phone, in the browser, by a small Whisper-class model. The transcript is parsed by Claude with an API key the user pastes once. That key stays on the phone and is sent only to Anthropic, which accepts direct browser calls through `anthropic-dangerous-direct-browser-access`. Claude Max and Ultra plans include Platform API credits ($100 and $200 a month), so for those users their subscription really does pay; any other Claude API key works on pay-as-you-go. The requirement is "no server, runs on the user's subscription", and this is the only arrangement found that satisfies both legitimately.

## Considered Options

- **A small backend calling STT and an LLM on our key** (the original ADR 0001). Rejected: it is a server and we pay.
- **Claude Pro/Max login or extracted Codex tokens.** Forbidden by provider terms.
- **Sign in with ChatGPT.** Its redirect must be `127.0.0.1`, which a phone web app cannot receive, and plan usage excludes audio.
- **Custom GPT with Actions.** Personal accounts can no longer create GPTs.
- **A claude.ai artifact app.** Claude and connector calls are disabled for anyone outside the author's organization.
- **Gemini or OpenAI keys that hear audio directly.** Better speech recognition, but not the user's Claude subscription. Kept as a fallback only if on-device transcription fails the 30-clip test.

## Consequences

- Claude-only: Codex/ChatGPT users must bring a Claude key.
- Arabic accuracy is capped by a phone-sized model. Hex's measurements of read Modern Standard Arabic put whisper-turbo at about 15% word error rate, and small models do worse. The Brief and the Undo window are the safety net.
- The model is a one-time download, after which voice works offline.
- Audio never leaves the phone.
