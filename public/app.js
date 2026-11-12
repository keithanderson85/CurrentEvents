// OpenFrame News — front end (no build step, plain ES modules).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');

const state = {
  status: null,
  events: [],
  category: 'All',
  q: '',
  event: null,
  tab: 'coverage',
  chatBusy: false,
  pollTimer: null,
};

// ---------- Utilities ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

const LEANS = ['left', 'lean-left', 'center', 'lean-right', 'right'];
const leanLabel = (l) => (l || 'unknown').replace('-', ' ');

const icons = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4H6l4-4z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5z"/><path d="M14 4v5h5"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  dive: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
};

// Minimal, safe Markdown renderer (escapes first, then formats). Turns [n] into citation links.
function md(src, { citePrefix = '' } = {}) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums) =>
        nums
          .split(/\s*,\s*/)
          .map((n) => (citePrefix ? `<a class="cite" href="#${citePrefix}${n}" data-cite="${citePrefix}${n}">${n}</a>` : `<a class="cite">${n}</a>`))
          .join('')
      );
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flushPara();
      closeList();
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara();
      closeList();
      const lvl = m[1].length <= 2 ? 2 : 3;
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      closeList();
      html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return html;
}

// ---------- Patchwork title images ----------

// Images that fail to load are retried through our proxy, then replaced with a typographic tile.
window.__imgOk = (img) => img.classList.add('ok');
window.__imgErr = (img) => {
  if (!img.dataset.retried) {
    img.dataset.retried = '1';
    img.src = '/api/img?u=' + encodeURIComponent(img.dataset.src);
    return;
  }
  const tile = img.closest('.patch');
  if (!tile) return;
  tile.classList.add('fallback');
  tile.innerHTML = esc(tile.dataset.source || '');
};

function patchwork(images, title, max = 7) {
  const imgs = (images || []).slice(0, max);
  if (!imgs.length) {
    const initial = (title || '?').trim().charAt(0).toUpperCase();
    return `<div class="patchwork pw-3 empty" aria-hidden="true"><div class="patch initial">${esc(initial)}</div><div class="patch"></div><div class="patch"></div></div>`;
  }
  return `<div class="patchwork pw-${imgs.length}" aria-hidden="true">${imgs
    .map(
      (im) =>
        `<div class="patch" data-source="${esc(im.source)}"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(im.src)}" data-src="${esc(
          im.src
        )}" alt="" onload="__imgOk(this)" onerror="__imgErr(this)"><span class="src">${esc(im.source)}</span></div>`
    )
    .join('')}</div>`;
}

function spectrumDots(leans) {
  const set = new Set(leans);
  return `<span class="spectrum" title="Coverage across the spectrum">${LEANS.map((l) => `<i class="${set.has(l) ? l : ''}"></i>`).join('')}</span>`;
}

// ---------- Router ----------

function route() {
  clearInterval(state.pollTimer);
  if ($('#chat')?.classList.contains('open')) closeChatSheet({ fromHistory: true });
  document.body.classList.remove('chat-open');
  askObserver?.disconnect();
  $('#chatFab')?.classList.remove('show');
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/event\/([\w-]+)/);
  window.scrollTo(0, 0);
  if (m) renderEvent(m[1]);
  else renderHome();
}
window.addEventListener('hashchange', route);

// ---------- Home ----------

function score(e) {
  const hours = (Date.now() - new Date(e.latestAt || e.updatedAt).getTime()) / 3600e3;
  return (e.pinned ? 1000 : 0) + e.sources.length * 3 + e.articleCount - hours * 0.35;
}

async function loadEvents() {
  const [ev, st] = await Promise.all([api('/api/events'), api('/api/status')]);
  state.events = ev.events;
  state.status = st;
}

function filtered() {
  const q = state.q.toLowerCase();
  return state.events
    .filter((e) => state.category === 'All' || e.category === state.category || (state.category === 'Mine' && e.manual))
    .filter((e) => !q || `${e.title} ${e.summary} ${e.sources.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => score(b) - score(a));
}

function statusLine() {
  const r = state.status?.refresh || {};
  if (r.running) return `<span class="status-line"><span class="live busy"></span>Gathering the latest articles…</span>`;
  const ok = (r.lastReport || []).filter((x) => x.ok).length;
  const total = (r.lastReport || []).length;
  return `<span class="status-line"><span class="live"></span>${
    r.lastRun ? `Updated ${timeAgo(r.lastRun)} · ${ok}/${total} sources` : 'Waiting for first update'
  }${r.method === 'heuristic' && state.status?.llm ? ' · AI grouping unavailable, used keywords' : ''}</span>`;
}

