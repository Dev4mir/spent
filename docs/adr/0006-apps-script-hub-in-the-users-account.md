---
status: accepted (2026-11-13)
---

# A Google Apps Script in the user's own account is the hub; no Claude key in it

Some things have to happen while Spent is closed: catching Bank Messages and building notification text. A static page can't do them. They run in an Apps Script bound to the user's own Ledger, deployed as a web app that runs as the user. It's free, it's in the user's account, and we neither host nor pay for it, so it fits "no server of ours" (ADR-0003). iOS Shortcuts call it.

The hub never holds the Claude key. It parses Bank Messages with fixed rules and the user's Rules. A Merchant with no Rule is saved with Category «؟». An unrecognised message is kept as raw text. The app sorts out both the next time it opens, with Claude and the key from its own settings.

## Considered Options

- **A Cloudflare Worker or similar free serverless function.** Rejected: it's a server we would run.
- **The Claude key in the script's properties, so the hub can call Claude.** Rejected: pasting a key into Apps Script is a step a normal user won't take.
- **ntfy or a Telegram bot for notifications.** Kept only as a fallback. Shortcuts' own "Show Notification" needs no extra app or account.

## Consequences

- The web app has to accept anonymous calls (Shortcuts can't sign in to Google), so every call carries a secret token stored in the script's properties.
- Apps Script answers a POST with a 302 redirect; the write happens before the redirect. The Shortcut reads the notification text from the response it's redirected to.
- Until roadmap phase 4 the user pastes and deploys the script by hand. After that, the app creates it through the Apps Script API.
