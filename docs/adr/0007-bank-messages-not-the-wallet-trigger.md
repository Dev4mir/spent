---
status: accepted (2026-11-13)
---

# Card spending is captured from Bank Messages, not the Wallet trigger

An iOS Shortcuts automation on "Message contains EGP" forwards every Bank Message to the hub (ADR-0006). CIB sends an SMS for every debit-card, credit-card and Apple Pay charge, and for every Withdrawal. One trigger covers all card spending, and nothing gets captured twice.

## Considered Options

- **The Wallet "Transaction" automation.** Rejected. It only sees Apple Pay taps, it's reported to miss some cards and terminals, nobody has confirmed it works with Egyptian-issued cards, and running it next to the SMS trigger would capture each Apple Pay purchase twice.
- **Filtering by sender ("CIB").** Rejected. Whether alphanumeric sender IDs work is unverified, and "contains EGP" matches every message the bank sends.

## Consequences

- A credit-card charge counts as an Expense on the day it's charged. Paying the card bill is not an Expense and is ignored.
- A Withdrawal adds to Cash. It is never an Expense.
- A spoken Expense and its Bank Message become one Entry (a Match) when the amount is the same and the dates are within a day of each other. A spoken Expense with no Match is taken from Cash.
- Each new bank or message format needs a parser rule in the hub. Until it has one, the app parses the message with Claude.
