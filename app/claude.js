// Utterance -> what the user meant, with the user's own Claude API key (ADR-0003). Claude cannot take audio; it gets text.
// One call decides the intent and fills its fields; the app does the rest on the phone (answers to Questions included).
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
import { OTHER } from './logic.js?v=261120170220';

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
- question: a plain total they ask about ("صرفت كام على البنزين الشهر ده؟"، "فاضلي كام؟"، "معايا كام كاش؟"). about: spent, left (what remains of a budget, or of the month with no category), cash, income, saved, or month (how the month is going). period: today, yesterday, week, month (default) or last_month. category when they name one.
- cash_count: they state how much cash they hold right now ("معايا ٥٠٠ كاش"، "فاضل في جيبي ٢٠٠"). amount = that cash, 0 if they have none.
- chat: anything else they ask or tell the app: advice about their money ("أعمل إيه عشان أوفّر؟"، "أقدر أشتري موبايل بـ ١٥ ألف؟"، "أعمل إيه بالفلوس الزيادة؟"), why or compare questions ("ليه الشهر ده أغلى؟"، "قارن بالشهر اللي فات"), how to use the app ("إزاي أحط ميزانية؟"), or a follow-up to the adviser's last answer (given below, if any). Leave every other field at its default.
- answer: they reply to the app's own question (given below, if any). A number for a budget question goes in amount; "تجاهل/مش عايز/سيبه/لأ" sets ignore = true. For a "what was this purchase" question, set category, or ignore = true if they don't know.
Fields that don't apply: amount 0, category '', days_ago -1, delete false, ignore false, about '', period month, kind expense, currency EGP.`;

export function createUnderstanding({ getKey, getModel, onCost = () => {} }) {
  // ctx: { categories, ask: the app's open question or null, last: the last Entry in words or null }
  return async function understand(text, alts, { categories, ask, last, adviser }) {
    const names = [...new Set([...categories.map(c => c.name), OTHER])];
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['intent', 'kind', 'amount', 'currency', 'category', 'days_ago', 'delete', 'ignore', 'about', 'period', 'understood'],
      properties: {
        intent: { type: 'string', enum: ['entry', 'correction', 'question', 'cash_count', 'chat', 'answer'] },
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
The app's open question: ${ask ? `«${ask}». A reply that fits it is an answer; anything else is read on its own.` : 'none'}
The adviser's last answer: ${adviser ? `«${adviser}». A reply that carries on from it is chat, unless it reports money spent or received.` : 'none'}`;
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
      onCost(costOf(res.model || model, res.usage));
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

// What a call cost, from its usage. $ per million tokens: [input, output, cache read]; a cache write (5 minutes) is 1.25× input.
const PRICE = { 'claude-haiku-5-5': [0.10, 0.50, 0.01], 'claude-sonnet-5-5': [2, 10, 0.10], 'claude-opus-5-5': [4, 20, 0.20] };
export function costOf(model, u) {
  const p = PRICE[model] || PRICE[CAREFUL];
  if (!u) return 0;
  return ((u.input_tokens || 0) * p[0] + (u.cache_creation_input_tokens || 0) * p[0] * 1.25
    + (u.cache_read_input_tokens || 0) * p[2] + (u.output_tokens || 0) * p[1]) / 1e6;
}

/* ---------- the money adviser: anything that isn't an Entry or a plain total ---------- */
export const ADVISER = 'claude-sonnet-5-5';

// What the adviser knows about the app, so it can answer "how do I…". Keep it true to the app: it is all the adviser knows.
const GUIDE = `You are the money adviser inside Spent, a voice expense app used in Egypt. The user taps one button and talks in Egyptian Arabic.
Answer in Egyptian Arabic, like a sharp friend who is good with money: two to four short sentences, plain text, no lists, no markdown, no emoji.
Use Western digits (1,500), and amounts in جنيه. Your answer is shown on screen and read aloud, so keep it short and speakable.
Base everything on the user's numbers below. Name the Category and the amount when you point at something. If the data can't answer it, say so in one sentence and say what to log so it can.
Be practical and direct: one or two concrete steps, not a lecture. On savings and investing you can explain general options available in Egypt (bank certificates, savings accounts, gold), but do not pick a specific product, bank or stock, and say a decision that large deserves a closer look.
You can't change anything yourself. When they want something done, tell them exactly what to say or where to do it, using the guide below.

How Spent works:
- Log by saying it: «بنزين بخمسمية», «قبضت المرتب ٢٠ ألف» (income), «حوّشت ٣ آلاف» (saving), «سحبت ٢٠٠٠ من المكنة» (cash withdrawal, not spending). «امبارح» or «أول امبارح» dates it back.
- Fix the last thing: «لا كانت ٥٠», «دي كانت مواصلات», «دي كانت امبارح», «امسحها». Right after logging, swiping the result sideways or tapping تراجع undoes it within 5 seconds.
- Cash: say «معايا ٥٠٠ كاش» to count it; cash that went missing is logged as unaccounted spending.
- The big number on the home screen is Today: what they can still spend today and keep their monthly Budgets for everyday Categories (متغير) on an even pace. Red means today's share is used up, and it shows tomorrow's. Tapping the number hides it.
- Swiping up (or the small bar under the button) opens the month: each Category with a bar, a tick where even spending would be today, and how many days ahead (قدامك) or behind (ورا) it is.
- Quick totals answer straight away: «صرفت كام النهارده؟», «فاضلي كام؟», «معايا كام كاش؟».
- Budgets and the savings goal live in the user's Google Sheet: the Budgets tab (البند, النوع: ثابت/متغير/دوري/مستثنى, الميزانية الشهرية, رصيد التحويش for دوري) and Settings B1 (هدف الادخار). When a Category with no Budget gets spending, the app asks for one: answering with a number sets it, «تجاهل» leaves it out of budgets.
- Card purchases can arrive from bank SMS if the user set up the hub; an unknown shop shows as «؟» and the app asks what it was.
- The gear in the corner holds the Claude key, the model, and the Google connection.`;

export function createAdviser({ getKey, onCost = () => {} }) {
  // history: the earlier turns of this conversation, exactly as the API returned them; money: the user's numbers for it.
  return async function advise(history, question, money) {
    const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true, timeout: 45_000, maxRetries: 1 });
    const messages = [...history, { role: 'user', content: question }];
    const res = await client.beta.messages.create({
      model: ADVISER, max_tokens: 16000,
      // The guide never changes and the numbers stay fixed for a conversation, so follow-ups read them from the cache.
      system: [{ type: 'text', text: GUIDE }, { type: 'text', text: money, cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      messages,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', // a declined request is retried on another model
    });
    onCost(costOf(res.model || ADVISER, res.usage));
    if (res.stop_reason === 'refusal') throw new Error('Claude رفض السؤال ده');
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) throw new Error('مفيش رد من Claude');
    // The reply goes back whole, thinking blocks included, so a follow-up continues the same conversation.
    return { text, history: [...messages, { role: 'assistant', content: res.content }] };
  };
}
export { Anthropic };
