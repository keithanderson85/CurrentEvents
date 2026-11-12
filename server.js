import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, hasLLM } from './src/config.js';
import { load, db, save, flush, newId } from './src/store.js';
import { refresh, status as refreshStatus } from './src/refresh.js';
import { runDeepDive } from './src/research.js';
import { streamChat } from './src/chat.js';
import { createManualEvent, addArticleToEvent, summarize, startFindCoverage } from './src/manual.js';
import { fetchArticle, truncate } from './src/fetcher.js';
import { checkModel, currentModel } from './src/llm.js';
import { FEEDS } from './src/sources.js';
import { CATEGORIES } from './src/cluster.js';

load();
const app = express();
app.use(express.json({ limit: '1mb' }));
// Serve index.html with version stamps on the CSS/JS links, so a browser never mixes a new page
// with an old cached stylesheet after an update. Everything else revalidates on each load.
const publicDir = path.join(config.root, 'public');
const stamp = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(publicDir, f))).digest('hex').slice(0, 10);
const indexHtml = fs
  .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace('href="/styles.css"', `href="/styles.css?v=${stamp('styles.css')}"`)
  .replace('src="/app.js"', `src="/app.js?v=${stamp('app.js')}"`);
const sendIndex = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml);
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(publicDir, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: e.message }));
const getEvent = (req, res) => {
  const ev = db().events[req.params.id];
  if (!ev) res.status(404).json({ error: 'Event not found' });
  return ev;
};

function eventSummary(ev) {
  const store = db();
  const arts = ev.articleIds.map((id) => store.articles[id]).filter(Boolean);
  const sources = [...new Set(arts.map((a) => a.source))];
  const images = [];
  const seenImg = new Set();
  // One image per outlet first, so the patchwork shows different headline images.
  for (const pass of [true, false]) {
    const usedSource = new Set();
    for (const a of arts) {
      if (!a.image || seenImg.has(a.image)) continue;
      if (pass && usedSource.has(a.source)) continue;
      usedSource.add(a.source);
      seenImg.add(a.image);
      images.push({ src: a.image, source: a.source, title: a.title });
    }
  }
  const latest = arts.reduce((m, a) => (a.publishedAt > m ? a.publishedAt : m), ev.createdAt);
  return {
    id: ev.id,
    title: ev.title,
    summary: ev.summary,
    category: ev.category,
    manual: Boolean(ev.manual),
    track: ev.manual ? ev.track !== false : false,
    description: ev.description || '',
    lastFoundAt: ev.lastFoundAt || null,
    pinned: Boolean(ev.pinned),
    building: Boolean(ev.building),
    articleCount: arts.length,
    sources,
    leans: [...new Set(arts.map((a) => a.lean).filter(Boolean))],
    images: images.slice(0, 9),
    latestAt: latest,
    createdAt: ev.createdAt,
    updatedAt: ev.updatedAt,
    noteCount: ev.notes?.length || 0,
    chatCount: ev.chat?.length || 0,
    researched: Boolean(ev.research?.some((r) => r.status === 'done')),
  };
}

// ---------- Status & settings ----------

app.get('/api/status', (req, res) => {
  res.json({
    llm: hasLLM(),
    model: currentModel(),
    researchModel: currentModel('research'),
    refresh: refreshStatus,
    refreshMinutes: config.refreshMinutes,
    feeds: FEEDS.map((f) => ({ name: f.name, lean: f.lean, kind: f.kind })),
    categories: CATEGORIES,
    counts: { events: Object.keys(db().events).length, articles: Object.keys(db().articles).length },
  });
});

app.get('/api/model-check', wrap(async (req, res) => res.json(await checkModel())));

