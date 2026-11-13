import { config } from './config.js';
import { db, save, newId } from './store.js';
import { fetchAllFeeds } from './feeds.js';
import { cluster } from './cluster.js';
import { fetchArticle, mapLimit } from './fetcher.js';
import { matchNewArticlesToTopics } from './manual.js';
import { autoCheck } from './check.js';
import { anyUserData } from './auth.js';

const BATCH = 60; // articles per grouping call (smaller batches keep the model's answer short and reliable)
const MAX_GROUP_TRIES = 3; // stop re-sending articles that never match anything
const POOL_HOURS = 48; // ungrouped articles are retried for this long
const EVENT_ACTIVE_HOURS = 72; // events that can still receive new articles
const EVENT_MAX_AGE_DAYS = 10; // events without notes/chat are dropped after this

let running = null;
export const status = { running: false, lastRun: null, lastError: null, lastReport: [], method: null, added: 0 };

export function refresh({ log = console.log } = {}) {
  if (running) return running;
  running = doRefresh(log)
    .catch((e) => {
      status.lastError = e.message;
      log('[refresh] failed:', e.message);
    })
    .finally(() => {
      running = null;
      status.running = false;
    });
  return running;
}

async function doRefresh(log) {
  status.running = true;
  status.lastError = null;
  const store = db();
  const t0 = Date.now();

  const { articles, report } = await fetchAllFeeds();
  status.lastReport = report;
  let added = 0;
  const fresh = [];
  for (const a of articles) {
    if (!store.articles[a.id]) {
      store.articles[a.id] = { ...a, eventId: null, fetchedAt: new Date().toISOString() };
      fresh.push(store.articles[a.id]);
      added++;
    } else if (!store.articles[a.id].image && a.image) {
      store.articles[a.id].image = a.image;
    }
  }
  status.added = added;
  log(`[refresh] ${articles.length} articles from ${report.filter((r) => r.ok).length}/${report.length} feeds, ${added} new`);

  await groupPending(log);
  if (fresh.length) await matchNewArticlesToTopics(fresh, log).catch((e) => log('[topics] failed:', e.message));
  await fillMissingImages(log);
  prune();
  save();
  status.lastRun = new Date().toISOString();
  save();
  await autoCheck(log).catch((e) => log('[check] failed:', e.message));
  save();
  log(`[refresh] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export async function groupPending(log = console.log) {
  const store = db();
  const now = Date.now();
  const pool = Object.values(store.articles)
    .filter((a) => !a.eventId && (a.groupTries || 0) < MAX_GROUP_TRIES && now - new Date(a.publishedAt).getTime() < POOL_HOURS * 3600e3)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (pool.length < 1) return;

  for (let i = 0; i < pool.length; i += BATCH) {
    const batch = pool.slice(i, i + BATCH);
    const active = Object.values(store.events)
      .filter((e) => !e.ownerId) // never file news into someone's private custom event
      .filter((e) => now - new Date(e.updatedAt).getTime() < EVENT_ACTIVE_HOURS * 3600e3)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80);
    const { groups, method, error } = await cluster(batch, active, store.articles);
    status.method = method;
    status.lastError = error || null;
    applyGroups(groups);
    if (method === 'llm') for (const a of batch) if (!a.eventId) a.groupTries = (a.groupTries || 0) + 1;
    log(`[group] batch ${i / BATCH + 1}: ${groups.length} groups via ${method}`);
  }
}

function applyGroups(groups) {
  const store = db();
  const now = new Date().toISOString();
  for (const g of groups) {
    let ev = g.existingId ? store.events[g.existingId] : null;
    if (!ev) {
      ev = {
        id: newId('evt_'),
        title: g.title,
        summary: g.summary,
        category: g.category || 'Other',
        articleIds: [],
        createdAt: now,
        updatedAt: now,
        titleLocked: false,
      };
      store.events[ev.id] = ev;
    } else {
      if (g.title && !ev.titleLocked) ev.title = g.title;
      if (g.summary) ev.summary = g.summary;
      if (g.category && g.category !== 'Other') ev.category = g.category;
    }
    for (const aid of g.articleIds) {
      const a = store.articles[aid];
      if (!a || a.eventId) continue;
      a.eventId = ev.id;
      if (!ev.articleIds.includes(aid)) ev.articleIds.push(aid);
    }
    ev.updatedAt = now;
  }
}

// Some feeds don't include images. Pull og:image from the article page for grouped articles.
async function fillMissingImages(log) {
  const store = db();
  const need = Object.values(store.articles)
    .filter((a) => a.eventId && !a.image && !a.imageTried)
    .slice(0, 40);
  if (!need.length) return;
  let found = 0;
  await mapLimit(need, 6, async (a) => {
    a.imageTried = true;
    const page = await fetchArticle(a.url, { timeout: 8000 });
    if (page.image) {
      a.image = page.image;
      found++;
    }
  });
  log(`[images] filled ${found}/${need.length} missing images`);
}

function prune() {
  const store = db();
  const now = Date.now();
  for (const [id, e] of Object.entries(store.events)) {
    const hasUserData = e.manual || anyUserData(e);
    if (!hasUserData && now - new Date(e.updatedAt).getTime() > EVENT_MAX_AGE_DAYS * 864e5) {
      delete store.events[id]; // its articles are removed below once nothing references them
    }
  }
  const referenced = new Set(Object.values(store.events).flatMap((e) => e.articleIds));
  for (const [id, a] of Object.entries(store.articles)) {
    if (referenced.has(id)) continue;
    if (now - new Date(a.publishedAt).getTime() > config.articleMaxAgeHours * 3600e3) delete store.articles[id];
  }
}
