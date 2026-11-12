import { XMLParser } from 'fast-xml-parser';
import { fetchText, fetchArticle, mapLimit, truncate } from './fetcher.js';
import { domainOf } from './sources.js';
import { chatJSON } from './llm.js';
import { hasLLM } from './config.js';

// Primary sources and evidence, so a deep dive can check what's being said against
// research, government records and official data, not just other news coverage.
// All free and key-less:
//   - OpenAlex: 250M+ scholarly works with abstracts and citation counts (Crossref as a fallback).
//   - Europe PMC: life-science and health papers and preprints.
//   - Federal Register: US rules, proposed rules, executive orders and agency notices.
//   - GOV.UK: UK government publications, statistics and guidance.
//   - Google News search limited to government and international-body sites (press releases,
//     statistics releases, speeches), and to established fact-checkers.

const OPENALEX = process.env.OPENALEX_URL || 'https://api.openalex.org/works';
const OPENALEX_KEY = process.env.OPENALEX_API_KEY || '';
const CROSSREF = process.env.CROSSREF_URL || 'https://api.crossref.org/works';
const EUROPEPMC = process.env.EUROPEPMC_URL || 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const FEDREG = process.env.FEDREG_URL || 'https://www.federalregister.gov/api/v1/documents.json';
const GOVUK = process.env.GOVUK_URL || 'https://www.gov.uk/api/search.json';
const GNEWS = process.env.GOOGLE_NEWS_URL || 'https://news.google.com/rss/search';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (n) => n === 'item' });
const clean = (t) =>
  String(t || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const OFFICIAL_DOMAINS = [
  'who.int', 'un.org', 'unhcr.org', 'unicef.org', 'imf.org', 'worldbank.org', 'oecd.org', 'europa.eu', 'iaea.org',
  'wto.org', 'ipcc.ch', 'nato.int', 'icrc.org', 'gao.gov', 'cbo.gov', 'crsreports.congress.gov',
];
const FACTCHECK_DOMAINS = ['politifact.com', 'factcheck.org', 'snopes.com', 'fullfact.org', 'leadstories.com', 'checkyourfact.com', 'africacheck.org'];
const THINKTANK_DOMAINS = ['pewresearch.org', 'brookings.edu', 'rand.org', 'kff.org', 'cfr.org', 'csis.org', 'urban.org', 'aei.org', 'cato.org', 'heritage.org'];

// What kind of source is this? Used for labels and for weighting in the briefing.
export function sourceKind(urlOrDomain) {
  const d = (urlOrDomain.includes('/') ? domainOf(urlOrDomain) : urlOrDomain).toLowerCase();
  const is = (list) => list.some((x) => d === x || d.endsWith('.' + x));
  if (is(FACTCHECK_DOMAINS) || /\/(ap-fact-check|fact-check)\b/.test(urlOrDomain)) return 'factcheck';
  if (is(THINKTANK_DOMAINS)) return 'research';
  if (/\.(gov|mil)$/.test(d) || /\.gov\.[a-z]{2}$/.test(d) || d.endsWith('.gc.ca') || is(['gov.uk', 'parliament.uk'])) return 'gov';
  if (is(OFFICIAL_DOMAINS) || d.endsWith('.int')) return 'official';
  if (/\.edu$/.test(d) || /\.ac\.[a-z]{2}$/.test(d) || /\.edu\.[a-z]{2}$/.test(d)) return 'academic';
  if (d === 'en.wikipedia.org') return 'reference';
  if (/doi\.org$|arxiv\.org$|nature\.com$|science\.org$|thelancet\.com$|nejm\.org$|jamanetwork\.com$|bmj\.com$|ncbi\.nlm\.nih\.gov$|plos\.org$|springer\.com$|wiley\.com$|sciencedirect\.com$/.test(d))
    return 'study';
  return 'news';
}

// ---------- Searches ----------

export async function searchOpenAlex(query, { max = 8 } = {}) {
  const params = new URLSearchParams({
    search: query,
    'per-page': String(max),
    filter: 'from_publication_date:2010-01-01,has_abstract:true',
    select: 'id,doi,title,publication_year,primary_location,cited_by_count,abstract_inverted_index,open_access,type',
  });
  if (OPENALEX_KEY) params.set('api_key', OPENALEX_KEY);
  const { text } = await fetchText(`${OPENALEX}?${params}`, { timeout: 15000, accept: 'application/json' });
  const data = JSON.parse(text);
  return (data.results || []).map((w) => {
    const venue = w.primary_location?.source?.display_name || '';
    const url = w.open_access?.oa_url || w.primary_location?.landing_page_url || w.doi || w.id;
    return {
      title: w.title,
      url,
      domain: domainOf(url),
      name: venue || 'Research paper',
      kind: 'study',
      year: w.publication_year,
      citations: w.cited_by_count || 0,
      text: truncate(abstractFrom(w.abstract_inverted_index), 2200),
      meta: [venue, w.publication_year, w.cited_by_count ? `${w.cited_by_count} citations` : ''].filter(Boolean).join(' · '),
      via: 'openalex',
    };
  });
}

function abstractFrom(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(' ');
}

export async function searchFederalRegister(query, { max = 5 } = {}) {
  const params = new URLSearchParams({ 'conditions[term]': query, order: 'relevance', per_page: String(max) });
  for (const f of ['title', 'abstract', 'html_url', 'publication_date', 'agencies', 'type']) params.append('fields[]', f);
  const { text } = await fetchText(`${FEDREG}?${params}`, { timeout: 15000, accept: 'application/json' });
  const data = JSON.parse(text);
  return (data.results || []).map((d) => {
    const agency = (d.agencies || []).map((a) => a.name).filter(Boolean).join(', ');
    return {
      title: d.title,
      url: d.html_url,
      domain: 'federalregister.gov',
      name: agency ? `Federal Register (${agency})` : 'Federal Register',
      kind: 'gov',
      text: truncate(d.abstract || '', 2000),
      meta: [d.type, d.publication_date].filter(Boolean).join(' · '),
      via: 'federalregister',
    };
  });
}

// Crossref: used when OpenAlex is unavailable (it has a daily allowance per address).
export async function searchCrossref(query, { max = 8 } = {}) {
  const params = new URLSearchParams({
    query,
    rows: String(max),
    filter: 'has-abstract:true,from-pub-date:2010-01-01',
    select: 'DOI,title,container-title,issued,is-referenced-by-count,abstract,URL',
  });
  const { text } = await fetchText(`${CROSSREF}?${params}`, { timeout: 15000, accept: 'application/json' });
  return (JSON.parse(text).message?.items || []).map((w) => {
    const venue = clean(w['container-title']?.[0]);
    const year = w.issued?.['date-parts']?.[0]?.[0];
    const url = w.URL || `https://doi.org/${w.DOI}`;
    return {
      title: clean(w.title?.[0]),
      url,
      domain: domainOf(url),
      name: venue || 'Research paper',
      kind: 'study',
      text: truncate(clean(w.abstract), 2200),
      meta: [venue, year, w['is-referenced-by-count'] ? `${w['is-referenced-by-count']} citations` : ''].filter(Boolean).join(' · '),
      via: 'crossref',
    };
  });
}

export const searchPapers = (query, opts) => searchOpenAlex(query, opts).catch(() => searchCrossref(query, opts));

export async function searchEuropePmc(query, { max = 5 } = {}) {
  const params = new URLSearchParams({ query: `${query} AND HAS_ABSTRACT:y`, format: 'json', pageSize: String(max), resultType: 'core' });
  const { text } = await fetchText(`${EUROPEPMC}?${params}`, { timeout: 15000, accept: 'application/json' });
  return (JSON.parse(text).resultList?.result || []).map((w) => {
    const venue = w.journalInfo?.journal?.title || (w.source === 'PPR' ? 'Preprint' : '');
    const url = w.doi ? `https://doi.org/${w.doi}` : `https://europepmc.org/article/${w.source}/${w.id}`;
    return {
      title: clean(w.title),
      url,
      domain: domainOf(url),
      name: venue || 'Research paper',
      kind: 'study',
      text: truncate(clean(w.abstractText), 2200),
      meta: [venue, w.pubYear, w.citedByCount ? `${w.citedByCount} citations` : ''].filter(Boolean).join(' · '),
      via: 'europepmc',
    };
  });
}

export async function searchGovUk(query, { max = 4 } = {}) {
  const params = new URLSearchParams({ q: query, count: String(max), fields: 'title,link,description,public_timestamp,organisations' });
  const { text } = await fetchText(`${GOVUK}?${params}`, { timeout: 15000, accept: 'application/json' });
  return (JSON.parse(text).results || []).map((d) => {
    const org = (d.organisations || []).map((o) => o.title).filter(Boolean).slice(0, 2).join(', ');
    return {
      title: d.title,
      url: `https://www.gov.uk${d.link}`,
      domain: 'gov.uk',
      name: org ? `GOV.UK (${org})` : 'GOV.UK',
      kind: 'gov',
      text: truncate(d.description || '', 600),
      meta: (d.public_timestamp || '').slice(0, 10),
      via: 'govuk',
    };
  });
}

// Google News limited to particular sites. It indexes government press releases, statistics
// releases and speeches as well as fact-checkers. Links go through Google, so these come
// with the headline only; the reader can open them, and the title usually carries the finding.
export async function searchSites(query, sites, { max = 8 } = {}) {
  const q = `${query} (${sites.map((s) => 'site:' + s).join(' OR ')})`;
  const { text } = await fetchText(`${GNEWS}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { timeout: 12000 });
  const items = xml.parse(text)?.rss?.channel?.item || [];
  return items.slice(0, max).map((it) => {
    const src = it.source;
    const srcUrl = typeof src === 'object' ? src['@url'] || '' : '';
    const srcName = (typeof src === 'object' ? src['#text'] : src) || '';
    const domain = domainOf(srcUrl);
    return {
      title: clean(it.title).replace(new RegExp(`\\s+-\\s+${String(srcName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''),
      url: String(it.link || ''),
      domain,
      name: String(srcName).replace(/\s*\(\.gov\)$/, '') || domain,
      kind: sourceKind(domain),
      text: clean(it.title),
      meta: it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : '',
      via: 'sitesearch',
      fullText: false,
    };
  });
}

