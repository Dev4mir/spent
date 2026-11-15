// node hub/hub.test.mjs — runs the pure part of Code.gs against CIB's message formats (the details are made up).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('./Code.gs', import.meta.url), 'utf8'), ctx);
const { parseBankMessage, categoryFor, handleBankMessage, recategorize, STARTER_RULES } = ctx;
const plain = x => JSON.parse(JSON.stringify(x)); // objects from the vm context have another Object prototype

const SMS = {
  withdrawalBranch: 'تم سحب مبلغ  EGP 4000.00  من بطاقة الخصم المباشر المنتهية بـ ** من CIB MAIN BR 01 في 20/03/26 10:00 ، الرصيد المتاح EGP 100.00',
  applePayDebit: 'تم خصم EGP 700.00  من بطاقة الخصم المباشر # ** باستخدام Apple Pay عند  MOBIL في  19/03/26 10:05الرصيد المتاح  EGP1000.00.',
  creditCard: 'Your credit card #0000 was charged for EGP 149.99 at APPLE.COM BILL on 14/03/26  at 12:00. Available limit is  123 and the available international limit to use is EGP 1',
  withdrawalShop: 'تم سحب مبلغ  EGP 2500.00  من بطاقة الخصم المباشر المنتهية بـ ** من city market في 12/03/26 18:00 ، الرصيد المتاح EGP 100.00',
  applePayCredit: 'Your credit card ending with# using Apple Pay was charged for EGP 450.00 at ACME STORE on 12/03/26  at 11:00. Card available limit is EGP  5000.00. For more details, please visit https://cib.eg/mb',
};

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✓', name); };

test('parses the five CIB formats', () => {
  assert.deepEqual(plain(parseBankMessage(SMS.withdrawalBranch)), { kind: 'withdrawal', amount: 4000, currency: 'EGP', merchant: 'CIB MAIN BR 01', date: '2026-03-20' });
  assert.deepEqual(plain(parseBankMessage(SMS.applePayDebit)), { kind: 'expense', amount: 700, currency: 'EGP', merchant: 'MOBIL', date: '2026-03-19' });
  assert.deepEqual(plain(parseBankMessage(SMS.creditCard)), { kind: 'expense', amount: 149.99, currency: 'EGP', merchant: 'APPLE.COM BILL', date: '2026-03-14' });
  assert.deepEqual(plain(parseBankMessage(SMS.withdrawalShop)), { kind: 'withdrawal', amount: 2500, currency: 'EGP', merchant: 'city market', date: '2026-03-12' });
  assert.deepEqual(plain(parseBankMessage(SMS.applePayCredit)), { kind: 'expense', amount: 450, currency: 'EGP', merchant: 'ACME STORE', date: '2026-03-12' });
});

test('an amount under one («USD .05») is read as the charge, not the card limit later in the message', () => {
  const p = parseBankMessage('Your credit card #0000 was charged for USD .05 at EXAMPLE SHOP on 24/03/26 at 21:00. Available limit is 1234.56 and the available international limit to use is EGP 99999');
  assert.deepEqual(plain(p), { kind: 'expense', amount: 0.05, currency: 'USD', merchant: 'EXAMPLE SHOP', date: '2026-03-24' });
});

test('card bill payments are ignored; refunds and unknown texts go to the app', () => {
  assert.equal(parseBankMessage('تم سداد EGP 5000.00 لبطاقتك الائتمانية في 15/03/26').kind, 'ignore');
  assert.equal(parseBankMessage('A refund of EGP 200.00 was credited to your card on 15/03/26'), null);
  assert.equal(parseBankMessage('Your OTP is 123456'), null);
});

test('Rules: the longest matching text wins, case-insensitive', () => {
  assert.equal(categoryFor('APPLE.COM BILL', STARTER_RULES), 'فواتير واشتراكات');
  assert.equal(categoryFor('mobil', STARTER_RULES), 'بنزين');
  assert.equal(categoryFor('ACME STORE', STARTER_RULES), null);
  assert.equal(categoryFor('UBER EATS', [['UBER', 'مواصلات'], ['UBER EATS', 'خروجات']]), 'خروجات');
});

function fakeLedger(entries = [], extra = {}) {
  const l = { entries, rules: STARTER_RULES, budgets: [['بنزين', 'متغير', 2000]], usdRate: 50, appended: [], updated: [], inbox: [], ...extra };
  l.append = r => { l.appended.push(r); l.entries.push(r); };
  l.update = (i, r) => { l.updated.push([i, r]); l.entries[i] = r; };
  l.toInbox = t => l.inbox.push(t);
  return l;
}

