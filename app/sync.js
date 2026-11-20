// Local-first (ADR-0005): the phone keeps every Entry; the Ledger mirrors it. Pure: no DOM, no network.
//
// The phone's state:  { entries: [Entry & { synced }], dirty: [id], gone: [id], ops: [Op] }
//   dirty  Entries changed on the phone that the Sheet doesn't have yet
//   gone   Entries removed on the phone whose row is still in the Sheet
//   ops    Budget and Rule changes for the Sheet, which owns them: { type: 'budget', category, amount | excluded } | { type: 'rule', merchant, category }
//   synced the Entry's row was in the Sheet at the last sync
//
// One sync = read the Sheet, reconcile (below), push the plan. Every step is idempotent: a push lost half-way is
// planned again from the next read, so nothing is written twice.
import { findVoiceMatch, matchInto } from './logic.js?v=261120170220';

const strip = ({ row, status, ...e }) => e;

// sheet: Entries read from the Ledger, each with its `row`. Returns the new phone state and what to write.
export function reconcile(local, sheet) {
  const dirty = new Set(local.dirty), gone = new Set(local.gone);
  const remote = new Map(sheet.filter(s => s.id).map(s => [s.id, s]));
  const known = new Set(local.entries.map(e => e.id));
  const next = new Map(), fresh = [];
  for (const e of local.entries) {
    const s = remote.get(e.id);
    if (dirty.has(e.id)) next.set(e.id, e); // a change still waiting on the phone wins
    else if (s) next.set(e.id, { ...strip(s), synced: true }); // the Sheet's version: the hub's Matches and Rules, the user's own edits
    else if (!e.synced) { next.set(e.id, e); dirty.add(e.id); }
    // else: its row was deleted in the Sheet, so it goes here too
  }
  for (const s of remote.values()) {
    if (known.has(s.id) || gone.has(s.id)) continue;
    next.set(s.id, { ...strip(s), synced: true }); fresh.push(s.id); // new from the hub, or the phone's storage was cleared
  }
  // A Bank Message that arrived after the user spoke (and after the spoken Entry reached the Sheet, or the hub
  // would have matched it): join them under the bank's ID and drop the spoken one.
  const renamed = {};
  for (const id of fresh) {
    const bank = next.get(id);
    if (bank.source !== 'bank') continue;
    const spoken = findVoiceMatch([...next.values()], bank);
    if (!spoken) continue;
    next.delete(spoken.id); dirty.delete(spoken.id);
    if (spoken.synced) gone.add(spoken.id);
    next.set(id, { ...matchInto(bank, spoken), synced: true }); dirty.add(id);
    renamed[spoken.id] = id;
  }
  const plan = { update: [], append: [], remove: [] };
  for (const id of dirty) {
    const e = next.get(id);
    if (!e) { dirty.delete(id); continue; }
    const s = remote.get(id);
    if (s) plan.update.push({ row: s.row, entry: e }); else plan.append.push(e);
  }
  for (const id of gone) {
    const s = remote.get(id);
    if (s) plan.remove.push({ row: s.row, id }); else gone.delete(id);
  }
  plan.remove.sort((a, b) => b.row - a.row); // bottom first, so earlier rows keep their numbers
  return { entries: [...next.values()], dirty: [...dirty], gone: [...gone], plan, renamed };
}

// After a push: mark what reached the Sheet, unless the user changed it again while the push was in flight.
// `local` is the phone's state now; `plan` is what was pushed; `opsSent` how many ops went with it.
export function settle(local, plan, opsSent) {
  const sent = new Set([...plan.update.map(u => u.entry), ...plan.append]); // same objects as in local.entries unless replaced since
  const done = new Set(local.entries.filter(e => sent.has(e)).map(e => e.id));
  const removed = new Set(plan.remove.map(r => r.id));
  return {
    ...local,
    entries: local.entries.map(e => (done.has(e.id) ? { ...e, synced: true } : e)),
    dirty: local.dirty.filter(id => !done.has(id)),
    gone: local.gone.filter(id => !removed.has(id)),
    ops: local.ops.slice(opsSent),
  };
}

// Budget and Rule changes the phone made, applied over what it last read from the Sheet, so they count at once.
export function applyOps(meta, ops) {
  const categories = meta.categories.map(c => ({ ...c }));
  const rules = [...(meta.rules || [])];
  for (const op of ops) {
    if (op.type === 'budget') {
      let c = categories.find(x => x.name === op.category);
      if (!c) categories.push(c = { name: op.category, type: 'variable', budget: 0, setAside: 0 });
      if (op.excluded) c.type = 'excluded'; else c.budget = op.amount;
    } else if (op.type === 'rule') rules.push([op.merchant, op.category]);
  }
  return { ...meta, categories, rules };
}