app.put('/api/settings', (req, res) => {
  const s = db().settings;
  // Only store overrides that differ from the .env defaults, so editing .env later still takes effect.
  const defaults = { model: config.openrouter.model, researchModel: config.openrouter.researchModel || config.openrouter.model };
  for (const k of ['model', 'researchModel']) {
    if (typeof req.body[k] !== 'string') continue;
    const v = req.body[k].trim();
    s[k] = v && v !== defaults[k] ? v : '';
  }
  save();
  res.json({ model: currentModel(), researchModel: currentModel('research') });
});

app.post('/api/refresh', (req, res) => {
  refresh();
  res.json({ started: true, refresh: refreshStatus });
});

// ---------- Events ----------

app.get('/api/events', (req, res) => {
  const events = Object.values(db().events).map(eventSummary).filter((e) => e.articleCount > 0 || e.manual);
  res.json({ events, refresh: refreshStatus });
});

app.post(
  '/api/events',
  wrap(async (req, res) => {
    const { title = '', description = '', urls = [], autoFind = true } = req.body || {};
    if (!title.trim() && !urls.length) return res.status(400).json({ error: 'Give the event a title or at least one link.' });
    const ev = await createManualEvent({ title, description, urls: Array.isArray(urls) ? urls : String(urls).split(/\s+/), autoFind });
    res.json(eventSummary(ev));
  })
);

app.get('/api/events/:id', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  const store = db();
  const articles = ev.articleIds
    .map((id) => store.articles[id])
    .filter(Boolean)
    .map(({ text, ...a }) => ({ ...a, hasText: Boolean(text) }))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  res.json({ ...eventSummary(ev), articles, notes: ev.notes || [], chat: ev.chat || [], research: ev.research || [], buildErrors: ev.buildErrors || [] });
});

app.patch('/api/events/:id', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  const { title, summary, category, pinned, track } = req.body || {};
  if (typeof track === 'boolean') ev.track = track;
  if (typeof title === 'string' && title.trim()) {
    ev.title = title.trim();
    ev.titleLocked = true; // don't let auto-grouping rename it
  }
  if (typeof summary === 'string') ev.summary = summary;
  if (CATEGORIES.includes(category)) ev.category = category;
  if (typeof pinned === 'boolean') ev.pinned = pinned;
  save();
  res.json(eventSummary(ev));
});

app.delete('/api/events/:id', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  const store = db();
  for (const id of ev.articleIds) if (store.articles[id]?.eventId === ev.id) store.articles[id].eventId = 'dismissed';
  delete store.events[ev.id];
  save();
  res.json({ ok: true });
});

app.post(
  '/api/events/:id/summarize',
  wrap(async (req, res) => {
    const ev = getEvent(req, res);
    if (!ev) return;
    if (!hasLLM()) return res.status(400).json({ error: 'Add an OpenRouter API key to use AI features.' });
    await summarize(ev);
    save();
    res.json(eventSummary(ev));
  })
);

// Search the web + gathered articles for more coverage (runs in the background).
app.post('/api/events/:id/find', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  if (!startFindCoverage(ev)) return res.status(409).json({ error: 'Already searching for coverage.' });
  res.json(eventSummary(ev));
});

// Articles
app.post(
  '/api/events/:id/articles',
  wrap(async (req, res) => {
    const ev = getEvent(req, res);
    if (!ev) return;
    if (!/^https?:\/\//i.test(req.body?.url || '')) return res.status(400).json({ error: 'Enter a full link starting with http(s)://' });
    res.json(await addArticleToEvent(ev, req.body.url));
  })
);

app.delete('/api/events/:id/articles/:aid', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  ev.articleIds = ev.articleIds.filter((x) => x !== req.params.aid);
  const a = db().articles[req.params.aid];
  if (a && a.eventId === ev.id) a.eventId = 'dismissed'; // keep it from being re-grouped here
  save();
  res.json({ ok: true });
});

