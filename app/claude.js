// Utterance -> what the user meant, with the user's own Claude API key (ADR-0003). Claude cannot take audio; it gets text.
// One call decides the intent and fills its fields; the app does the rest on the phone (answers to Questions included).
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
import { OTHER } from './logic.js?v=5';

export const FAST = 'claude-haiku-5-5', CAREFUL = 'claude-sonnet-5-5'; // Haiku first; Sonnet when Haiku's answer can't be used

const HINTS = `Classify by what the money bought, not where or how it was paid; if two categories fit, the more specific wins; if none fits, use ${OTHER}.
Hints (use the user's own category names when theirs differ): مواصلات = ميكروباص/توك توك/أوبر/ديدي/مترو/تاكسي/أتوبيس (Uber to a restaurant is still مواصلات).
بقالة وطلبات البيت = سوبرماركت/بقالة/عيش/خضار/فاكهة/لحمة/فراخ/إزازة مياه/منظفات، and sweets/chocolate bought to take home. خروجات is only eating or drinking out; ready food from the Talabat app is خروجات.
فواتير واشتراكات = كهربا/مية/غاز/أنبوبة/كارت شحن/رصيد/نت/نتفليكس/Claude/ChatGPT. تعليم ودروس = مدرسة/درس/سنتر/كورس. خدمات البيت = خادمة/بواب/زبالة/سباك/كهربائي.
Car repair/maintenance/insurance/licence go to the car category. An installment (قسط) goes to the installment category it names; never assume the car if the car isn't said.
Doctor or medicine for a child is كشف ودواء. A credit card purchase goes to what it bought; only paying off the card goes to a credit-card category.`;

const INTENTS = `intent is one of:
- entry: they report money spent (expense), received (income: قبضت، مرتب، جالي، فريلانس، اتسلفت), put aside (saving: ادخار، حوّشت، وفّرت، شهادة) or taken out as cash from the bank or ATM (withdrawal: سحبت من الفيزا/المكنة/البنك). Fill kind, amount, currency, category (expenses only; '' otherwise) and days_ago.
- correction: they fix or remove the last entry ("لا كانت ٥٠ مش ٥٠٠"، "امسحها"، "دي كانت مواصلات"، "دي كانت امبارح"، "غلط"). Fill only what changes: amount (0 = unchanged), category ('' = unchanged), days_ago (-1 = unchanged), delete = true to remove it.
- question: they ask about their money ("صرفت كام على البنزين الشهر ده؟"، "فاضلي كام؟"، "معايا كام كاش؟"). about: spent, left (what remains of a budget, or of the month with no category), cash, income, saved, or month (how the month is going). period: today, yesterday, week, month (default) or last_month. category when they name one.
- cash_count: they state how much cash they hold right now ("معايا ٥٠٠ كاش"، "فاضل في جيبي ٢٠٠"). amount = that cash, 0 if they have none.
- answer: they reply to the app's own question (given below, if any). A number for a budget question goes in amount; "تجاهل/مش عايز/سيبه/لأ" sets ignore = true. For a "what was this purchase" question, set category, or ignore = true if they don't know.
Fields that don't apply: amount 0, category '', days_ago -1, delete false, ignore false, about '', period month, kind expense, currency EGP.`;

export function createUnderstanding({ getKey, getModel }) {
  // ctx: { categories, ask: the app's open question or null, last: the last Entry in words or null }
  return async function understand(text, alts, { categories, ask, last }) {
    const names = [...new Set([...categories.map(c => c.name), OTHER])];
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['intent', 'kind', 'amount', 'currency', 'category', 'days_ago', 'delete', 'ignore', 'about', 'period', 'understood'],
      properties: {
        intent: { type: 'string', enum: ['entry', 'correction', 'question', 'cash_count', 'answer'] },
        kind: { type: 'string', enum: ['expense', 'income', 'saving', 'withdrawal'] },
        amount: { type: 'number', description: '0 if no amount was said' },
        currency: { type: 'string', enum: ['EGP', 'USD'] },
        category: { type: 'string', enum: ['', ...names] },
        days_ago: { type: 'integer', description: '0 today, 1 for امبارح, 2 for أول امبارح; -1 when not said in a correction' },
        delete: { type: 'boolean' },
        ignore: { type: 'boolean' },
        about: { type: 'string', enum: ['', 'spent', 'left', 'cash', 'income', 'saved', 'month'] },
        period: { type: 'string', enum: ['today', 'yesterday', 'week', 'month', 'last_month'] },
        understood: { type: 'string', description: 'The utterance as you understood it, corrected Egyptian Arabic' },
      },
    };
    const system = `You read one short utterance by an Egyptian user of a voice money log and return what they meant.
The text comes from a speech recognizer: expect misheard words, odd spellings and words glued together (e.g. "متنجني" is "ميتين جنيه"); read it the way an Egyptian would have said it. When alternative hearings are given, use them to recover the amount and the item.
Turn spoken numbers (ميتين وخمسين = 250, ألف ونص = 1500, ٣ آلاف = 3000, "ثلاثة 200" = 3200) and Arabic-Indic digits into a plain number. Currency is EGP unless dollars are mentioned.
${INTENTS}
${HINTS}
Categories (name: type): ${categories.map(c => `${c.name}: ${c.type}`).join('، ')}.
The last entry: ${last || 'none yet'}.
The app's open question: ${ask ? `«${ask}». A reply that fits it is an answer; anything else is read on its own.` : 'none'}`;
    const others = alts.filter(a => a.trim() && a.trim() !== text);
    const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true, timeout: 20_000, maxRetries: 1 });
    const call = async model => {
      const res = await client.beta.messages.create({
        model, max_tokens: 16000, system,
        messages: [{ role: 'user', content: others.length ? `${text}\n\n(Other ways the recognizer heard it: ${others.join(' | ')})` : text }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        // Server-side refusal fallback where the model has one (Haiku has none; our own retry below covers it).
        ...(model === FAST ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      });
      if (res.stop_reason === 'refusal') throw new Error('Claude رفض الطلب');
      const block = res.content.find(b => b.type === 'text');
      if (!block) throw new Error('مفيش رد من Claude');
      return JSON.parse(block.text);
    };
    const usable = j => j && (j.intent !== 'entry' || j.amount > 0);
    const model = getModel();
    if (model !== FAST) return call(model);
    // Haiku is fast and cheap enough for a sentence. A failed parse, a refusal or an entry with no amount gets a second
    // try on Sonnet, which reads mangled recognizer text better. Auth, rate and network errors aren't retried.
    let first;
    try { first = await call(FAST); }
    catch (e) { if (e instanceof Anthropic.APIError && !(e instanceof Anthropic.InternalServerError)) throw e; }
    return usable(first) ? first : call(CAREFUL).catch(e => { if (first) return first; throw e; });
  };
}
export { Anthropic };
