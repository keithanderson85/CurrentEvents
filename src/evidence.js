import { XMLParser } from 'fast-xml-parser';
import { fetchText, fetchArticle, mapLimit, truncate } from './fetcher.js';
import { domainOf } from './sources.js';
import { chatJSON } from './llm.js';
import { hasLLM } from './config.js';

// Primary sources and evidence, so a deep dive can check what's being said against
// research, government records and official data, not just other news coverage.
// All free and key-less:
//   - OpenAlex: 250M+ scholarly works (journals, preprints, reports) with abstracts and citation counts.
//   - Federal Register: US rules, proposed rules, executive orders and agency notices.
//   - Bing web search limited to government, academic and international-body sites.
//   - Bing web search limited to established fact-checkers.

const OPENALEX = process.env.OPENALEX_URL || 'https://api.openalex.org/works';
const FEDREG = process.env.FEDREG_URL || 'https://www.federalregister.gov/api/v1/documents.json';
const BING_WEB = process.env.BING_WEB_URL || 'https://www.bing.com/search';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (n) => n === 'item' });

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

export async function searchWeb(query, { max = 10 } = {}) {
  const { text } = await fetchText(`${BING_WEB}?format=rss&setlang=en-US&q=${encodeURIComponent(query)}`, {
    timeout: 12000,
    accept: 'application/rss+xml, application/xml, text/xml',
  });
  const items = xml.parse(text)?.rss?.channel?.item || [];
  return items.slice(0, max).map((it) => {
    const url = String(it.link || '');
    return {
      title: String(it.title || '').trim(),
      url,
      domain: domainOf(url),
      name: domainOf(url),
      kind: sourceKind(url),
      text: truncate(String(it.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 400),
      via: 'web',
    };
  });
}

// ---------- Gathering ----------

const SITE_PRIMARY = '(site:gov OR site:edu OR site:int OR site:who.int OR site:un.org OR site:worldbank.org OR site:oecd.org OR site:europa.eu OR site:gov.uk)';
const SITE_FACTCHECK = `(${FACTCHECK_DOMAINS.slice(0, 4).map((d) => 'site:' + d).join(' OR ')})`;

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
    ['OpenAlex', searchOpenAlex(qs[0])],
    ...(qs[1] ? [['OpenAlex', searchOpenAlex(qs[1], { max: 5 })]] : []),
    ['Federal Register', searchFederalRegister(qs[0])],
    ['Government & official sites', searchWeb(`${qs[0]} ${SITE_PRIMARY}`)],
    ...(qs[1] ? [['Government & official sites', searchWeb(`${qs[1]} ${SITE_PRIMARY}`, { max: 6 })]] : []),
    ['Fact-checkers', searchWeb(`${topic} ${SITE_FACTCHECK}`, { max: 6 })],
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
    if (!c.url || !c.title || c.kind === 'news') return false;
    const k = c.url.replace(/[?#].*$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!candidates.length) return { docs: [], errors: [...new Set(errors)] };

  // Keep only what actually bears on this event's claims.
  const picked = await pickEvidence(candidates, { topic, claims });
  const chosen = picked.slice(0, 9);

  // Read the full pages of non-paper sources (papers already come with abstracts).
  step(`Reading ${chosen.length} primary source${chosen.length === 1 ? '' : 's'}…`);
  await mapLimit(
    chosen.filter((c) => c.kind !== 'study' && c.via !== 'federalregister'),
    4,
    async (c) => {
      const page = await fetchArticle(c.url, { timeout: 12000 });
      if (page.text && page.text.length > 300) {
        c.text = truncate(page.text, 3000);
        c.fullText = true;
      }
    }
  );
  return { docs: chosen.map((c) => ({ ...c, fullText: c.fullText ?? c.kind === 'study' })), errors: [...new Set(errors)] };
}

async function pickEvidence(candidates, { topic, claims }) {
  if (!hasLLM()) return candidates.sort(byKindPriority);
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
    return candidates.sort(byKindPriority);
  }
}

const KIND_PRIORITY = { factcheck: 0, gov: 1, official: 2, study: 3, research: 4, academic: 5, reference: 6, news: 7 };
const byKindPriority = (a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9);

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
