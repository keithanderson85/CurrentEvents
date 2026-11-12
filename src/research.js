import { db, save, newId, hashId } from './store.js';
import { chat, chatJSON, currentModel } from './llm.js';
import { hasLLM } from './config.js';
import { fetchText, fetchArticle, mapLimit, truncate } from './fetcher.js';
import { domainInfo, domainOf, NEUTRAL_DOMAINS } from './sources.js';
import { searchNews, searchGoogleNews } from './search.js';

// "Deep dive": go beyond the articles we already have, prioritising wire services and
// public broadcasters, then have the model write a neutral, cited briefing.
//
// Research sources (all free, no keys):
//   - Bing News + GDELT (see search.js): searches that return real article URLs.
//   - Google News RSS search: headline-level corroboration across many outlets.
//   - Wikipedia: background context.

export async function searchWikipedia(query) {
  const api = 'https://en.wikipedia.org/w/api.php';
  const { text } = await fetchText(`${api}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=2&format=json&origin=*`);
  const hits = JSON.parse(text)?.query?.search || [];
  if (!hits.length) return [];
  const titles = hits.map((h) => h.title).join('|');
  const { text: t2 } = await fetchText(
    `${api}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(titles)}&format=json&origin=*`
  );
  const pages = Object.values(JSON.parse(t2)?.query?.pages || {});
  return pages
    .filter((p) => p.extract)
    .map((p) => ({
      title: `Wikipedia: ${p.title}`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      domain: 'en.wikipedia.org',
      text: truncate(p.extract, 2500),
      via: 'wikipedia',
    }));
}

async function planQueries(event, articles, focus) {
  const fallback = { queries: [event.title], questions: [], background: event.title };
  if (!hasLLM()) return fallback;
  try {
    const r = await chatJSON(
      [
        {
          role: 'system',
          content:
            'You plan news research. Given a news event, return JSON {"queries":[2-3 short keyword search queries (3-6 words, no quotes or operators) likely to find more reporting on this exact event],"background":"a 1-4 word Wikipedia search term for background context","questions":[3-5 key open questions a careful reader would want answered]}.',
        },
        {
          role: 'user',
          content: `Event: ${event.title}\nSummary: ${event.summary}\nHeadlines:\n${articles
            .slice(0, 10)
            .map((a) => '- ' + a.title)
            .join('\n')}${focus ? `\n\nThe reader specifically wants to dig into: ${focus}` : ''}`,
        },
      ],
      { temperature: 0.2, maxTokens: 600 }
    );
    return {
      queries: (r.queries || []).filter(Boolean).slice(0, 3).length ? r.queries.slice(0, 3) : fallback.queries,
      questions: (r.questions || []).slice(0, 5),
      background: r.background || event.title,
    };
  } catch {
    return fallback;
  }
}

const LEAN_ORDER = ['center', 'lean-left', 'lean-right', 'left', 'right', 'unknown'];

export async function runDeepDive(eventId, { focus = '', articleId = null } = {}) {
  const store = db();
  const event = store.events[eventId];
  if (!event) throw new Error('Event not found');
  const report = {
    id: newId('rep_'),
    status: 'running',
    focus: focus || (articleId ? `This article: ${store.articles[articleId]?.title}` : ''),
    progress: [],
    sources: [],
    briefing: '',
    createdAt: new Date().toISOString(),
    model: hasLLM() ? currentModel('research') : null,
  };
  event.research = event.research || [];
  event.research.unshift(report);
  save();
  // Run in the background; the client polls the event to watch progress.
  deepDive(event, report, { focus: report.focus, articleId }).catch((e) => {
    report.status = 'error';
    report.error = e.message;
    save();
  });
  return report;
}

