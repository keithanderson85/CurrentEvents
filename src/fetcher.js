import * as cheerio from 'cheerio';
import { config } from './config.js';

// Shared helpers for fetching web pages and pulling readable text / images out of them.

export async function fetchText(url, { timeout = 10000, accept = '*/*' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent, Accept: accept, 'Accept-Language': 'en' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { text: await res.text(), finalUrl: res.url || url, type: res.headers.get('content-type') || '' };
}

const absolutize = (u, base) => {
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
};

// Extracts title, lead image and main body text from an article page.
export function extractArticle(html, baseUrl) {
  const $ = cheerio.load(html);
  const meta = (sel) => $(sel).attr('content')?.trim();
  const title = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || $('title').first().text().trim();
  const imageRaw = meta('meta[property="og:image"]') || meta('meta[property="og:image:url"]') || meta('meta[name="twitter:image"]');
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]') || '';
  const published = meta('meta[property="article:published_time"]') || $('time[datetime]').first().attr('datetime') || '';

  $('script, style, noscript, nav, header, footer, aside, form, iframe, figure figcaption, [aria-hidden="true"]').remove();
  $('[class*="related"], [class*="newsletter"], [class*="promo"], [class*="advert"], [class*="share"], [id*="comments"]').remove();

  // Prefer the container with the most paragraph text.
  let best = null;
  let bestLen = 0;
  const candidates = $('article, main, [itemprop="articleBody"], [class*="article-body"], [class*="story-body"], [class*="content"]');
  (candidates.length ? candidates : $('body')).each((_, el) => {
    const len = $(el).find('p').text().length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  });
  const scope = best ? $(best) : $('body');
  const paras = scope
    .find('p')
    .map((_, p) => $(p).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t.length > 40);
  const text = [...new Set(paras)].join('\n\n');

  return {
    title,
    description,
    image: imageRaw ? absolutize(imageRaw, baseUrl) : null,
    published,
    text,
  };
}

export async function fetchArticle(url, opts) {
  const { text, finalUrl, type } = await fetchText(url, { accept: 'text/html,application/xhtml+xml', ...opts });
  if (type && !/html|xml/i.test(type)) throw new Error('Not an HTML page');
  return { url: finalUrl, ...extractArticle(text, finalUrl) };
}

// Run async fn over items with limited concurrency.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s || '');
