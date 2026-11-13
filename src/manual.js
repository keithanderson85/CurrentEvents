import { db, save, newId } from './store.js';
import { chatJSON } from './llm.js';
import { hasLLM } from './config.js';
import { fetchArticle, mapLimit, truncate } from './fetcher.js';
import { articleFromUrl } from './research.js';
import { searchNews, articleFromResult } from './search.js';
import { tokens, CATEGORIES } from './cluster.js';

// Events you create yourself: from a topic, a handful of article links, or both.
// Topic events keep collecting matching articles on every refresh.

const MAX_ADD_PER_RUN = 25;

export async function createManualEvent({ title, description = '', urls = [], autoFind = true, ownerId = null }) {
  const store = db();
  const now = new Date().toISOString();
  const event = {
    id: newId('evt_'),
    title: (title || '').trim() || 'Untitled event',
    summary: '',
    description: description.trim(),
    category: 'Other',
    articleIds: [],
    createdAt: now,
    updatedAt: now,
    titleLocked: Boolean(title?.trim()),
    manual: true,
    ownerId, // custom events belong to the person who made them
    track: autoFind,
    building: true,
  };
  store.events[event.id] = event;
  save();
  buildManualEvent(event, { urls, autoFind });
  return event;
}

async function buildManualEvent(event, { urls, autoFind }) {
  const store = db();
  const errors = [];
  try {
    const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 15);
    const fetched = await mapLimit(clean, 5, (u) => articleFromUrl(u, event.id));
    fetched.forEach((a, i) => {
      if (!a || a.error) return errors.push(`${clean[i]}: ${a?.error || 'failed'}`);
      attach(event, a);
    });
    if (!event.titleLocked && event.articleIds.length) event.title = store.articles[event.articleIds[0]].title;

    if (autoFind) {
      const r = await findCoverage(event, { summarizeAfter: false });
      errors.push(...r.errors);
    }
    await resummarize(event, errors);
  } catch (e) {
    errors.push(e.message);
  } finally {
    event.building = false;
    event.buildErrors = errors;
    event.updatedAt = new Date().toISOString();
    save();
  }
}

// Search the web and the articles we already have for coverage of this event.
// Returns { added, errors }.
export async function findCoverage(event, { summarizeAfter = true, timespan = '7d' } = {}) {
  const store = db();
  const errors = [];
  const existing = event.articleIds.map((id) => store.articles[id]).filter(Boolean);
  const have = new Set(event.articleIds);
  const haveUrl = new Set(existing.map((a) => a.url));

  // 1) Decide what to search for.
  const queries = await planQueries(event, existing);
  event.lastQueries = queries;

  // 2) Web news search (several engines), widening the window if it comes back thin.
  let { results, errors: searchErrors } = await searchNews(queries, { timespan });
  if (results.length < 6 && timespan === '7d') {
    const wider = await searchNews(queries.slice(0, 1), { timespan: '30d' });
    results = results.concat(wider.results.filter((r) => !results.some((x) => x.url === r.url)));
    searchErrors = searchErrors.concat(wider.errors);
  }
  if (searchErrors.length) {
    const engines = [...new Set(searchErrors.map((e) => e.split(' (')[0]))];
    console.warn('[find] search errors:', searchErrors.join(' | '));
    if (!results.length) errors.push(`Search sources that didn't respond: ${engines.join(', ')}. Check your internet connection, or try again in a minute.`);
  }

  // 3) Articles already gathered from the feeds (even if they're in another auto event).
  const want = tokens(`${event.title} ${event.description || ''} ${queries.join(' ')}`);
  const weekAgo = Date.now() - 7 * 864e5;
  const local = Object.values(store.articles)
    .filter((a) => !have.has(a.id) && a.eventId !== 'dismissed' && new Date(a.publishedAt).getTime() > weekAgo)
    .map((a) => ({ a, shared: [...tokens(a.title)].filter((t) => want.has(t)).length }))
    .filter((x) => x.shared >= 1)
    .sort((x, y) => y.shared - x.shared)
    .slice(0, 60)
    .map((x) => x.a);

  const candidates = [
    ...local.map((a) => ({ kind: 'local', a, title: a.title, source: a.source, summary: a.summary })),
    ...results
      .filter((r) => !haveUrl.has(r.url))
      .slice(0, 60)
      .map((r) => ({ kind: 'web', r, title: r.title, source: r.sourceName || r.domain, summary: r.summary || '' })),
  ];

  // 4) Keep only the ones that are really about this event.
  const picked = await pickRelevant(event, candidates, want, errors);

  // 5) Attach.
  let added = 0;
  const newWeb = [];
  for (const c of picked) {
    if (added >= MAX_ADD_PER_RUN) break;
    if (c.kind === 'local') {
      if (have.has(c.a.id)) continue;
      event.articleIds.push(c.a.id);
      have.add(c.a.id);
    } else {
      const art = articleFromResult(c.r, event.id);
      if (have.has(art.id)) continue;
      const prior = store.articles[art.id];
      store.articles[art.id] = prior ? { ...prior, image: prior.image || art.image } : art;
      event.articleIds.push(art.id);
      have.add(art.id);
      if (!prior) newWeb.push(store.articles[art.id]);
    }
    added++;
  }
  save();

  // 6) Best-effort: load pages for images/text (many outlets block this; that's fine).
  await enrich(newWeb.filter((a) => !a.found || a.found !== 'googlenews').slice(0, 12));

  if (!event.articleIds.length) {
    errors.unshift(`No coverage found for “${queries.join('”, “')}”. Try different wording, or add an article link.`);
  }
  if (summarizeAfter) await resummarize(event, errors);
  event.lastFoundAt = new Date().toISOString();
  event.updatedAt = event.lastFoundAt;
  save();
  return { added, errors };
}