function cardHTML(e, i, featured) {
  return `<a class="card ${featured ? 'featured' : ''}" href="#/event/${e.id}" style="animation-delay:${Math.min(i, 12) * 30}ms">
    ${e.pinned ? `<span class="pin-flag">Pinned</span>` : ''}
    ${patchwork(e.images, e.title, featured ? 7 : 6)}
    <div class="card-body">
      <div class="kicker"><span class="cat">${esc(e.manual ? 'My event' : e.category || 'News')}</span><span class="dot"></span><span>${timeAgo(e.latestAt)}</span></div>
      <h2 class="card-title">${esc(e.title)}</h2>
      ${e.summary ? `<p class="card-summary">${esc(e.summary)}</p>` : e.building ? `<p class="card-summary">Gathering articles…</p>` : ''}
      <div class="card-foot">
        <span style="display:flex;gap:10px;align-items:center">${spectrumDots(e.leans)}<span>${e.sources.length} source${e.sources.length === 1 ? '' : 's'} · ${e.articleCount} article${
    e.articleCount === 1 ? '' : 's'
  }</span></span>
        <span class="badges">
          ${e.researched ? `<span class="badge accent" title="Deep dive done">${icons.dive}</span>` : ''}
          ${e.noteCount ? `<span class="badge" title="Notes">${icons.note}${e.noteCount}</span>` : ''}
          ${e.chatCount ? `<span class="badge" title="Chat">${icons.chat}</span>` : ''}
        </span>
      </div>
    </div>
  </a>`;
}

function renderHomeGrid() {
  const list = filtered();
  const grid = $('#grid');
  if (!grid) return;
  if (!state.events.length) {
    const running = state.status?.refresh?.running;
    grid.outerHTML = running
      ? `<div class="grid" id="grid">${Array.from({ length: 6 }, () => '<div class="skeleton skel-card"></div>').join('')}</div>`
      : `<div id="grid" class="empty-state"><h2>No events yet</h2><p>Fetch the latest news, or start an event of your own.</p><div style="display:flex;gap:8px"><button class="btn primary" onclick="document.getElementById('refreshBtn').click()">Fetch news</button><button class="btn" onclick="document.getElementById('newEventBtn').click()">New event</button></div></div>`;
    return;
  }
  if (!list.length) {
    grid.outerHTML = `<div id="grid" class="empty-state"><h2>Nothing matches</h2><p>Try a different search or category.</p></div>`;
    return;
  }
  grid.outerHTML = `<div class="grid" id="grid">${list.map((e, i) => cardHTML(e, i, i === 0 && !state.q && list.length > 2)).join('')}</div>`;
}

function renderFilters() {
  const counts = {};
  for (const e of state.events) counts[e.category] = (counts[e.category] || 0) + 1;
  const mine = state.events.filter((e) => e.manual).length;
  const cats = ['All', ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])];
  if (mine) cats.push('Mine');
  $('#filters').innerHTML = cats
    .map((c) => {
      const n = c === 'All' ? state.events.length : c === 'Mine' ? mine : counts[c];
      return `<button class="chip ${state.category === c ? 'on' : ''}" data-cat="${esc(c)}">${c === 'Mine' ? 'My events' : esc(c)}<span class="n">${n}</span></button>`;
    })
    .join('');
}

async function renderHome() {
  document.title = 'OpenFrame News · The news, in context';
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Today's events</h1>
        <div class="sub" id="statusLine"></div>
      </div>
    </div>
    <div id="banner"></div>
    <div class="filters" id="filters"></div>
    <div class="grid" id="grid">${Array.from({ length: 6 }, () => '<div class="skeleton skel-card"></div>').join('')}</div>`;
  $('#filters').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (!c) return;
    state.category = c.dataset.cat;
    renderFilters();
    renderHomeGrid();
  });
  try {
    await loadEvents();
  } catch (e) {
    $('#grid').outerHTML = `<div id="grid" class="empty-state"><h2>Can't reach the server</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  paintHome();
  const tick = async () => {
    if (!location.hash.startsWith('#/') || location.hash.startsWith('#/event')) return;
    const wasRunning = state.status?.refresh?.running;
    await loadEvents().catch(() => {});
    paintHome();
    if (wasRunning && !state.status.refresh.running) toast('News updated');
  };
  state.pollTimer = setInterval(() => tick(), state.status?.refresh?.running ? 4000 : 30000);
  // Re-schedule faster polling when a refresh is in progress.
  const watch = setInterval(() => {
    if (location.hash.startsWith('#/event')) return clearInterval(watch);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => tick(), state.status?.refresh?.running ? 4000 : 30000);
  }, 10000);
}

function paintHome() {
  $('#statusLine').innerHTML = statusLine();
  $('#banner').innerHTML = state.status?.llm
    ? ''
    : `<div class="banner">${icons.sparkle}<span><b>AI features are off.</b> Add <code>OPENROUTER_API_KEY</code> to your <code>.env</code> and restart to get smarter grouping, deep dives and chat. Keyword grouping is being used for now.</span></div>`;
  renderFilters();
  renderHomeGrid();
  const btn = $('#refreshBtn');
  btn.classList.toggle('spin', Boolean(state.status?.refresh?.running));
}

// ---------- Event page ----------

async function loadEvent(id) {
  state.event = await api(`/api/events/${id}`);
  return state.event;
}

