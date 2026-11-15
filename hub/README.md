# Spent hub

An Apps Script that lives inside your own Ledger (ADR-0006). An iOS Shortcut sends each bank SMS to it. The hub saves the SMS as an Entry and answers with the notification text (ADR-0007). It never sees your Claude key.

| File | Role |
|---|---|
| `Code.gs` | The whole hub. The top half is pure logic (parsing, Rules, Match, notification text); the bottom half reads and writes the Sheet |
| `hub.test.mjs` | `node hub/hub.test.mjs`: runs the pure half against CIB message formats |

## What it does with one SMS

| SMS | Result | Notification |
|---|---|---|
| Card or Apple Pay charge, Merchant has a Rule | Expense under that Category | `٧٠٠ ج · MOBIL → بنزين` + where the Category stands |
| Same, Merchant has no Rule | Expense under «؟» | `… → بند؟ افتح Spent وقول كانت إيه`: the app asks you and saves your answer as a Rule |
| Charge for a purchase you already said (same amount, at most a day apart) | Your spoken Entry gets the Merchant: a **Match**, no second Entry | `… اتطابقت مع «بنزين»` |
| ATM or branch withdrawal | Withdrawal (not an Expense); joins one you already said, like a Match | `سحبت ٤٬٠٠٠ ج كاش` |
| Credit card bill payment | Ignored (the charges already counted) | none |
| Anything it can't read (refunds, new formats) | Kept in the **Inbox** tab | `…اتحفظت في تاب Inbox` |
| The same SMS twice | Ignored | none |

When you add a line to the **Rules** tab, every «؟» Expense from that Merchant gets the Category straight away. Answering the app's question does the same.

## Install (about 5 minutes, once)

1. Open Spent once and connect Google, so the Ledger exists. Then open the Ledger in Google Sheets on a computer.
2. **Extensions → Apps Script.** Delete what's there, paste all of `Code.gs`, then press Save.
3. Choose `setup` in the function menu and press **Run**. Google asks for permission, and says *"Google hasn't verified this app"*. That's expected for your own script: **Advanced → Go to … (unsafe) → Allow**. The run adds the `Rules` and `Inbox` tabs and logs a **token**.
4. **Deploy → New deployment → ⚙ Web app.** Set *Execute as*: **Me**, and *Who has access*: **Anyone**. Press **Deploy** and copy the web app URL.
5. Your hub address is the URL plus `?token=` and the token: `https://script.google.com/macros/s/…/exec?token=…`. The **token** is a random password `setup` made, so nobody else who finds the URL can write to your Sheet. It's in the Execution log (`Token: …`), and also under **⚙ Project Settings → Script Properties → token**. Easiest: run `setup` once more now that it's deployed, and the log prints the whole address ready to copy. Open it in Safari. It should say **Spent ✓**. Keep it private; if it leaks, delete the `token` property, run `setup` again and update the Shortcut.

After you change `Code.gs`, use **Deploy → Manage deployments → ✎ → Version: New version** so the URL stays the same.

## The iPhone automation

In **Shortcuts → Automation → + → Message**:

1. **Message Contains:** `EGP`. Leave *Sender* empty.
2. Choose **Run Immediately** and turn **Notify When Run** off. Tap Next, then **New Blank Automation**.
3. Add **Get Contents of URL**:
   - URL: your hub address with the token
   - Method: **POST**
   - Request Body: **JSON**. Add a field with key `text`, type *Text*. For its value **don't type anything**: tap the value box, then tap **Shortcut Input** in the variable bar above the keyboard (or long-press → *Select Variable*). It must show as a **blue token**. If it shows as plain words, the hub gets the words "Shortcut Input" instead of the SMS. Tap the blue token and pick **Content** if it's offered.
4. Add **If**: *Contents of URL* **has any value**. Inside it, add **Show Notification** with *Contents of URL*. Leave the If empty otherwise.

To test: send yourself an iMessage with one of your bank SMS pasted in. You should get the notification, and a new row should appear in Entries.

## Known limits

- Only CIB's formats are covered so far. A message from another bank goes to the Inbox until a parser rule is added in `parseBankMessage`.
- A Match needs the spoken Expense to be in the Sheet already. When the SMS comes first, or arrives before the phone has synced, the app makes the Match itself.
- Refunds go to the Inbox. Reading them in the app with Claude isn't built yet (`docs/roadmap.md`).