async function planQueries(event, existing) {
  const base = [event.title, event.description].filter(Boolean).join(' — ');
  if (!hasLLM()) return [event.title];
  try {
    const r = await chatJSON(
      [
        {
          role: 'system',
          content:
            'You turn a news topic into web news search queries. Return JSON {"queries":["…","…","…"]}: 3 short keyword queries (2-5 words each, no quotes or operators) that would find current news articles about this topic, from most to least specific. Use the names and terms news outlets would use in headlines.',
        },
        {
          role: 'user',
          content: `Topic: ${base}${existing.length ? `\nArticles already in this event:\n${existing.slice(0, 8).map((a) => '- ' + a.title).join('\n')}` : ''}`,
        },
      ],
      { temperature: 0.2, maxTokens: 300 }
    );
    const qs = (r.queries || []).map(String).filter(Boolean).slice(0, 3);
    return qs.length ? qs : [event.title];
  } catch {
    return [event.title];
  }
}

async function pickRelevant(event, candidates, want, errors) {
  if (!candidates.length) return [];
  if (hasLLM()) {
    try {
      const r = await chatJSON(
        [
          {
            role: 'system',
            content:
              'You are a news editor deciding which articles belong in a story file. Return JSON {"relevant":[indexes]} listing the articles that are substantially about the given topic (not just passing mentions, opinion pieces about unrelated things, or a different story that shares a keyword). Order them from most to least relevant.',
          },
          {
            role: 'user',
            content: `TOPIC: ${event.title}${event.description ? `\nDETAILS: ${event.description}` : ''}${
              event.summary ? `\nCURRENT SUMMARY: ${event.summary}` : ''
            }\n\nARTICLES:\n${candidates.map((c, i) => `${i}. (${c.source}) ${c.title}${c.summary ? ' — ' + truncate(c.summary, 140) : ''}`).join('\n')}`,
          },
        ],
        { temperature: 0, maxTokens: 800 }
      );
      const idx = (r.relevant || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length);
      return [...new Set(idx)].map((n) => candidates[n]);
    } catch (e) {
      errors.push('AI relevance check failed, used keyword matching: ' + e.message);
    }
  }
  // Keyword fallback: web results are already query-matched; local ones need a solid overlap.
  const need = Math.min(2, want.size);
  return candidates.filter((c) => {
    const shared = [...tokens(c.title)].filter((t) => want.has(t)).length;
    return c.kind === 'web' ? shared >= 1 : shared >= need;
  });
}