async function renderEvent(id) {
  app.innerHTML = `<div class="skeleton" style="height:420px;border-radius:20px"></div>`;
  let ev;
  try {
    ev = await loadEvent(id);
    if (!state.status) state.status = await api('/api/status');
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><h2>Event not found</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back to events</a></div>`;
    return;
  }
  if (ev.researched && state.tab === 'coverage' && false) state.tab = 'dive';
  document.title = `${ev.title} · OpenFrame News`;
  app.innerHTML = `
    <a href="#/" class="back">${icons.back} All events</a>
    <section class="hero" id="hero"></section>
    <div class="layout">
      <div class="ask-bar" id="askBar">
        <button type="button" class="ask-input" data-open-chat>${icons.chat}<span>Ask about this event…</span></button>
        <button type="button" class="btn accent" id="askDive">${icons.dive} Deep dive</button>
      </div>
      <div>
        <nav class="tabs" id="tabs"></nav>
        <div id="tabBody"></div>
      </div>
      <aside class="chat" id="chat" aria-label="Chat about this event"></aside>
    </div>`;
  paintHero();
  paintTabs();
  paintTab();
  paintChat();
  setupChatSheet();
  startEventPolling();
}

function startEventPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const ev = state.event;
    if (!ev || !location.hash.includes(ev.id)) return clearInterval(state.pollTimer);
    const busy = ev.building || ev.research.some((r) => r.status === 'running');
    if (!busy) return;
    await loadEvent(ev.id).catch(() => {});
    paintHero();
    paintTabs();
    // Don't wipe out something the user is in the middle of typing.
    const active = document.activeElement;
    const typing = active && /INPUT|TEXTAREA/.test(active.tagName) && active.value && $('#tabBody').contains(active);
    if (!typing) paintTab();
  }, 2000);
}

function paintHero() {
  const ev = state.event;
  $('#hero').innerHTML = `
    ${patchwork(ev.images, ev.title, 7)}
    <div class="hero-text">
      <div class="kicker"><span class="cat">${esc(ev.manual ? 'My event' : ev.category || 'News')}</span><span class="dot"></span><span>${ev.sources.length} sources · ${
    ev.articleCount
  } articles</span><span class="dot"></span><span>Updated ${timeAgo(ev.latestAt)}</span>${
    ev.building ? `<span class="dot"></span><span style="color:var(--accent)">Gathering articles…</span>` : ''
  }</div>
      <h1 class="hero-title" id="heroTitle">${esc(ev.title)}</h1>
      ${ev.summary ? `<p class="hero-summary">${esc(ev.summary)}</p>` : ev.description ? `<p class="hero-summary">${esc(ev.description)}</p>` : ''}
      <div class="hero-actions">
        <button class="btn accent desktop-only" data-act="dive">${icons.dive} Deep dive</button>
        <button class="btn" data-act="pin">${icons.pin} ${ev.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="btn" data-act="rename">${icons.edit} Rename</button>
        ${state.status?.llm && ev.articleCount ? `<button class="btn" data-act="resummarize">${icons.sparkle} Refresh summary</button>` : ''}
        <button class="btn ghost danger" data-act="delete">${icons.trash} Remove</button>
      </div>
    </div>`;
  $('#hero').onclick = heroAction;
}

function openDive() {
  state.tab = 'dive';
  paintTabs();
  paintTab();
  $('#tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('#diveFocus')?.focus({ preventScroll: true }), 400);
}

async function heroAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const ev = state.event;
  const act = b.dataset.act;
  try {
    if (act === 'dive') {
      openDive();
    } else if (act === 'pin') {
      Object.assign(ev, await api(`/api/events/${ev.id}`, { method: 'PATCH', body: { pinned: !ev.pinned } }));
      paintHero();
    } else if (act === 'rename') {
      const t = $('#heroTitle');
      t.contentEditable = 'true';
      t.focus();
      document.getSelection().selectAllChildren(t);
      const done = async (save) => {
        t.contentEditable = 'false';
        t.onkeydown = t.onblur = null;
        const title = t.textContent.trim();
        if (save && title && title !== ev.title) {
          Object.assign(ev, await api(`/api/events/${ev.id}`, { method: 'PATCH', body: { title } }));
          toast('Renamed');
        }
        paintHero();
      };
      t.onkeydown = (k) => {
        if (k.key === 'Enter') (k.preventDefault(), done(true));
        if (k.key === 'Escape') done(false);
      };
      t.onblur = () => done(true);
    } else if (act === 'resummarize') {
      b.disabled = true;
      b.classList.add('spin');
      Object.assign(ev, await api(`/api/events/${ev.id}/summarize`, { method: 'POST' }));
      paintHero();
      toast('Summary updated');
    } else if (act === 'delete') {
      if (!confirm('Remove this event? Its articles won’t be regrouped into it.')) return;
      await api(`/api/events/${ev.id}`, { method: 'DELETE' });
      location.hash = '#/';
      toast('Event removed');
    }
  } catch (err) {
    toast(err.message);
    paintHero();
  }
}

function paintTabs() {
  const ev = state.event;
  const running = ev.research.some((r) => r.status === 'running');
  const tabs = [
    ['coverage', `${icons.layers} Coverage`, ev.articleCount],
    ['dive', `${icons.dive} Deep dive`, running ? '…' : ev.research.length || ''],
    ['notes', `${icons.note} My notes`, ev.notes.length || ''],
  ];
  $('#tabs').innerHTML = tabs
    .map(([k, label, n]) => `<button class="tab ${state.tab === k ? 'on' : ''}" data-tab="${k}">${label}${n !== '' ? `<span class="n">${n}</span>` : ''}</button>`)
    .join('');
  $('#tabs').onclick = (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    state.tab = t.dataset.tab;
    paintTabs();
    paintTab();
  };
}

function paintTab() {
  const body = $('#tabBody');
  if (state.tab === 'coverage') body.innerHTML = coverageHTML();
  else if (state.tab === 'dive') body.innerHTML = diveHTML();
  else body.innerHTML = notesHTML();
  bindTab();
}

function coverageHTML() {
  const ev = state.event;
  const counts = {};
  for (const a of ev.articles) counts[a.lean || 'unknown'] = (counts[a.lean || 'unknown'] || 0) + 1;
  const order = [...LEANS, 'unknown'].filter((l) => counts[l]);
  const total = ev.articles.length || 1;
  const notes = ev.buildErrors?.length && !ev.building
    ? `<div class="notice">${icons.info}<div>${ev.buildErrors.map((x) => `<div>${esc(x)}</div>`).join('')}</div></div>`
    : '';
  const finding = `<div class="finding"><span class="live busy"></span><div><b>Looking for coverage…</b><div class="muted">Searching Bing News, Google News and GDELT, plus the articles already gathered. This can take up to a minute.</div></div></div>`;
  const empty = `<div class="empty-mini">
      <div class="empty-mini-art" aria-hidden="true"><i></i><i></i><i></i></div>
      <b>No articles yet</b>
      <span class="muted">Search the web for coverage, or paste a link below.</span>
      <button class="btn accent" data-find>${icons.search} Find coverage</button>
    </div>`;
  const spectrum = ev.articles.length
    ? `<div class="panel">
      <p class="section-label">Coverage by outlet lean</p>
      <div class="coverage">${order.map((l) => `<span class="${l}" style="flex:${counts[l]}" title="${leanLabel(l)}: ${counts[l]}"></span>`).join('')}</div>
      <div class="coverage-legend">${order
        .map((l) => `<span class="lean ${l}">${leanLabel(l)} · ${Math.round((counts[l] / total) * 100)}%</span>`)
        .join('')}</div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Lean ratings are approximate, based on public media-bias ratings.</p>
    </div>`
    : '';
  const track = ev.manual
    ? `<label class="switch" title="Add matching articles automatically on every refresh"><input type="checkbox" data-track ${ev.track ? 'checked' : ''}><span class="slider"></span><span>Keep tracking</span></label>`
    : '';
  return `
    ${spectrum}
    <div class="panel">
      <div class="panel-head">
        <p class="section-label" style="margin:0">Articles${ev.articles.length ? ` · ${ev.articles.length}` : ''}</p>
        <div class="panel-tools">${track}${ev.articles.length && !ev.building ? `<button class="btn sm" data-find>${icons.search} Find more coverage</button>` : ''}</div>
      </div>
      ${notes}
      ${ev.building ? finding : ''}
      <div class="article-list">
        ${ev.articles.length ? ev.articles.map(articleHTML).join('') : ev.building ? '' : empty}
      </div>
      <form class="inline-form" id="addArticle">
        <input class="input" name="url" type="url" placeholder="Paste an article link (https://…)" required />
        <button class="btn" type="submit">Add article</button>
      </form>
    </div>`;
}

function articleHTML(a) {
  return `<div class="article">
    <div class="thumb">${
      a.image
        ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(a.image)}" data-src="${esc(a.image)}" alt="" onerror="this.dataset.retried?this.remove():(this.dataset.retried=1,this.src='/api/img?u='+encodeURIComponent(this.dataset.src))">`
        : ''
    }</div>
    <div>
      <div class="meta"><b>${esc(a.source)}</b><span class="lean ${esc(a.lean || 'unknown')}">${leanLabel(a.lean)}</span><span>${timeAgo(a.publishedAt)}</span>${a.unreadable ? `<span title="This site blocks automated readers, so only the link was saved">link only</span>` : ''}</div>
      <h4><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h4>
      ${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
    </div>
    <div class="row-actions">
      <button class="btn sm ghost" data-dig="${a.id}" title="Dig deeper into this article">${icons.dive}</button>
      <a class="btn sm ghost" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" title="Open article">${icons.ext}</a>
      <button class="btn sm ghost danger" data-remove-article="${a.id}" title="Remove from this event">${icons.x}</button>
    </div>
  </div>`;
}

function diveHTML() {
  const ev = state.event;
  const running = ev.research.some((r) => r.status === 'running');
  const start = `
    <div class="panel dive-start">
      <div>
        <h3>Dig deeper</h3>
        <p class="muted" style="margin:-6px 0 0;font-size:14px">Searches for more reporting — prioritising wire services (AP, Reuters, AFP) and public broadcasters — reads it, and writes a neutral briefing that separates confirmed facts from claims, with citations.</p>
      </div>
      <form class="row" id="diveForm">
        <input class="input" id="diveFocus" name="focus" placeholder="Optional focus, e.g. “economic impact” or “who is responsible?”" />
        <button class="btn accent" type="submit" ${running ? 'disabled' : ''}>${icons.dive} ${running ? 'Researching…' : 'Start deep dive'}</button>
      </form>
    </div>`;
  const reports = ev.research.map((r, i) => reportHTML(r, i)).join('');
  return start + reports;
}

function reportHTML(r, i) {
  const pre = `src-${r.id}-`;
  const progress = r.progress || [];
  const inner =
    r.status === 'running'
      ? `<ul class="progress">${progress.map((p, j) => `<li class="${j === progress.length - 1 ? 'now' : 'done'}">${esc(p)}</li>`).join('')}</ul>`
      : r.status === 'error'
      ? `<p style="color:#dc2626">Deep dive failed: ${esc(r.error)}</p>`
      : `<div class="prose">${md(r.briefing, { citePrefix: pre })}</div>`;
  const sources = r.sources?.length
    ? `<details class="more" ${i === 0 ? 'open' : ''}><summary>Sources (${r.sources.length})</summary><div class="sources">${r.sources
        .map(
          (s) => `<a class="source" id="${pre}${s.n}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
            <span class="num">${s.n}</span>
            <span class="t"><b>${esc(s.name)}</b> — ${esc(s.title)}</span>
            <span class="tags">${s.neutral ? '<span class="tag-neutral">NEUTRAL</span>' : ''}<span class="lean ${esc(s.lean)}">${leanLabel(s.lean)}</span></span>
          </a>`
        )
        .join('')}</div></details>`
    : '';
  const heads = r.headlines?.length
    ? `<details class="more"><summary>Other headlines seen (${r.headlines.length})</summary><div class="sources">${r.headlines
        .map(
          (h) => `<a class="source" href="${esc(h.url)}" target="_blank" rel="noopener noreferrer"><span class="num">·</span><span class="t"><b>${esc(h.source)}</b> — ${esc(
            h.title
          )}</span><span class="tags">${h.neutral ? '<span class="tag-neutral">NEUTRAL</span>' : ''}</span></a>`
        )
        .join('')}</div></details>`
    : '';
  const body = `<div class="report-head"><span>${r.focus ? `Focus: <span class="focus">${esc(r.focus)}</span> · ` : ''}${timeAgo(r.createdAt)}${
    r.model ? ` · ${esc(r.model)}` : ''
  }</span>${r.status !== 'running' ? `<button class="btn sm ghost danger" data-del-report="${r.id}" title="Delete">${icons.trash}</button>` : ''}</div>${inner}${sources}${heads}`;
  if (i === 0) return `<div class="panel report">${body}</div>`;
  return `<details class="panel report"><summary style="cursor:pointer;font-weight:500">Earlier deep dive · ${esc(r.focus || 'general')} · ${timeAgo(r.createdAt)}</summary><div style="margin-top:12px">${body}</div></details>`;
}

function notesHTML() {
  const ev = state.event;
  return `
    <div class="panel">
      <h3>Your notes & custom data</h3>
      <p class="muted" style="margin:-6px 0 14px;font-size:14px">Anything you add here is saved with the event and used by the chat and deep dives. Add a label to keep structured facts (e.g. “Death toll”, “My take”, “Source to check”). Links are read automatically.</p>
      <div class="notes">${ev.notes.length ? ev.notes.map(noteHTML).join('') : ''}</div>
      <form class="note-form" id="noteForm">
        <div class="row">
          <input class="input" name="label" placeholder="Label (optional)" maxlength="60" />
          <input class="input" name="url" type="url" placeholder="Link (optional)" />
        </div>
        <textarea class="input" name="text" placeholder="Write a note, paste data or a quote…"></textarea>
        <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">Add note</button></div>
      </form>
    </div>`;
}

function noteHTML(n) {
  return `<div class="note" data-note="${n.id}">
    ${n.label ? `<div class="note-label">${esc(n.label)}</div>` : ''}
    ${n.text ? `<p class="note-text">${esc(n.text)}</p>` : ''}
    ${
      n.url
        ? `<a class="note-link" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${n.linkImage ? `<img src="${esc(n.linkImage)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : icons.ext}<span>${esc(
            n.linkTitle || n.url
          )}${n.linkError ? ` <span class="muted">(couldn't read page)</span>` : ''}</span></a>`
        : ''
    }
    <div class="note-foot"><span>${timeAgo(n.createdAt)}</span><span><button class="btn sm ghost" data-edit-note="${n.id}">${icons.edit}</button><button class="btn sm ghost danger" data-del-note="${n.id}">${icons.trash}</button></span></div>
  </div>`;
}

function bindTab() {
  const body = $('#tabBody');
  const ev = state.event;
  body.onclick = async (e) => {
    const t = e.target.closest('button, a.cite');
    if (!t) return;
    try {
      if (t.hasAttribute('data-find')) {
        Object.assign(ev, await api(`/api/events/${ev.id}/find`, { method: 'POST' }));
        ev.building = true;
        paintHero();
        paintTab();
        startEventPolling();
      } else if (t.dataset.dig) {
        await startDive({ articleId: t.dataset.dig });
      } else if (t.dataset.removeArticle) {
        await api(`/api/events/${ev.id}/articles/${t.dataset.removeArticle}`, { method: 'DELETE' });
        await loadEvent(ev.id);
        paintHero();
        paintTabs();
        paintTab();
        toast('Article removed from event');
      } else if (t.dataset.delNote) {
        await api(`/api/events/${ev.id}/notes/${t.dataset.delNote}`, { method: 'DELETE' });
        ev.notes = ev.notes.filter((n) => n.id !== t.dataset.delNote);
        paintTabs();
        paintTab();
      } else if (t.dataset.editNote) {
        const n = ev.notes.find((x) => x.id === t.dataset.editNote);
        const el = body.querySelector(`[data-note="${n.id}"]`);
        el.innerHTML = `<div class="note-form"><input class="input" name="label" value="${esc(n.label)}" placeholder="Label"><textarea class="input" name="text">${esc(
          n.text
        )}</textarea><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn sm" data-cancel>Cancel</button><button class="btn sm primary" data-save-note="${n.id}">Save</button></div></div>`;
        el.querySelector('textarea').focus();
      } else if (t.dataset.saveNote) {
        const el = t.closest('[data-note]');
        const updated = await api(`/api/events/${ev.id}/notes/${t.dataset.saveNote}`, {
          method: 'PATCH',
          body: { label: el.querySelector('[name=label]').value, text: el.querySelector('[name=text]').value },
        });
        Object.assign(ev.notes.find((x) => x.id === updated.id), updated);
        paintTab();
      } else if (t.hasAttribute('data-cancel')) {
        paintTab();
      } else if (t.dataset.delReport) {
        await api(`/api/events/${ev.id}/research/${t.dataset.delReport}`, { method: 'DELETE' });
        ev.research = ev.research.filter((r) => r.id !== t.dataset.delReport);
        paintTabs();
        paintTab();
      } else if (t.dataset.cite) {
        e.preventDefault();
        const target = document.getElementById(t.dataset.cite);
        if (target) {
          target.closest('details')?.setAttribute('open', '');
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.background = 'var(--accent-soft)';
          setTimeout(() => (target.style.background = ''), 1500);
        }
      }
    } catch (err) {
      toast(err.message);
    }
  };
  body.querySelector('[data-track]')?.addEventListener('change', async (e) => {
    try {
      Object.assign(ev, await api(`/api/events/${ev.id}`, { method: 'PATCH', body: { track: e.target.checked } }));
      toast(ev.track ? 'New matching articles will be added automatically' : 'Stopped tracking new articles');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#addArticle')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.textContent = state.status?.llm ? 'Reading & summarizing…' : 'Reading…';
    try {
      const added = await api(`/api/events/${ev.id}/articles`, { method: 'POST', body: { url: f.url.value } });
      await loadEvent(ev.id);
      paintHero();
      paintTabs();
      paintTab();
      toast(added.unreadable ? 'Added. That site blocks automated readers, so only the link was saved.' : 'Article added and summary updated');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Add article';
    }
  });
  $('#diveForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    startDive({ focus: e.target.focus.value });
  });
  $('#noteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = f.url.value ? 'Reading link…' : 'Saving…';
    try {
      const note = await api(`/api/events/${ev.id}/notes`, { method: 'POST', body: { label: f.label.value, text: f.text.value, url: f.url.value } });
      ev.notes.push(note);
      paintTabs();
      paintTab();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Add note';
    }
  });
}

