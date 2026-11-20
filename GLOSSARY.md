# Spent

Voice-first personal expense logging: a user speaks an everyday purchase, it lands in their own spreadsheet, and they hear back where they stand against their budget.

## Language

**Entry**:
One line in the Ledger: an Expense, an Income, a Saving or a Withdrawal.
_Avoid_: Transaction, record, row

**Expense**:
One everyday purchase the user made, with an amount, currency, Category and date.
_Avoid_: Spending, purchase, outflow

**Income**:
Money the user received (salary, freelance work, a returned loan); it counts toward the month's standing.
_Avoid_: Earnings, inflow, deposit

**Saving**:
Money the user moved aside on purpose (to the bank, a certificate, a savings pot); it is not an Expense and counts toward the Savings Goal.
_Avoid_: Deposit, transfer, investment

**Withdrawal**:
Cash the user took out of the bank, at an ATM or a branch. It is not an Expense and counts against no Budget; it adds to Cash.
_Avoid_: Cash expense, ATM expense

**Cash**:
The money the user holds in hand: Withdrawals add to it, and every Expense with no matching Bank Message is taken from it.
_Avoid_: Wallet balance, petty cash

**Unaccounted Cash**:
The part of this month's Cash that no logged Expense explains. At month end it becomes one Expense in the user's personal-spending Category (مصاريفي الشخصية).
_Avoid_: Missing money, leakage, gap

**Cash Count**:
The user saying how much Cash they actually hold. Less than expected: the gap is Unaccounted Cash, saved at once. More: the extra is added to Cash.
_Avoid_: Reconciliation, balance check

**Savings Goal**:
The amount the user aims to have left at the end of each month after all Expenses.
_Avoid_: Target, saving target

**Utterance**:
One push-to-talk recording, in Arabic, English or a mix of the two. It describes one Entry, makes a Correction, or asks a Question.
_Avoid_: Voice note, command, message

**Correction**:
An Utterance that changes or removes the last Entry instead of adding a new one ("لا، كانت 50 مش 500").
_Avoid_: Edit, amendment, fix

**Question**:
An Utterance that asks about the user's money ("صرفت كام على الأكل الشهر ده؟"). It is answered and nothing is saved.
_Avoid_: Query, report request

**Bank Message**:
An SMS from the user's bank reporting a card charge or a Withdrawal. It is captured without the user speaking.
_Avoid_: Bank SMS, notification, alert

**Merchant**:
The shop name a Bank Message reports (MOBIL, ACME STORE).
_Avoid_: Vendor, store, payee

**Match**:
A spoken Expense and a Bank Message for the same purchase, joined into one Entry. The Bank Message supplies the Merchant; the Utterance supplies the Category and the words.
_Avoid_: Merge, duplicate, reconciliation

**Rule**:
A Merchant name and the Category its Expenses go to, learned from the user's answers to an Ask and from Corrections.
_Avoid_: Mapping, alias, auto-category

**Ledger**:
The user's own spreadsheet: it mirrors every Entry the phone holds, and it is where Budgets, Rules and the Savings Goal live.
_Avoid_: Database, sheet, log

**Category**:
The kind of thing an Expense was for (food, transport, …); every Expense has exactly one.
_Avoid_: Type, tag, label

**Category Type**:
How a Category behaves against its Budget: **Fixed** (one expected payment a month), **Variable** (spent bit by bit through the month), **Periodic** (set aside monthly for an occasional cost) or **Excluded** (recorded but outside Budgets).
_Avoid_: Kind, class, group

**Budget**:
The amount the user plans to spend on one Category in one calendar month.
_Avoid_: Limit, cap, allowance, expected (المتوقع)

**Set-aside**:
The running balance a Periodic Category has built up from its monthly Budget, less what was spent from it.
_Avoid_: Sinking fund, reserve, savings pot

**Pace**:
The month-end total a Variable Category is heading for if the user keeps spending at this month's rate so far. It only counts from the 10th of the month; before then the Budget alone is the yardstick.
_Avoid_: Forecast, prediction, trend

**Today**:
The number on the home screen: what can still be spent today and keep the Variable Budgets on an even spread to the month's end. It is what those Budgets had left this morning, split evenly over the days left (today included), less today's spending in Variable Categories. Past zero it turns red and shows tomorrow's figure. With no Variable Budget it shows what was spent today.
_Avoid_: Allowance, safe to spend, daily budget, balance

**Month View**:
The list behind a swipe up: one row per Category with a Budget, a Set-aside or spending this month, each with its bar and a tick where even spending would be today; Variable Categories say how many days ahead or behind they are.
_Avoid_: Dashboard, report, summary

**Check-in**:
The evening notification: what was spent today, whether the month is on track, and a reminder about Cash spent but not yet logged.
_Avoid_: Daily report, digest, reminder

**Brief**:
The short reply after an Entry is saved: what was saved, where its Category stands against its Budget, and whether the month is still on track for the Savings Goal.
_Avoid_: Report, summary, result, confirmation

**Pending Change**:
An Entry, Correction, Budget or Rule the phone has saved that has not reached the Ledger yet.
_Avoid_: Pending Expense, draft, offline entry, queued item

**Ask**:
A question the orb puts to the user when it lacks something: the Category for a Merchant with no Rule, or the Budget for a Category that has none. Saying something else passes it over until the app is next opened.
_Avoid_: Prompt, nudge, notification

**Undo window**:
The few seconds after an Expense is saved during which the user can retract it.
_Avoid_: Confirmation, review step