// ---------- Gathering ----------

const SITES_OFFICIAL = ['gov', 'who.int', 'un.org', 'europa.eu', 'worldbank.org', 'oecd.org', 'imf.org'];
const SITES_FACTCHECK = FACTCHECK_DOMAINS.slice(0, 4);

/**
 * Find primary sources for an event.
 * @param {object} p
 * @param {string[]} p.queries     Plain-language evidence queries (technical/policy wording).
 * @param {string[]} p.claims      Specific factual claims from coverage to check.
 * @param {string}   p.topic       Event title (for relevance filtering).
 * @param {(m: string) => void} p.step  Progress callback.
 */
export async function gatherEvidence({ queries, claims = [], topic, step = () => {} }) {
  const qs = [...new Set(queries.filter(Boolean))].slice(0, 2);
  if (!qs.length) return { docs: [], errors: [] };
  step(`Searching research papers, government records and fact-checkers for: ${qs.join(' · ')}`);

  const jobs = [
    ['Research papers', searchPapers(qs[0])],
    ...(qs[1] ? [['Research papers', searchPapers(qs[1], { max: 5 })]] : []),
    ['Europe PMC', searchEuropePmc(qs[0])],
    ['Federal Register', searchFederalRegister(qs[0])],
    ['GOV.UK', searchGovUk(qs[0])],
    ['Government & official sites', searchSites(qs[0], SITES_OFFICIAL)],
    ...(qs[1] ? [['Government & official sites', searchSites(qs[1], SITES_OFFICIAL, { max: 5 })]] : []),
    ['Fact-checkers', searchSites(topic, SITES_FACTCHECK, { max: 6 })],
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  const errors = [];
  let candidates = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') candidates.push(...s.value);
    else errors.push(jobs[i][0]);
  });
  // De-duplicate and drop plain news results from the web searches.
  const seen = new Set();
  candidates = candidates.filter((c) => {
    if (!c.url || !c.title || c.kind === 'news' || c.title === c.name) return false;
    const k = c.url.replace(/[?#].*$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!candidates.length) return { docs: [], errors: [...new Set(errors)] };

  // Keep only what actually bears on this event's claims.
  const picked = await pickEvidence(candidates, { topic, claims });
  const chosen = picked.slice(0, 9);

  // Papers and Federal Register entries come with abstracts; GOV.UK pages are read in full.
  step(`Using ${chosen.length} primary source${chosen.length === 1 ? '' : 's'} of ${candidates.length} found…`);
  await mapLimit(
    chosen.filter((c) => c.via === 'govuk'),
    4,
    async (c) => {
      const page = await fetchArticle(c.url, { timeout: 12000 });
      if (page.text && page.text.length > 300) {
        c.text = truncate(page.text, 3000);
        c.fullText = true;
      }
    }
  );
  return { docs: chosen.map((c) => ({ ...c, fullText: c.fullText ?? true })), errors: [...new Set(errors)] };
}

async function pickEvidence(candidates, { topic, claims }) {
  if (!hasLLM()) return interleave(candidates);
  try {
    const r = await chatJSON(
      [
        {
          role: 'system',
          content:
            'You select evidence for fact-checking a news story. Return JSON {"relevant":[indexes]} of the sources that contain data, findings, official records or fact-checks that directly bear on the story or its claims. Exclude sources about a different subject that merely share keywords. Prefer recent, specific, authoritative sources. Order from most to least useful, at most 9.',
        },
        {
          role: 'user',
          content: `STORY: ${topic}\n${claims.length ? `CLAIMS TO CHECK:\n${claims.map((c) => '- ' + c).join('\n')}\n` : ''}\nSOURCES:\n${candidates
            .map((c, i) => `${i}. [${c.kind}] ${c.name}: ${c.title}${c.meta ? ` (${c.meta})` : ''} — ${truncate(c.text, 220)}`)
            .join('\n')}`,
        },
      ],
      { temperature: 0, maxTokens: 400 }
    );
    const idx = [...new Set((r.relevant || []).map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length);
    return idx.map((n) => candidates[n]);
  } catch {
    return interleave(candidates);
  }
}

const KIND_PRIORITY = { factcheck: 0, gov: 1, official: 2, study: 3, research: 4, academic: 5, reference: 6, news: 7 };
// Without the AI filter: take the first result of each kind, then the second of each, and so on.
function interleave(list) {
  const groups = {};
  for (const c of list) (groups[c.kind] ||= []).push(c);
  const kinds = Object.keys(groups).sort((x, y) => (KIND_PRIORITY[x] ?? 9) - (KIND_PRIORITY[y] ?? 9));
  const out = [];
  for (let i = 0; out.length < list.length; i++) for (const k of kinds) if (groups[k][i]) out.push(groups[k][i]);
  return out;
}

export const KIND_LABEL = {
  study: 'Study',
  gov: 'Government',
  official: 'Official body',
  factcheck: 'Fact-check',
  research: 'Research org',
  academic: 'Academic',
  reference: 'Reference',
  news: 'News',
};
