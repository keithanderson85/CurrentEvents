import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import { FEEDS } from './sources.js';
import { config } from './config.js';
import { fetchText, mapLimit, truncate } from './fetcher.js';
import { hashId } from './store.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  removeNSPrefix: false,
  isArray: (name) => ['item', 'entry', 'media:content', 'media:thumbnail', 'enclosure', 'link', 'category'].includes(name),
});

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  return v['#text'] != null ? String(v['#text']) : '';
};

const stripHtml = (s) => {
  if (!s) return '';
  if (!/[<&]/.test(s)) return s.trim();
  return cheerio.load(`<div>${s}</div>`)('div').text().replace(/\s+/g, ' ').trim();
};

const imgFromHtml = (s) => {
  if (!s || !s.includes('<img')) return null;
  const src = cheerio.load(s)('img').first().attr('src');
  return src && /^https?:/.test(src) ? src : null;
};

function pickImage(item) {
  const candidates = [];
  for (const key of ['media:content', 'media:thumbnail']) {
    for (const m of item[key] || []) {
      if (m['@url'] && (!m['@medium'] || m['@medium'] === 'image') && !/video/.test(m['@type'] || '')) {
        candidates.push({ url: m['@url'], w: Number(m['@width']) || 0 });
      }
      // media:group nesting
      for (const inner of m['media:content'] || []) if (inner['@url']) candidates.push({ url: inner['@url'], w: Number(inner['@width']) || 0 });
    }
  }
  for (const g of [].concat(item['media:group'] || [])) {
    for (const m of g['media:content'] || []) if (m['@url']) candidates.push({ url: m['@url'], w: Number(m['@width']) || 0 });
  }
  for (const e of item.enclosure || []) {
    if (e['@url'] && /image/.test(e['@type'] || 'image')) candidates.push({ url: e['@url'], w: 0 });
  }
  if (candidates.length) {
    // Prefer a mid-size image: big enough to look good, not a giant original.
    candidates.sort((a, b) => Math.abs((a.w || 600) - 700) - Math.abs((b.w || 600) - 700));
    return candidates[0].url;
  }
  return imgFromHtml(text(item['content:encoded'])) || imgFromHtml(text(item.description)) || null;
}

function linkOf(item) {
  if (item.link) {
    for (const l of item.link) {
      if (typeof l === 'string') return l.trim();
      if (l['@href'] && (!l['@rel'] || l['@rel'] === 'alternate')) return l['@href'];
      if (l['#text']) return l['#text'].trim();
    }
  }
  const guid = text(item.guid);
  return /^https?:/.test(guid) ? guid : '';
}

export function parseFeed(xml, feed) {
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item || doc?.['rdf:RDF']?.item || doc?.feed?.entry || doc?.channel?.item || [];
  const out = [];
  for (const item of items.slice(0, config.maxArticlesPerFeed)) {
    const url = linkOf(item);
    const title = stripHtml(text(item.title));
    if (!url || !title) continue;
    const dateRaw = text(item.pubDate) || text(item['dc:date']) || text(item.published) || text(item.updated);
    const date = dateRaw ? new Date(dateRaw) : null;
    const summary = truncate(stripHtml(text(item.description) || text(item.summary) || text(item['content:encoded'])), 400);
    out.push({
      id: hashId(url.replace(/[?#].*$/, '')),
      title,
      url,
      summary,
      image: pickImage(item),
      source: feed.name,
      sourceKey: feed.key,
      lean: feed.lean,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString(),
    });
  }
  return out;
}

export async function fetchFeed(feed) {
  const { text: xml } = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml, */*' });
  return parseFeed(xml, feed);
}

// Fetch every configured feed; returns { articles, report } where report lists per-feed counts/errors.
export async function fetchAllFeeds(feeds = FEEDS) {
  const results = await mapLimit(feeds, 6, async (f) => fetchFeed(f));
  const report = [];
  const seen = new Set();
  const articles = [];
  const cutoff = Date.now() - config.articleMaxAgeHours * 3600e3;
  results.forEach((r, i) => {
    if (!Array.isArray(r)) {
      report.push({ source: feeds[i].name, ok: false, error: r?.error });
      return;
    }
    report.push({ source: feeds[i].name, ok: true, count: r.length });
    for (const a of r) {
      const titleKey = a.title.toLowerCase();
      if (seen.has(a.id) || seen.has(titleKey)) continue; // same story in two feeds of one outlet
      if (new Date(a.publishedAt).getTime() < cutoff) continue;
      seen.add(a.id);
      seen.add(titleKey);
      articles.push(a);
    }
  });
  return { articles, report };
}
