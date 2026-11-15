# Roadmap

The goal is complete records first, then behaviour change. Terms follow `GLOSSARY.md`.

1. **Capture.** The hub (ADR-0006) and the Bank Message Shortcut (ADR-0007). Fixed-rule parsing of CIB messages, starter Rules, Matching with spoken Expenses already in the Ledger, and one notification per Bank Message. Haiku 5.5 becomes the default model, with Sonnet 5.5 as the fallback. Works with the current app.
2. **Local-first app (ADR-0005), built 2026-11-13.** The phone holds the Entries and pulls the hub's Entries. Matches made on the phone, Cash and Unaccounted Cash, Corrections and Questions from the orb. When an Expense lands in a Category with no Budget, the orb asks for one: a number sets it, "ignore" makes the Category Excluded, closing the app means ask again next time. The orb also asks about any «؟» Merchant and saves the answer as a Rule.
3. **Nudges.** Web Push from the hub, so tapping a notification opens Spent itself: Shortcuts' Show Notification opens Shortcuts, and iOS has no link into a home-screen web app. Then the evening Check-in, a Budget or Pace crossing alert once per Category per month, and the month-end Unaccounted Cash Expense.
4. **Setup.** The app creates and deploys the hub through the Apps Script API. Shortcuts shared as iCloud links, with a 3-step guide for the automations. A "Hey Siri" dictation Shortcut, if Dictate Text offers Arabic.

Later, unscheduled: reading the hub's Inbox (refunds, other banks) with Claude in the app.

Open device checks: does Dictate Text offer Arabic (phase 4)? Does a timed automation show its notification on a locked phone? If not, phase 3 uses ntfy instead.
