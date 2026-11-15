---
status: accepted (2026-11-13), built in roadmap phase 2 and amended the same day
---

# Local-first: the phone holds the truth, the Sheet is its mirror

The phone keeps every Entry in its own storage. Each Brief is computed there, instantly and offline. The Ledger stays in the user's Drive as a mirror they can read. Each kind of fact has exactly one owner:

| Fact | Owner | Direction |
|---|---|---|
| Entries | the phone, plus the hub for Bank Messages | written to the Sheet; an edit made in the Sheet is taken unless the phone has a pending change to that Entry |
| Budgets, Category Types, Savings Goal, Rules | the Sheet | read by the phone; an answer to an Ask writes a Budget or Rule straight to it |

Corrections are made by voice, not by editing rows. This replaces "the Sheet is the source of truth" from ADR-0002. The product still keeps no database of its own, and `drive.file` stays the only Google scope the phone uses.

## Considered Options

- **Sheet as source of truth (ADR-0002).** Rejected. It forced the Pending Expense queue, the per-minute write quotas, and Briefs that depend on iOS sign-in renewal.
- **Two-way sync of Entries.** Rejected. Conflict handling for an app with one person and one orb isn't worth it; voice Corrections cover every edit.

## Consequences

- Amended while building it: the first version ignored edits made in the Sheet. Taking them costs nothing once each sync reads the whole Entries tab: the phone's pending change wins, otherwise the Sheet's row does. That is also how the hub's Matches and Rule fills reach the phone, and deleting a row in the Sheet deletes the Entry.
- Each sync reads the Sheet, then writes rewrites, appends and deletes (bottom row first) planned from that read. A write lost halfway is planned again from the next read, so nothing is written twice.
- Losing the phone's storage (clearing Safari data) means rebuilding it from the Sheet, so the mirror must keep enough columns to do that.
