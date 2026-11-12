import { db, save, newId } from './store.js';
import { chatJSON } from './llm.js';
import { hasLLM } from './config.js';
import { mapLimit, truncate } from './fetcher.js';
import { articleFromUrl, searchGdelt } from './research.js';
import { tokens, CATEGORIES } from './cluster.js';

// Events you create yourself: from a topic, a handful of article links, or both.

export async function createManualEvent({ title, description = '', urls = [], autoFind = true }) {
  const store = db();
  const now = new Date().toISOString();
  const event = {
    id: newId('evt_'),
    title: (title || '').trim() || 'Untitled event',
    summary: description.trim(),
    category: 'Other',
    articleIds: [],
    createdAt: now,
    updatedAt: now,
    notes: [],
    chat: [],
    research: [],
    titleLocked: Boolean(title?.trim()),
    manual: true,
    building: true,
  };
  store.events[event.id] = event;
  save();
  buildManualEvent(event, { urls, autoFind }).catch((e) => {
    event.buildError = e.message;
    event.building = false;
    save();
  });
  return event;
}

async function buildManualEvent(event, { urls, autoFind }) {
  const store = db();
  const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 15);
  const errors = [];
  const fetched = await mapLimit(clean, 5, (u) => articleFromUrl(u, event.id));
  fetched.forEach((a, i) => {
    if (!a || a.error) return errors.push(`${clean[i]}: ${a?.error || 'failed'}`);
    attach(event, a);
  });

  if (!event.titleLocked && event.articleIds.length) {
    event.title = store.articles[event.articleIds[0]].title;
  }

  if (autoFind) {
    // 1) Matching articles we already pulled from the feeds.
    const want = tokens(`${event.title} ${event.summary}`);
    for (const a of Object.values(store.articles)) {
      if (a.eventId) continue;
      const t = tokens(a.title);
      let shared = 0;
      for (const w of t) if (want.has(w)) shared++;
      if (shared >= 2 && shared / Math.min(t.size || 1, want.size || 1) >= 0.4) {
        a.eventId = event.id;
        event.articleIds.push(a.id);
      }
    }
    // 2) A web news search for more coverage.
    try {
      const results = (await searchGdelt(event.title, { max: 25, timespan: '14d' }))
        .filter((r, i, arr) => arr.findIndex((x) => x.domain === r.domain) === i)
        .slice(0, 6);
      const extra = await mapLimit(results, 5, (r) => articleFromUrl(r.url, event.id));
      extra.forEach((a, i) => {
        if (!a || a.error) return;
        if (!a.image && results[i].image) a.image = results[i].image;
        attach(event, a);
      });
    } catch (e) {
      errors.push('news search: ' + e.message);
    }
  }

  if (hasLLM() && event.articleIds.length) {
    try {
      await summarize(event);
    } catch (e) {
      errors.push('summary: ' + e.message);
    }
  } else if (!event.summary && event.articleIds.length) {
    event.summary = store.articles[event.articleIds[0]].summary || '';
  }

  event.building = false;
  event.buildErrors = errors;
  event.updatedAt = new Date().toISOString();
  save();
}

function attach(event, a) {
  const store = db();
  const existing = store.articles[a.id];
  if (existing && existing.eventId && existing.eventId !== event.id) {
    // Move it from its auto-grouped event into this one.
    const old = store.events[existing.eventId];
    if (old) old.articleIds = old.articleIds.filter((x) => x !== a.id);
  }
  store.articles[a.id] = { ...(existing || {}), ...a, image: a.image || existing?.image, eventId: event.id };
  if (!event.articleIds.includes(a.id)) event.articleIds.push(a.id);
}

export async function summarize(event) {
  const store = db();
  const arts = event.articleIds.map((id) => store.articles[id]).filter(Boolean).slice(0, 15);
  const r = await chatJSON(
    [
      {
        role: 'system',
        content: `You write neutral news summaries. Return JSON {"title":"short neutral headline, max 12 words","summary":"2-3 neutral sentences on what happened","category":"one of ${CATEGORIES.join(', ')}"} based only on the articles.`,
      },
      {
        role: 'user',
        content: `Topic given by the reader: ${event.title}\n${event.summary ? 'Reader description: ' + event.summary + '\n' : ''}\nArticles:\n${arts
          .map((a) => `- (${a.source}) ${a.title}: ${truncate(a.text || a.summary, 600)}`)
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
  save();
  return db().articles[a.id];
}
