import { chatJSON } from './llm.js';
import { hasLLM } from './config.js';
import { truncate } from './fetcher.js';

// Groups articles into events.
//
// With an OpenRouter key the model does the grouping (much better at spotting that
// "Fed holds rates" and "Powell signals patience" are the same story). Without one we fall back to a
// keyword-overlap heuristic so the app still works offline / for free.

export const CATEGORIES = ['World', 'US', 'Politics', 'Business', 'Tech', 'Science', 'Health', 'Climate', 'Sports', 'Entertainment', 'Other'];

const SYSTEM = `You are a careful news editor. You group news articles that report on the SAME specific real-world event or developing story (not merely the same broad topic) into "events".
Rules:
- Only group articles about the same concrete story (e.g. "Earthquake hits southern Turkey", not "natural disasters").
- You may add new articles to an EXISTING event when they cover that same story; refer to it by its existing_id.
- A NEW event needs at least 2 articles, ideally from different outlets.
- Leave out articles that don't belong with any other article or existing event. Do not force matches.
- Each article index may appear in at most one event.
- Titles: short, neutral, factual headline (max ~12 words), no outlet names, no sensational wording.
- Summaries: 2-3 neutral sentences stating what happened, based only on the provided headlines/snippets. Do not editorialize or speculate.
- For an existing event, keep its title unless the new articles materially change the story.
Respond with JSON only, in exactly this shape:
{"events":[{"existing_id":"<id or null>","title":"...","summary":"...","category":"<one of: ${CATEGORIES.join(', ')}>","articles":[<article indexes>]}]}`;

export async function clusterWithLLM(pool, existingEvents, articlesById) {
  const existingBlock = existingEvents
    .map((e) => {
      const heads = e.articleIds
        .slice(-3)
        .map((id) => articlesById[id]?.title)
        .filter(Boolean)
        .map((t) => `    - ${t}`)
        .join('\n');
      return `[${e.id}] ${e.title}\n${heads}`;
    })
    .join('\n');
  const articleBlock = pool
    .map((a, i) => `${i}. (${a.source}) ${a.title}${a.summary ? ' — ' + truncate(a.summary, 160) : ''}`)
    .join('\n');

  const user = `EXISTING EVENTS (id, title, recent headlines):\n${existingBlock || '(none)'}\n\nNEW ARTICLES:\n${articleBlock}`;
  const result = await chatJSON(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    { temperature: 0.1, maxTokens: 6000 }
  );
  const events = Array.isArray(result?.events) ? result.events : [];
  const used = new Set();
  const existingIds = new Set(existingEvents.map((e) => e.id));
  const out = [];
  for (const ev of events) {
    const idxs = (ev.articles || [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < pool.length && !used.has(n));
    const existing = ev.existing_id && existingIds.has(ev.existing_id) ? ev.existing_id : null;
    if (!idxs.length || (!existing && idxs.length < 2)) continue;
    idxs.forEach((n) => used.add(n));
    out.push({
      existingId: existing,
      title: String(ev.title || '').trim(),
      summary: String(ev.summary || '').trim(),
      category: CATEGORIES.includes(ev.category) ? ev.category : 'Other',
      articleIds: idxs.map((n) => pool[n].id),
    });
  }
  return out;
}

// ---------- Heuristic fallback ----------

const STOP = new Set(
  `a an the and or but of to in on at for from by with as is are was were be been being it its this that these those after before over under into out up down off about amid against says say said new news live update updates latest how why what who when where will would could should can may might has have had not no more most than then they their them his her he she we you our your just also video watch photos report reports year years day days week weeks first last top us uk`.split(
    /\s+/
  )
);

export function tokens(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[’']s\b/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
  );
}

function similarity(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  if (shared < 2) return 0;
  return shared / Math.min(a.size, b.size);
}

export function clusterHeuristic(pool, existingEvents, articlesById) {
  const toks = pool.map((a) => tokens(`${a.title} ${a.title}`)); // title only; snippets add noise
  const evToks = existingEvents.map((e) => {
    const s = new Set();
    for (const id of e.articleIds) for (const t of tokens(articlesById[id]?.title || '')) s.add(t);
    for (const t of tokens(e.title)) s.add(t);
    return s;
  });

  const assignments = new Map(); // eventId -> [articleIdx]
  const free = [];
  pool.forEach((a, i) => {
    let best = -1;
    let bestScore = 0.5;
    evToks.forEach((et, j) => {
      const sc = similarity(toks[i], et);
      if (sc >= bestScore) {
        best = j;
        bestScore = sc;
      }
    });
    if (best >= 0) {
      const id = existingEvents[best].id;
      if (!assignments.has(id)) assignments.set(id, []);
      assignments.get(id).push(i);
    } else free.push(i);
  });

  // Union-find over the remaining articles.
  const parent = new Map(free.map((i) => [i, i]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (let x = 0; x < free.length; x++)
    for (let y = x + 1; y < free.length; y++) {
      const i = free[x];
      const j = free[y];
      if (similarity(toks[i], toks[j]) >= 0.5) parent.set(find(i), find(j));
    }
  const groups = new Map();
  for (const i of free) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const out = [];
  for (const [id, idxs] of assignments) out.push({ existingId: id, articleIds: idxs.map((i) => pool[i].id) });
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    if (new Set(idxs.map((i) => pool[i].source)).size < 2) continue;
    const lead = idxs.map((i) => pool[i]).sort((a, b) => b.title.length - a.title.length)[0];
    out.push({
      existingId: null,
      title: lead.title,
      summary: lead.summary || '',
      category: 'Other',
      articleIds: idxs.map((i) => pool[i].id),
    });
  }
  return out;
}

export async function cluster(pool, existingEvents, articlesById) {
  if (hasLLM()) {
    try {
      return { groups: await clusterWithLLM(pool, existingEvents, articlesById), method: 'llm' };
    } catch (e) {
      console.warn('[cluster] LLM grouping failed, using keyword fallback:', e.message);
      return { groups: clusterHeuristic(pool, existingEvents, articlesById), method: 'heuristic', error: e.message };
    }
  }
  return { groups: clusterHeuristic(pool, existingEvents, articlesById), method: 'heuristic' };
}
