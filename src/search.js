import { XMLParser } from 'fast-xml-parser';
import { fetchText, truncate } from './fetcher.js';
import { domainOf, domainInfo } from './sources.js';
import { hashId } from './store.js';

// Web news search across several free, key-less sources. Each one fails often enough on its own
// (rate limits, bot checks, odd query syntax) that we always query several and merge.
//
//   - Bing News RSS: direct article links + thumbnail images. Usually the best single source.
//   - GDELT DOC 2.0: global news index with real article URLs and social images. Rate-limited.
//   - Google News RSS: very broad coverage, but links go through news.google.com redirects.

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (n) => n === 'item' });

// Endpoints can be overridden (used by the offline test server).
const BING = process.env.BING_NEWS_URL || 'https://www.bing.com/news/search';
const GNEWS = process.env.GOOGLE_NEWS_URL || 'https://news.google.com/rss/search';
const GDELT = process.env.GDELT_URL || 'https://api.gdeltproject.org/api/v2/doc/doc';

const STOP = new Set('a an the of in on at for to and or with about from by over into is are was were war s'.split(' '));

// GDELT rejects very short words and some punctuation; give it plain keywords.
export function gdeltQuery(q) {
  const words = q
    .replace(/["'()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  // Keep "war" etc. if that's all there is.
  const kept = words.length ? words : q.split(/\s+/).filter((w) => w.length > 2);
  return kept.join(' ');
}

export async function searchGdelt(query, { max = 40, timespan = '7d' } = {}) {
  const q = gdeltQuery(query);
  if (!q) return [];
  const url = `${GDELT}?query=${encodeURIComponent(`${q} sourcelang:english`)}&mode=artlist&maxrecords=${max}&format=json&sort=hybridrel&timespan=${timespan}`;
  const { text } = await fetchText(url, { timeout: 20000 });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // GDELT answers rate limits and query errors in plain text.
    throw new Error('GDELT: ' + truncate(text.trim(), 120));
  }
  return (data.articles || []).map((a) => ({
    title: a.title,
    url: a.url,
    domain: (a.domain || domainOf(a.url)).replace(/^www\./, ''),
    image: a.socialimage || null,
    date: parseGdeltDate(a.seendate),
    via: 'gdelt',
  }));
}

function parseGdeltDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

export async function searchBing(query, { max = 30 } = {}) {
  const url = `${BING}?q=${encodeURIComponent(query)}&format=rss&setlang=en-US&cc=US&qft=sortbydate%3d%221%22`;
  const { text } = await fetchText(url, { timeout: 12000, accept: 'application/rss+xml, application/xml, text/xml' });
  const items = xml.parse(text)?.rss?.channel?.item || [];
  return items.slice(0, max).map((it) => {
    let link = String(it.link || '');
    // Bing wraps links in apiclick.aspx?...&url=<real url>
    try {
      const real = new URL(link).searchParams.get('url');
      if (real) link = real;
    } catch {}
    const img = it['News:Image'] || it['news:image'] || null;
    return {
      title: stripTags(it.title),
      url: link,
      domain: domainOf(link),
      sourceName: it['News:Source'] || it['news:source'] || '',
      image: img ? String(img).replace(/&amp;/g, '&') + (String(img).includes('?') ? '&w=640' : '') : null,
      summary: truncate(stripTags(it.description), 300),
      date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      via: 'bing',
    };
  });
}

export async function searchGoogleNews(query, { when = '7d' } = {}) {
  const url = `${GNEWS}?q=${encodeURIComponent(`${query} when:${when}`)}&hl=en-US&gl=US&ceid=US:en`;
  const { text } = await fetchText(url, { timeout: 12000 });
  const items = xml.parse(text)?.rss?.channel?.item || [];
  return items.slice(0, 40).map((it) => {
    const src = it.source || {};
    const srcUrl = typeof src === 'object' ? src['@url'] : '';
    const sourceName = typeof src === 'object' ? src['#text'] : String(src);
    return {
      // Google appends " - Outlet" to titles.
      title: String(it.title || '').replace(/\s+-\s+[^-]+$/, ''),
      url: it.link,
      domain: domainOf(srcUrl || ''),
      sourceName,
      date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      via: 'googlenews',
    };
  });
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Search several sources for each query, merge and de-duplicate.
// Returns { results, errors } where results are sorted by source preference (direct links first).
export async function searchNews(queries, { timespan = '7d', perSource = 25 } = {}) {
  const qs = [...new Set(queries.map((q) => String(q || '').trim()).filter(Boolean))].slice(0, 3);
  const jobs = [];
  for (const q of qs) {
    jobs.push(['Bing News', q, searchBing(q, { max: perSource })]);
    jobs.push(['Google News', q, searchGoogleNews(q, { when: timespan })]);
  }
  // GDELT allows roughly one request every 5 seconds, so only the first query goes there.
  if (qs[0]) jobs.push(['GDELT', qs[0], searchGdelt(qs[0], { max: perSource, timespan })]);

  const settled = await Promise.allSettled(jobs.map((j) => j[2]));
  const errors = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  const results = [];
  const order = { bing: 0, gdelt: 1, googlenews: 2 };
  const all = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') all.push(...s.value);
    else errors.push(`${jobs[i][0]} (“${jobs[i][1]}”): ${s.reason?.message || 'failed'}`);
  });
  all.sort((a, b) => order[a.via] - order[b.via]);
  for (const r of all) {
    if (!r.url || !r.title) continue;
    const key = normTitle(r.title);
    if (seenUrl.has(r.url) || seenTitle.has(key)) continue;
    seenUrl.add(r.url);
    seenTitle.add(key);
    results.push(r);
  }
  return { results, errors };
}

// Turn a search result into an article record without needing to load the page.
export function articleFromResult(r, eventId) {
  const info = domainInfo(r.domain || r.url);
  const name = r.sourceName || info.name;
  const known = domainInfo(r.domain || '');
  return {
    id: hashId(String(r.url).replace(/[?#].*$/, '')),
    title: r.title,
    url: r.url,
    summary: r.summary || '',
    image: r.image || null,
    source: name,
    sourceKey: r.domain || name,
    lean: known.lean !== 'unknown' ? known.lean : leanFromName(name),
    publishedAt: r.date || new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    eventId,
    found: r.via,
  };
}

// Google News gives outlet names, not domains; map common ones to a lean.
function leanFromName(name) {
  const n = String(name || '').toLowerCase();
  const table = {
    'associated press': 'center', 'ap news': 'center', reuters: 'center', 'bbc': 'center', npr: 'lean-left', 'pbs': 'center',
    'the guardian': 'lean-left', 'new york times': 'lean-left', 'the new york times': 'lean-left', 'washington post': 'lean-left',
    'the washington post': 'lean-left', cnn: 'left', msnbc: 'left', 'nbc news': 'lean-left', 'cbs news': 'lean-left', 'abc news': 'lean-left',
    'fox news': 'right', 'new york post': 'lean-right', 'the wall street journal': 'center', 'wall street journal': 'center',
    'al jazeera': 'lean-left', 'al jazeera english': 'lean-left', 'the hill': 'center', axios: 'center', bloomberg: 'center',
    'dw': 'center', 'france 24': 'center', 'sky news': 'center', 'washington examiner': 'right', 'breitbart': 'right',
    'the times of israel': 'center', 'politico': 'lean-left', 'newsweek': 'center', 'usa today': 'lean-left', 'cnbc': 'center',
  };
  return table[n] || Object.entries(table).find(([k]) => n.startsWith(k))?.[1] || 'unknown';
}