async function startDive({ focus = '', articleId = null }) {
  const ev = state.event;
  try {
    await api(`/api/events/${ev.id}/research`, { method: 'POST', body: { focus, articleId } });
    await loadEvent(ev.id);
    state.tab = 'dive';
    paintTabs();
    paintTab();
    $('#tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
    startEventPolling();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Chat ----------

const SUGGESTIONS = ['What is confirmed so far, and what is still disputed?', 'How are different outlets framing this?', 'Give me the background I need to understand this.', 'What should I watch for next?'];

function paintChat() {
  const ev = state.event;
  const llm = state.status?.llm;
  $('#chat').innerHTML = `
    <div class="chat-head">
      <div><h3>Ask about this event</h3><div class="sub">Uses the articles, your notes and deep dives</div></div>
      <div class="chat-head-tools">
        ${ev.chat.length ? `<button class="btn sm ghost" id="clearChat" title="Clear conversation">${icons.trash}</button>` : ''}
        <button class="btn icon ghost mobile-only" id="chatClose" aria-label="Close chat">${icons.x}</button>
      </div>
    </div>
    <div class="chat-log" id="chatLog">${chatLogHTML()}</div>
    ${
      llm
        ? `<form class="chat-form" id="chatForm"><textarea class="input" name="m" rows="1" placeholder="Ask anything about this event…"></textarea><button class="btn primary icon" type="submit" aria-label="Send">${icons.send}</button></form>`
        : `<div class="chat-disabled">Chat needs an OpenRouter API key. Add <code>OPENROUTER_API_KEY</code> to <code>.env</code> and restart.</div>`
    }`;
  const log = $('#chatLog');
  log.scrollTop = log.scrollHeight;
  log.onclick = (e) => {
    const s = e.target.closest('[data-suggest]');
    if (s && llm) sendChat(s.textContent);
  };
  $('#chatClose')?.addEventListener('click', () => closeChatSheet());
  $('#clearChat')?.addEventListener('click', async () => {
    await api(`/api/events/${ev.id}/chat`, { method: 'DELETE' });
    ev.chat = [];
    paintChat();
  });
  const form = $('#chatForm');
  if (!form) return;
  const ta = form.m;
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = ta.value.trim();
    if (!m || state.chatBusy) return;
    ta.value = '';
    ta.style.height = 'auto';
    sendChat(m);
  });
}

// ---------- Mobile: chat as a full-screen sheet ----------
// On narrow screens the chat isn't an inline scrolling box (fingers got caught in it while
// scrolling the page). A compact bar opens it full-screen; ✕ or the back gesture closes it.

const isNarrow = () => matchMedia('(max-width: 1080px)').matches;

function openChatSheet({ focus = true } = {}) {
  const chat = $('#chat');
  if (!chat || chat.classList.contains('open')) return;
  chat.classList.add('open');
  document.body.classList.add('chat-open');
  history.pushState({ chatSheet: true }, '');
  const log = $('#chatLog');
  if (log) log.scrollTop = log.scrollHeight;
  if (focus) setTimeout(() => $('#chatForm textarea')?.focus(), 280);
}

function closeChatSheet({ fromHistory = false } = {}) {
  const chat = $('#chat');
  if (!chat || !chat.classList.contains('open')) return;
  chat.classList.remove('open');
  document.body.classList.remove('chat-open');
  document.activeElement?.blur?.();
  if (!fromHistory && history.state?.chatSheet) history.back();
}

window.addEventListener('popstate', () => closeChatSheet({ fromHistory: true }));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#chat')?.classList.contains('open')) closeChatSheet();
});

