# Spent app

Tap the orb and talk in Egyptian Arabic: an Expense, a Correction («لا كانت ٥٠»، «امسحها»), a Question («صرفت كام على البنزين؟») or a Cash Count («معايا ٥٠٠ كاش»). The phone keeps every Entry and mirrors it to your own Google Sheet (ADR-0005). Static files only: no server, no build step (ADR-0002, 0003, 0004).

| File | Role |
|---|---|
| `index.html` | The Halo screen and the setup sheet |
| `app.js` | The flow: tap → speech → Claude → an Entry, Correction, Question, Cash Count or answer to an Ask → the screen; the phone's store, Undo, sync |
| `speech.js` | Browser speech recognition with the iOS open-mic workaround |
| `claude.js` | Utterance → intent and fields with the user's Claude key: Haiku 5.5 first, Sonnet 5.5 when Haiku's answer can't be used |
| `sheets.js` | Google sign-in (`drive.file` only) and the Ledger: create, read everything, push a sync plan |
| `layout.js` | How the Ledger looks: the Dashboard tab, formulas, formats, dropdowns and charts; pure, tested by `layout.test.mjs` |
| `sync.js` | Local-first sync: reconcile the phone with the Sheet, Matches for late SMS, what to write; pure, tested by `sync.test.mjs` |
| `logic.js` | Budgets, Pace, the Savings Goal, the Brief, Cash, Corrections, Questions and Asks; pure, tested by `logic.test.mjs` and `sync.test.mjs` |
| `config.js` | The Google OAuth client ID |
| `../hub/` | The Apps Script that saves bank SMS into the Ledger (ADR-0006, 0007); see `hub/README.md` |

## Run

From the repository root:

```
python -m http.server 8765 --bind 127.0.0.1
```

Open http://localhost:8765/app/. Use `localhost`, not 127.0.0.1: Google sign-in only accepts the exact origin registered on the OAuth client.

Check the logic with `node app/logic.test.mjs`, `node app/sync.test.mjs` and `node app/layout.test.mjs`.

## Releasing

Bump `?v=` on every import in `app.js`, `sheets.js`, `sync.js`, `claude.js` and `layout.js`, and on `app.js` in `index.html`. iOS Safari caches modules hard; a stale `logic.js` froze an early build once.

## Ledger layout (created on first Google connect)

The data tabs are seeded by `sheets.js`; everything a person reads (the Dashboard, formulas, formats, dropdowns, charts) comes from `layout.js`. To change the look, edit `layout.js` and bump `LAYOUT`: each phone re-applies it to its Ledger on the next sync. Re-applying wipes and redraws the Dashboard and the conditional formats on Entries and Budgets; it never writes Entries!A:J, Budgets!A:D or Settings!A:B.

- **Dashboard** (first tab, all formulas): a month picker (default «الشهر ده»); five numbers (الدخل، المصروف، التحويش، الفاضل against the Savings Goal، كاش معاك); a warning when Expenses wait under «؟»; every Category with a Budget or an Expense that month, biggest first, with what's left and a bar (red over, amber for a Variable Category past 80%); the last 10 Entries; a doughnut by Category and income against spending per month. The numbers are what was actually spent, not the Pace the Brief projects.

- **Entries:** filter buttons on the header, the ID column hidden, dropdowns for النوع and البند, Income, Saving and Withdrawal rows tinted, «؟» highlighted. Columns: التاريخ | النوع (صرفة/دخل/تحويش/سحب) | المبلغ | العملة | بالجنيه | البند | اللي اتقال | ID | المصدر (صوت/رسالة/صوت + رسالة) | التاجر. Rows without المصدر are spoken. A Match keeps the bank's row and ID. The phone owns this tab: it rewrites rows from its own copy, takes your edits unless it has a pending change to that row, and a row you delete is deleted on the phone too.
- **Budgets:** البند | النوع (ثابت/متغير/دوري/مستثنى) | الميزانية الشهرية | رصيد التحويش | اتصرف الشهر ده | الفاضل | النسبة (the last three are formulas, on grey). The user edits this tab; answering the orb's Budget Ask sets الميزانية الشهرية, and «تجاهل» sets النوع to مستثنى.
- **Months:** income, spending, savings and the difference per month (formulas).
- **Rules** (added by the hub, or by the app on its first Rule): التاجر فيه | البند. The user edits this tab; answering the orb's «؟» Ask adds a line.
- **Inbox** (added by the hub): bank SMS the hub couldn't read, waiting for the app.
- **Settings:** هدف الادخار (B1), العملة (B2), سعر الدولار (B3, `GOOGLEFINANCE`).