test('a card Expense with a Rule is saved and the notification says where the Category stands', () => {
  const l = fakeLedger([['2026-03-13', 'صرفة', 500, 'EGP', 500, 'بنزين', 'بنزين 500', 'x1', 'صوت', '']]);
  const note = handleBankMessage(SMS.applePayDebit, l);
  assert.equal(l.appended.length, 1);
  const r = l.appended[0];
  assert.deepEqual([r[0], r[1], r[4], r[5], r[8], r[9]], ['2026-03-19', 'صرفة', 700, 'بنزين', 'رسالة', 'MOBIL']);
  assert.equal(note, '٧٠٠ ج · MOBIL → بنزين\nبنزين: فاضل ٨٠٠ من ٢٬٠٠٠');
});

test('an unknown Merchant is saved as «؟» and the notification asks for the Category', () => {
  const l = fakeLedger();
  const note = handleBankMessage(SMS.applePayCredit, l);
  assert.equal(l.appended[0][5], '؟');
  assert.match(note, /ACME STORE → بند؟/);
});

test('a Withdrawal is not an Expense', () => {
  const l = fakeLedger();
  assert.equal(handleBankMessage(SMS.withdrawalBranch, l), 'سحبت ٤٬٠٠٠ ج كاش · CIB MAIN BR 01');
  assert.equal(l.appended[0][1], 'سحب');
  assert.equal(l.appended[0][5], '');
});

test('Match: a spoken Expense of the same amount a day earlier becomes one Entry, not two', () => {
  const spoken = ['2026-03-18', 'صرفة', 700, 'EGP', 700, 'بنزين', 'بنزين بـ ٧٠٠', 'v1', 'صوت', ''];
  const l = fakeLedger([spoken]);
  const note = handleBankMessage(SMS.applePayDebit, l);
  assert.equal(l.appended.length, 0);
  assert.equal(l.updated.length, 1);
  assert.deepEqual(l.entries[0].slice(5), ['بنزين', 'بنزين بـ ٧٠٠', 'v1', 'صوت + رسالة', 'MOBIL']);
  assert.equal(note, '٧٠٠ ج · MOBIL اتطابقت مع «بنزين»');
});

test('Match ignores rows written before the source column existed (empty source = spoken)', () => {
  const l = fakeLedger([['2026-03-19', 'صرفة', 700, 'EGP', 700, 'بنزين', 'بنزين', 'v0']]);
  handleBankMessage(SMS.applePayDebit, l);
  assert.equal(l.updated.length, 1);
});

test('no Match two days apart, or against another Bank Message, or an already matched Expense', () => {
  for (const row of [
    ['2026-03-17', 'صرفة', 700, 'EGP', 700, 'بنزين', '', 'v1', 'صوت', ''],
    ['2026-03-19', 'صرفة', 700, 'EGP', 700, 'بنزين', '', 'b1', 'رسالة', 'MOBIL'],
    ['2026-03-19', 'صرفة', 700, 'EGP', 700, 'بنزين', '', 'v2', 'صوت + رسالة', 'MOBIL'],
  ]) {
    const l = fakeLedger([row]);
    handleBankMessage(SMS.applePayDebit, l);
    assert.equal(l.appended.length, 1, `should append beside ${row[7]}`);
  }
});

test('the same SMS twice is saved once and the second time shows nothing', () => {
  const l = fakeLedger();
  handleBankMessage(SMS.creditCard, l);
  assert.equal(handleBankMessage(SMS.creditCard, l), '');
  assert.equal(l.appended.length, 1);
});

test('an unreadable message goes to the Inbox', () => {
  const l = fakeLedger();
  assert.match(handleBankMessage('رسالة غريبة EGP بدون تاريخ', l), /Inbox/);
  assert.equal(l.inbox.length, 1);
});

test('a new Rule files the «؟» Expenses it covers', () => {
  const rows = [['2026-03-12', 'صرفة', 450, 'EGP', 450, '؟', '', 'b1', 'رسالة', 'ACME STORE'], ['2026-03-12', 'سحب', 2500, 'EGP', 2500, '', '', 'b2', 'رسالة', 'ACME STORE']];
  assert.deepEqual(plain(recategorize(rows, [['ACME STORE', 'ملابس']])), [0]);
  assert.equal(rows[0][5], 'ملابس');
  assert.equal(rows[1][5], '');
});

test('a spoken Withdrawal and its SMS become one Entry', () => {
  const l = fakeLedger([['2026-03-20', 'سحب', 4000, 'EGP', 4000, '', 'سحبت ٤ آلاف', 'v1', 'صوت', '']]);
  assert.match(handleBankMessage(SMS.withdrawalBranch, l), /اتطابقت/);
  assert.equal(l.appended.length, 0);
  assert.deepEqual(l.entries[0].slice(8), ['صوت + رسالة', 'CIB MAIN BR 01']);
});

console.log(`\n${n} passed`);