let askObserver;
function setupChatSheet() {
  $('#askBar').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-chat]')) openChatSheet();
  });
  $('#askDive').addEventListener('click', openDive);
  let fab = $('#chatFab');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'chatFab';
    fab.className = 'chat-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Ask about this event');
    fab.innerHTML = icons.chat;
    fab.addEventListener('click', () => openChatSheet());
    document.body.appendChild(fab);
  }
  // Show the floating button only once the ask bar has scrolled out of view.
  askObserver?.disconnect();
  askObserver = new IntersectionObserver(([entry]) =>
    fab.classList.toggle('show', !entry.isIntersecting && entry.boundingClientRect.top < 0 && location.hash.startsWith('#/event'))
  );
  askObserver.observe($('#askBar'));
}

function chatLogHTML() {
  const ev = state.event;
  if (!ev.chat.length)
    return `<div class="chat-empty"><span>Try asking:</span><div class="suggestions">${SUGGESTIONS.map((s) => `<button type="button" data-suggest>${esc(s)}</button>`).join('')}</div></div>`;
  return ev.chat
    .map((m) => (m.role === 'user' ? `<div class="msg user">${esc(m.content)}</div>` : `<div class="msg assistant"><div class="prose">${md(m.content)}</div></div>`))
    .join('');
}

