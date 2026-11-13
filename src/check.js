import { config, hasLLM } from './config.js';
import { db, save } from './store.js';
import { chatJSON, currentModel } from './llm.js';
import { truncate, mapLimit } from './fetcher.js';
import { searchSites } from './evidence.js';
import { anyPinned } from './auth.js';

// Reality check: runs automatically on events after each refresh. It restates the story in
// plain words, says how solid it is, separates confirmed facts from unverified claims,
// and describes how each side is spinning it. Cheap by design: one model call per event,
// using the articles already gathered plus a quick fact-checker / government search.

export const VERDICTS = ['confirmed', 'developing', 'disputed', 'unverified', 'misleading'];
const ACTIVE_HOURS = 72;
const RECHECK_AFTER_NEW_ARTICLES = 3;

const SYSTEM = `You are a sceptical, even-handed news editor. You get several outlets' articles on one news event (each labelled with the outlet's political lean) and, sometimes, headlines from fact-checkers or government sites. Challenge the story: work out what is actually established, what is only claimed, and how it is being spun. Write for a busy reader in plain, simple words: short sentences, no jargon, no hedging filler.
Return JSON:
{"plain":"2-4 short sentences: what happened and why it matters, in everyday language",
"verdict":"confirmed|developing|disputed|unverified|misleading",
"why":"one sentence explaining the verdict (e.g. how many independent outlets, whether officials or documents back it)",
"confirmed":["up to 4 facts that several independent outlets or official sources agree on"],
"unverified":["up to 4 claims that rest on one source, anonymous sources, a single side, or are contested; say who is making each claim"],
"spin":[{"side":"Left|Right|Center|Officials|<other group>","framing":"one sentence: what this side emphasises, plays down or leaves out"}],
"missing":"one sentence: an important question or piece of context the coverage does not answer, or empty"}
Verdict guide: confirmed = core facts agreed by multiple independent outlets or official records. developing = real but key details still changing. disputed = the sides give conflicting accounts of the facts. unverified = rests on one outlet, one side or anonymous sources. misleading = the headline claim is contradicted by a fact-check, official record or the outlets' own reporting.
Rules: use only the material provided. Do not invent facts, numbers or quotes. Outlets repeating one original report count as one source. If only one lean is represented, say so in "spin" rather than guessing the other side's view. 2-4 spin entries.`;

export async function checkEvent(event) {
  if (!hasLLM()) throw new Error('Add an OpenRouter API key to use AI features.');
  const store = db();
  const articles = event.articleIds.map((id) => store.articles[id]).filter(Boolean);
  if (!articles.length) throw new Error('This event has no articles to check yet.');
  // Spread across outlets and leans, newest first.
  const picked = [];
  const seenSource = new Set();
  for (const pass of [true, false])
    for (const a of [...articles].sort((x, y) => String(y.publishedAt).localeCompare(String(x.publishedAt)))) {
      if (picked.includes(a) || picked.length >= 10) continue;
      if (pass && seenSource.has(a.source)) continue;
      seenSource.add(a.source);
      picked.push(a);
    }
  const refs = await searchSites(event.title, ['politifact.com', 'factcheck.org', 'snopes.com', 'fullfact.org', 'gov'], { max: 6 })
    .then((r) => r.filter((x) => x.kind !== 'news' && x.title !== x.name).slice(0, 5))
    .catch(() => []);

  const r = await chatJSON(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `EVENT: ${event.title}\n\nARTICLES:\n${picked
          .map((a, i) => `(${i + 1}) ${a.source} [lean: ${a.lean || 'unknown'}] — ${a.title}\n${truncate(a.text || a.summary || '', a.text ? 1100 : 400)}`)
          .join('\n\n')}${
          refs.length ? `\n\nFACT-CHECKER / GOVERNMENT HEADLINES (may or may not be about this exact story; ignore if unrelated):\n${refs.map((x) => `- ${x.name} (${x.meta || 'undated'}): ${x.title}`).join('\n')}` : ''
        }`,
      },
    ],
    { model: currentModel(), temperature: 0.1, maxTokens: 1100 }
  );
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, n);
  const verdict = VERDICTS.includes(String(r.verdict).toLowerCase()) ? String(r.verdict).toLowerCase() : 'developing';
  event.check = {
    verdict,
    plain: String(r.plain || '').trim(),
    why: String(r.why || '').trim(),
    confirmed: list(r.confirmed, 4),
    unverified: list(r.unverified, 4),
    spin: (Array.isArray(r.spin) ? r.spin : [])
      .map((s) => ({ side: String(s?.side || '').trim(), framing: String(s?.framing || '').trim() }))
      .filter((s) => s.side && s.framing)
      .slice(0, 4),
    missing: String(r.missing || '').trim(),
    refs: refs.map((x) => ({ title: x.title, url: x.url, name: x.name, kind: x.kind })),
    sources: seenSource.size,
    articleCount: articles.length,
    at: new Date().toISOString(),
  };
  save();
  return event.check;
}

// Pick the events most worth checking and check them. Called after each refresh.
export async function autoCheck(log = console.log) {
  if (!hasLLM() || !config.autoCheck) return;
  const store = db();
  const now = Date.now();
  const due = Object.values(store.events)
    .filter((e) => now - new Date(e.updatedAt).getTime() < ACTIVE_HOURS * 3600e3 || anyPinned(e) || e.manual)
    .filter((e) => {
      const n = e.articleIds.length;
      if (n < (e.manual ? 1 : 2) || e.building) return false;
      if (!e.check) return true;
      return n >= (e.check.articleCount || 0) + RECHECK_AFTER_NEW_ARTICLES;
    })
    .sort((a, b) => Number(Boolean(anyPinned(b) || b.manual)) - Number(Boolean(anyPinned(a) || a.manual)) || b.articleIds.length - a.articleIds.length)
    .slice(0, config.autoCheckMax);
  if (!due.length) return;
  let ok = 0;
  await mapLimit(due, 3, async (e) => {
    try {
      await checkEvent(e);
      ok++;
    } catch (err) {
      log(`[check] "${truncate(e.title, 50)}" failed: ${err.message}`);
    }
  });
  log(`[check] reality-checked ${ok}/${due.length} events`);
}