// Notes / custom data
app.post(
  '/api/events/:id/notes',
  wrap(async (req, res) => {
    const ev = getEvent(req, res);
    if (!ev) return;
    const { text = '', label = '', url = '' } = req.body || {};
    if (!text.trim() && !url.trim()) return res.status(400).json({ error: 'Add some text or a link.' });
    const note = { id: newId('n_'), label: label.trim(), text: text.trim(), url: url.trim(), createdAt: new Date().toISOString() };
    if (note.url) {
      try {
        const page = await fetchArticle(note.url, { timeout: 12000 });
        note.linkTitle = page.title;
        note.linkText = truncate(page.text, 5000);
        note.linkImage = page.image;
      } catch (e) {
        note.linkError = e.message;
      }
    }
    ev.notes = ev.notes || [];
    ev.notes.push(note);
    save();
    res.json(note);
  })
);

app.patch('/api/events/:id/notes/:nid', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  const note = ev.notes?.find((n) => n.id === req.params.nid);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  for (const k of ['label', 'text']) if (typeof req.body[k] === 'string') note[k] = req.body[k];
  note.updatedAt = new Date().toISOString();
  save();
  res.json(note);
});

app.delete('/api/events/:id/notes/:nid', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  ev.notes = (ev.notes || []).filter((n) => n.id !== req.params.nid);
  save();
  res.json({ ok: true });
});

// Deep dive
app.post(
  '/api/events/:id/research',
  wrap(async (req, res) => {
    const ev = getEvent(req, res);
    if (!ev) return;
    if (ev.research?.some((r) => r.status === 'running')) return res.status(409).json({ error: 'A deep dive is already running.' });
    res.json(await runDeepDive(ev.id, { focus: req.body?.focus || '', articleId: req.body?.articleId || null, evidence: req.body?.evidence !== false }));
  })
);

app.delete('/api/events/:id/research/:rid', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  ev.research = (ev.research || []).filter((r) => r.id !== req.params.rid);
  save();
  res.json({ ok: true });
});

// Chat (Server-Sent Events stream)
app.post('/api/events/:id/chat', async (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Empty message' });
  if (!hasLLM()) return res.status(400).json({ error: 'Add an OpenRouter API key to chat.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    await streamChat(ev.id, message, { onToken: (t) => send({ t }), signal: ctrl.signal });
    send({ done: true });
  } catch (e) {
    if (!ctrl.signal.aborted) send({ error: e.message });
  }
  res.end();
});

app.delete('/api/events/:id/chat', (req, res) => {
  const ev = getEvent(req, res);
  if (!ev) return;
  ev.chat = [];
  save();
  res.json({ ok: true });
});

// Image proxy: fallback for outlets that block hot-linked images.
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!/^https?:\/\//i.test(u)) return res.status(400).end();
  try {
    const r = await fetch(u, { headers: { 'User-Agent': config.userAgent, Accept: 'image/*' }, signal: AbortSignal.timeout(10000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8e6) return res.status(413).end();
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=86400').send(buf);
  } catch {
    res.status(502).end();
  }
});

app.get(/^\/(?!api\/).*/, sendIndex);

// ---------- Start ----------

const server = app.listen(config.port, async () => {
  console.log(`OpenFrame News running at http://localhost:${config.port}`);
  if (!hasLLM()) {
    console.log('No OPENROUTER_API_KEY set: using keyword grouping; deep dive shows sources only; chat disabled.');
  } else {
    console.log(`Model: ${currentModel()}`);
    const check = await checkModel();
    if (check.ok === false) {
      console.warn(`\n⚠  Model "${check.model}" was not found on OpenRouter. Set OPENROUTER_MODEL in .env.`);
      if (check.suggestions?.length) console.warn('   DeepSeek models available:', check.suggestions.join(', '));
    }
  }
  if (process.env.NO_AUTO_REFRESH !== '1') {
    refresh();
    if (config.refreshMinutes > 0) setInterval(() => refresh(), config.refreshMinutes * 60e3);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    server.close();
    process.exit(0);
  });
}