async function sendChat(message) {
  const ev = state.event;
  if (state.chatBusy) return;
  state.chatBusy = true;
  ev.chat.push({ role: 'user', content: message });
  const log = $('#chatLog');
  log.innerHTML = chatLogHTML() + `<div class="msg assistant" id="streaming"><div class="typing"><i></i><i></i><i></i></div></div>`;
  log.scrollTop = log.scrollHeight;
  const out = $('#streaming');
  let text = '';
  try {
    const res = await fetch(`/api/events/${ev.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Chat failed');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) {
        if (!p.startsWith('data:')) continue;
        const msg = JSON.parse(p.slice(5));
        if (msg.error) throw new Error(msg.error);
        if (msg.t) {
          text += msg.t;
          out.innerHTML = `<div class="prose">${md(text)}</div>`;
          const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
          if (nearBottom) log.scrollTop = log.scrollHeight;
        }
      }
    }
    ev.chat.push({ role: 'assistant', content: text });
  } catch (err) {
    out.innerHTML = `<div class="prose" style="color:#dc2626">${esc(err.message)}</div>`;
    if (text) ev.chat.push({ role: 'assistant', content: text });
  } finally {
    state.chatBusy = false;
    if (!$('#clearChat')) paintChat();
  }
}

// ---------- Modals ----------

const modal = $('#modal');
function openModal(html, bind) {
  $('#modalBody').innerHTML = html;
  modal.showModal();
  bind?.($('#modalBody'));
  $('#modalBody [data-close]')?.addEventListener('click', () => modal.close());
}
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});

function newEventModal() {
  openModal(
    `<h2>New event</h2>
     <p class="lede">Track a story yourself. Give it a topic, paste some article links, or both.</p>
     <form id="newEvent" style="display:grid;gap:14px">
       <label class="field">Topic or title <input class="input" name="title" placeholder="e.g. City council housing vote" autofocus></label>
       <label class="field">What's it about? <span class="hint">Optional — helps find matching coverage</span><textarea class="input" name="description" rows="2"></textarea></label>
       <label class="field">Article links <span class="hint">One per line (optional)</span><textarea class="input" name="urls" rows="3" placeholder="https://…"></textarea></label>
       <label class="check"><input type="checkbox" name="autoFind" checked> <span>Automatically find more coverage<br><span class="muted" style="font-size:12.5px">Matches articles already gathered and searches the web for more</span></span></label>
       <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Create event</button></div>
     </form>`,
    (root) => {
      $('#newEvent', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const urls = f.urls.value.split(/\s+/).filter(Boolean);
        if (!f.title.value.trim() && !urls.length) return toast('Add a topic or at least one link');
        const btn = f.querySelector('[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Creating…';
        try {
          const ev = await api('/api/events', { method: 'POST', body: { title: f.title.value, description: f.description.value, urls, autoFind: f.autoFind.checked } });
          modal.close();
          state.tab = 'coverage';
          location.hash = `#/event/${ev.id}`;
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = 'Create event';
        }
      });
    }
  );
}