async function deepDive(event, report, { focus, articleId }) {
  const store = db();
  const step = (msg) => {
    report.progress.push(msg);
    save();
  };
  const own = event.articleIds.map((id) => store.articles[id]).filter(Boolean);

  step('Planning searches…');
  const plan = await planQueries(event, own, focus);
  report.queries = plan.queries;
  report.questions = plan.questions;

  step(`Searching news archives for: ${plan.queries.join(' · ')}`);
  const neutralSites = ['apnews.com', 'reuters.com', 'bbc.com', 'npr.org', 'pbs.org'];
  const [news, neutralNews, wiki] = await Promise.allSettled([
    searchNews(plan.queries),
    searchGoogleNews(`${plan.queries[0]} (${neutralSites.map((s) => 'site:' + s).join(' OR ')})`),
    searchWikipedia(plan.background),
  ]);
  const found = [
    ...(news.status === 'fulfilled' ? news.value.results : []),
    ...(neutralNews.status === 'fulfilled' ? neutralNews.value : []),
    ...(wiki.status === 'fulfilled' ? wiki.value : []),
  ];
  const failed = [...(news.status === 'fulfilled' ? news.value.errors : ['news search']), ...(neutralNews.status === 'rejected' ? ['Google News'] : []), ...(wiki.status === 'rejected' ? ['Wikipedia'] : [])];
  if (failed.length) step(`${failed.length} search request(s) did not respond; continuing with the rest.`);

  // Candidate pages to read in full. Event's own articles first (so we can compare framing),
  // then new pages from neutral outlets, then a few others for breadth.
  const seen = new Set(own.map((a) => a.url));
  const ownPicks = pickDiverse(
    articleId ? [store.articles[articleId], ...own.filter((a) => a.id !== articleId)].filter(Boolean) : own,
    6
  ).map((a) => ({ title: a.title, url: a.url, domain: domainOf(a.url), via: 'event', fallbackText: a.text || a.summary, name: a.source, lean: a.lean }));

  const external = found.filter((f) => (f.via === 'gdelt' || f.via === 'bing') && f.url && !seen.has(f.url) && (seen.add(f.url), true));
  const neutralExternal = external.filter((f) => domainInfo(f.domain).neutral);
  const otherExternal = external.filter((f) => !domainInfo(f.domain).neutral);
  const perDomain = new Map();
  const capDomain = (list, n) =>
    list.filter((f) => {
      const c = perDomain.get(f.domain) || 0;
      if (c >= 2) return false;
      perDomain.set(f.domain, c + 1);
      return true;
    }).slice(0, n);
  const toRead = [...ownPicks, ...capDomain(neutralExternal, 7), ...capDomain(otherExternal, 3)];

  step(`Reading ${toRead.length} articles (${neutralExternal.length ? 'prioritising wire services & public broadcasters' : 'no new neutral-outlet coverage found'})…`);
  const pages = await mapLimit(toRead, 6, async (c) => {
    const page = await fetchArticle(c.url, { timeout: 12000 });
    return { ...c, text: truncate(page.text, 3500) || c.fallbackText || '', image: page.image };
  });

  const docs = [];
  pages.forEach((p, i) => {
    const c = toRead[i];
    const textOk = p && !p.error && p.text && p.text.length > 200;
    const text = textOk ? p.text : c.fallbackText || '';
    if (!text && c.via !== 'event') return;
    docs.push({ ...c, text: text || c.title, fullText: Boolean(textOk) });
  });
  for (const w of found.filter((f) => f.via === 'wikipedia')) docs.push({ ...w, fullText: true });

  // Headline-only corroboration from Google News: many outlets, no full text.
  const headlines = found
    .filter((f) => f.via === 'googlenews' && f.title)
    .filter((f, i, arr) => arr.findIndex((g) => g.title === f.title) === i)
    .slice(0, 25);

  report.sources = docs.map((d, i) => {
    const info = domainInfo(d.domain || domainOf(d.url));
    return {
      n: i + 1,
      title: d.title,
      url: d.url,
      domain: info.domain,
      name: d.name || info.name,
      lean: d.lean || info.lean,
      neutral: info.neutral || (d.via === 'event' && d.lean === 'center'),
      via: d.via,
      fullText: d.fullText,
    };
  });
  report.headlines = headlines.map((h) => {
    const info = domainInfo(h.domain || '');
    return { title: h.title, url: h.url, source: h.sourceName || info.name, lean: info.lean, neutral: info.neutral };
  });
  save();

  if (!hasLLM()) {
    report.status = 'done';
    report.briefing =
      '_Add an OpenRouter API key to get an AI-written briefing. The sources gathered for this event are listed below._';
    step('Done (no API key: sources only).');
    return;
  }

  step(`Writing a neutral briefing from ${docs.length} sources…`);
  const userNotes = (event.notes || []).filter((n) => n.text).map((n) => `- ${n.text}`).join('\n');
  const sourceBlock = docs
    .map((d, i) => {
      const s = report.sources[i];
      return `[${i + 1}] ${s.name} (${s.lean}${s.neutral ? ', wire/public/high-factual' : ''}) — ${d.title}\n${d.text}`;
    })
    .join('\n\n---\n\n');

  const system = `You are a meticulous, non-partisan research analyst. Write a briefing on a news event using ONLY the numbered sources provided.
Principles:
- Separate verified facts (reported consistently by multiple independent sources, especially wire services and public broadcasters) from claims attributed to a single outlet or party.
- Attribute claims ("according to X", "officials said"). Never present one side's claim as fact.
- Cite sources inline with bracketed numbers like [1] or [2][5]. Every factual sentence needs a citation.
- Note where outlets frame the story differently (word choice, emphasis, what they omit), naming outlets.
- Use plain, neutral language. No speculation beyond flagging open questions.
Format as Markdown with these sections:
## Bottom line
(2-3 sentences)
## What we know
(bulleted, cited facts that are well corroborated)
## Claims & disputed points
(bulleted; who claims what, and what's contested or unverified)
## Background
## How coverage differs
(compare framing across outlets/leans)
## Open questions
## Source quality note
(1-2 sentences on how solid the sourcing is)`;

  const user = `EVENT: ${event.title}\nCURRENT SUMMARY: ${event.summary}${focus ? `\n\nREADER'S FOCUS: ${focus} — give this extra depth.` : ''}${
    plan.questions?.length ? `\n\nQUESTIONS TO ADDRESS IF THE SOURCES ALLOW:\n${plan.questions.map((q) => '- ' + q).join('\n')}` : ''
  }${userNotes ? `\n\nREADER'S OWN NOTES (context, not sources):\n${userNotes}` : ''}\n\nOTHER HEADLINES SEEN (headline only, for corroboration, not citable):\n${headlines
    .map((h) => `- (${h.sourceName || h.domain}) ${h.title}`)
    .join('\n')}\n\nSOURCES:\n${sourceBlock}`;

  report.briefing = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model: currentModel('research'), temperature: 0.2, maxTokens: 3500 }
  );
  report.status = 'done';
  step('Done.');
}

function pickDiverse(articles, n) {
  // Round-robin across leans so the comparison isn't one-sided.
  const buckets = new Map();
  for (const a of articles) {
    const lean = a.lean || domainInfo(a.url).lean;
    if (!buckets.has(lean)) buckets.set(lean, []);
    buckets.get(lean).push(a);
  }
  const order = LEAN_ORDER.filter((l) => buckets.has(l)).concat([...buckets.keys()].filter((l) => !LEAN_ORDER.includes(l)));
  const out = [];
  // Keep the first article (the focus) first if one was requested.
  if (articles[0]) out.push(articles[0]);
  while (out.length < n && order.some((l) => buckets.get(l).length)) {
    for (const l of order) {
      const a = buckets.get(l).shift();
      if (a && !out.includes(a)) out.push(a);
      if (out.length >= n) break;
    }
  }
  return out;
}

// Turn a URL into an article record (used for user-added links and manual events).
export async function articleFromUrl(url, eventId = null) {
  let page;
  try {
    page = await fetchArticle(url, { timeout: 12000 });
  } catch (e) {
    // Many outlets block automated readers (403, paywalls, bot checks). Keep the link anyway,
    // using a title made from the URL, so it still shows up in the event.
    page = { url, title: titleFromUrl(url), description: '', text: '', image: null, published: '', readError: e.message };
  }
  const info = domainInfo(page.url || url);
  return {
    id: hashId((page.url || url).replace(/[?#].*$/, '')),
    title: page.title || url,
    url: page.url || url,
    summary: truncate(page.description || page.text, 400),
    text: truncate(page.text, 6000),
    image: page.image,
    source: info.name,
    sourceKey: info.domain,
    lean: info.lean,
    publishedAt: safeDate(page.published),
    fetchedAt: new Date().toISOString(),
    eventId,
    manual: true,
    ...(page.readError ? { unreadable: true } : {}),
  };
}

function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const slug = u.pathname.split('/').filter(Boolean).reverse().find((p) => /[a-z]-[a-z]/i.test(p)) || '';
    const words = slug.replace(/\.[a-z]+$/i, '').replace(/-(?=[a-z]*\d)[a-z0-9]{6,}$/i, '').split(/[-_]+/).filter((w) => w && !/^\d+$/.test(w));
    if (words.length >= 3) {
      const t = words.join(' ');
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
    return `Article from ${u.hostname.replace(/^www\./, '')}`;
  } catch {
    return url;
  }
}

function safeDate(s) {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

export { NEUTRAL_DOMAINS };