async function enrich(articles) {
  await mapLimit(articles, 4, async (a) => {
    const page = await fetchArticle(a.url, { timeout: 8000 });
    if (!a.image && page.image) a.image = page.image;
    if (page.text && page.text.length > 200) a.text = truncate(page.text, 6000);
    if (!a.summary && page.description) a.summary = truncate(page.description, 400);
  });
}

function attach(event, a) {
  const store = db();
  const existing = store.articles[a.id];
  // Articles can belong to an auto event and to your own events at the same time.
  store.articles[a.id] = existing
    ? { ...existing, text: existing.text || a.text, image: existing.image || a.image, summary: existing.summary || a.summary }
    : a;
  if (!store.articles[a.id].eventId) store.articles[a.id].eventId = event.id;
  if (!event.articleIds.includes(a.id)) event.articleIds.push(a.id);
}

async function resummarize(event, errors = []) {
  const store = db();
  if (!event.articleIds.length) return;
  if (hasLLM()) {
    try {
      await summarize(event);
    } catch (e) {
      errors.push('summary: ' + e.message);
    }
  } else if (!event.summary) {
    event.summary = store.articles[event.articleIds[0]].summary || '';
  }
}

export async function summarize(event) {
  const store = db();
  const arts = event.articleIds
    .map((id) => store.articles[id])
    .filter(Boolean)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 15);
  if (!arts.length) throw new Error('This event has no articles yet, so there is nothing to summarize.');
  const r = await chatJSON(
    [
      {
        role: 'system',
        content: `You write neutral news summaries. Return JSON {"title":"short neutral headline, max 12 words","summary":"2-3 neutral sentences on the latest developments","category":"one of ${CATEGORIES.join(
          ', '
        )}"} based only on the articles.`,
      },
      {
        role: 'user',
        content: `Topic given by the reader: ${event.title}\n${event.description ? 'Reader description: ' + event.description + '\n' : ''}\nArticles (newest first):\n${arts
          .map((a) => `- (${a.source}, ${a.publishedAt.slice(0, 10)}) ${a.title}: ${truncate(a.text || a.summary, 600)}`)
          .join('\n')}`,
      },
    ],
    { temperature: 0.2, maxTokens: 500 }
  );
  if (r.title && !event.titleLocked) event.title = r.title;
  if (r.summary) event.summary = r.summary;
  if (CATEGORIES.includes(r.category)) event.category = r.category;
}

export async function addArticleToEvent(event, url) {
  const a = await articleFromUrl(url, event.id);
  attach(event, a);
  event.updatedAt = new Date().toISOString();
  const errors = [];
  await resummarize(event, errors);
  if (errors.length) event.buildErrors = errors;
  save();
  return db().articles[a.id];
}

// Run a coverage search in the background (used by the "Find more coverage" button).
export function startFindCoverage(event) {
  if (event.building) return false;
  event.building = true;
  save();
  findCoverage(event)
    .then((r) => (event.buildErrors = r.errors))
    .catch((e) => (event.buildErrors = [e.message]))
    .finally(() => {
      event.building = false;
      save();
    });
  return true;
}

// Called after each feed refresh: add newly gathered articles that match your topic events.
export async function matchNewArticlesToTopics(newArticles, log = console.log) {
  const store = db();
  const topics = Object.values(store.events).filter((e) => e.manual && e.track !== false && !e.building);
  for (const ev of topics) {
    const want = tokens(`${ev.title} ${ev.description || ''} ${(ev.lastQueries || []).join(' ')}`);
    const have = new Set(ev.articleIds);
    const cands = newArticles
      .filter((a) => !have.has(a.id))
      .filter((a) => [...tokens(a.title)].some((t) => want.has(t)))
      .slice(0, 50)
      .map((a) => ({ kind: 'local', a, title: a.title, source: a.source, summary: a.summary }));
    if (!cands.length) continue;
    const picked = await pickRelevant(ev, cands, want, []);
    if (!picked.length) continue;
    for (const c of picked) ev.articleIds.push(c.a.id);
    ev.updatedAt = new Date().toISOString();
    await resummarize(ev, []);
    log(`[topics] added ${picked.length} new article(s) to “${ev.title}”`);
  }
  save();
}
