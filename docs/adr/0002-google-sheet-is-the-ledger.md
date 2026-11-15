---
status: superseded in part by ADR-0005 (the phone, not the Sheet, is the source of truth)
---

# The user's Google Sheet is the Ledger; the product keeps no database

Every Entry, Budget and monthly total lives in a spreadsheet in the user's own Drive. The app creates that spreadsheet with the `drive.file` scope, which Google classes as non-sensitive, so the app needs no security assessment. No server is involved; the phone writes to the sheet directly (see ADR-0003). Users can see and edit their data directly, the product holds no financial data to secure, and Budgets are edited in the sheet instead of in a settings screen.

## Consequences

- `drive.file` only reaches files the app created, so a user cannot point the app at a spreadsheet they already have.
- Per-user quotas (60 reads and 60 writes a minute) and the iOS sign-in renewal mean the app must hold Pending Expenses on the phone and write them later.