async function settingsModal() {
  const st = (state.status = await api('/api/status'));
  const report = st.refresh.lastReport || [];
  const feedStatus = (name) => report.find((r) => r.source === name);
  openModal(
    `<h2>Settings</h2>
     <p class="lede">${st.llm ? 'Connected to OpenRouter.' : 'No OpenRouter key found — AI features are off.'} Auto-refresh every ${st.refreshMinutes} min.</p>
     <form id="settingsForm" style="display:grid;gap:14px">
       <label class="field">Model <span class="hint">Used for grouping and summaries (OpenRouter model id)</span><input class="input" name="model" value="${esc(st.model)}"></label>
       <label class="field">Deep dive & chat model <span class="hint">Leave the same, or pick a stronger model for research</span><input class="input" name="researchModel" value="${esc(st.researchModel)}"></label>
       <div id="modelCheck" class="muted" style="font-size:13px"></div>
       <div class="modal-actions" style="justify-content:space-between"><button type="button" class="btn" id="checkModel">Check model</button><span style="display:flex;gap:8px"><button type="button" class="btn ghost" data-close>Close</button><button class="btn primary" type="submit">Save</button></span></div>
     </form>
     <div>
       <p class="section-label">News sources</p>
       <div class="feed-list">${st.feeds
         .filter((f, i, a) => a.findIndex((x) => x.name === f.name) === i)
         .map((f) => {
           const s = feedStatus(f.name);
           return `<span title="${s ? (s.ok ? s.count + ' articles' : 'Error: ' + esc(s.error)) : ''}" style="${s && !s.ok ? 'opacity:.5;text-decoration:line-through' : ''}"><span class="lean ${f.lean}"></span>${esc(f.name)}</span>`;
         })
         .join('')}</div>
       <p class="muted" style="font-size:12px;margin-top:10px">Deep dives also search GDELT, Google News and Wikipedia, preferring AP, Reuters, AFP, BBC, NPR, PBS and other wire services and public broadcasters.</p>
     </div>`,
    (root) => {
      $('#settingsForm', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        await api('/api/settings', { method: 'PUT', body: { model: f.model.value, researchModel: f.researchModel.value } });
        modal.close();
        toast('Settings saved');
      });
      $('#checkModel', root).addEventListener('click', async () => {
        const out = $('#modelCheck', root);
        out.textContent = 'Checking…';
        await api('/api/settings', { method: 'PUT', body: { model: root.querySelector('[name=model]').value } });
        const r = await api('/api/model-check');
        out.innerHTML =
          r.ok === true
            ? `✓ <b>${esc(r.model)}</b> is available on OpenRouter.`
            : r.ok === false
            ? `✗ <b>${esc(r.model)}</b> wasn't found.${r.suggestions?.length ? ` DeepSeek models available: ${r.suggestions.map((s) => `<code>${esc(s)}</code>`).join(', ')}` : ''}`
            : `Couldn't reach OpenRouter to check.`;
      });
    }
  );
}

// ---------- Global controls ----------

$('#today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
$('#newEventBtn').addEventListener('click', newEventModal);

// Theme: one button that cycles system -> light -> dark, remembered in this browser.
const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'match system', light: 'light', dark: 'dark' };
let themeMode = 'system';
function applyTheme(mode) {
  themeMode = THEMES.includes(mode) ? mode : 'system';
  const root = document.documentElement;
  if (themeMode === 'system') delete root.dataset.theme;
  else root.dataset.theme = themeMode;
  try {
    localStorage.setItem('theme', themeMode);
  } catch {}
  const btn = $('#themeToggle');
  btn.dataset.mode = themeMode;
  const next = THEMES[(THEMES.indexOf(themeMode) + 1) % 3];
  btn.title = `Theme: ${THEME_LABEL[themeMode]} (click for ${THEME_LABEL[next]})`;
  btn.setAttribute('aria-label', `Theme: ${THEME_LABEL[themeMode]}. Click to switch to ${THEME_LABEL[next]}.`);
  const dark = themeMode === 'dark' || (themeMode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#12110f' : '#f6f3ee');
}
try {
  themeMode = localStorage.getItem('theme') || 'system';
} catch {}
applyTheme(themeMode);
$('#themeToggle').addEventListener('click', () => {
  applyTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % 3]);
  toast(`Theme: ${THEME_LABEL[themeMode]}`);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) applyTheme('system');
});
$('#settingsBtn').addEventListener('click', () => settingsModal().catch((e) => toast(e.message)));
$('#refreshBtn').addEventListener('click', async () => {
  const b = $('#refreshBtn');
  b.classList.add('spin');
  try {
    await api('/api/refresh', { method: 'POST' });
    toast('Fetching the latest news…');
    if (location.hash.startsWith('#/event')) location.hash = '#/';
    else renderHome();
  } catch (e) {
    toast(e.message);
    b.classList.remove('spin');
  }
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    if (location.hash.startsWith('#/event')) location.hash = '#/';
    else renderHomeGrid();
  }, 150);
});

route();
