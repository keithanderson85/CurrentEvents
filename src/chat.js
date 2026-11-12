import { db, save } from './store.js';
import { chatStream, chatJSON, currentModel } from './llm.js';
import { truncate, fetchArticle, mapLimit } from './fetcher.js';
import { searchNews } from './search.js';
import { searchWikipedia } from './research.js';
import { searchPapers, searchSites, searchWeb, sourceKind } from './evidence.js';
import { domainInfo, domainOf } from './sources.js';

// Builds the context the model sees when you chat with an event: its articles,
// your notes/custom data, and the latest deep-dive briefing.
export function eventContext(event) {
  const store = db();
  const articles = event.articleIds.map((id) => store.articles[id]).filter(Boolean);
  const arts = articles
    .slice(0, 25)
    .map((a, i) => `(${i + 1}) ${a.source} [${a.lean || 'unknown lean'}] — ${a.title}\n${truncate(a.text || a.summary || '', a.text ? 1500 : 400)}\n${a.url}`)
    .join('\n\n');
  const notes = (event.notes || [])
    .map((n) => {
      const head = n.label ? `${n.label}: ` : '';
      const body = n.text || '';
      const link = n.url ? `\n  (link: ${n.url}${n.linkTitle ? ' — ' + n.linkTitle : ''})${n.linkText ? '\n  ' + truncate(n.linkText, 1500) : ''}` : '';
      return `- ${head}${body}${link}`;
    })
    .join('\n');
  const latest = (event.research || []).find((r) => r.status === 'done' && r.briefing);
  const research = latest
    ? `${latest.briefing}\n\nBriefing sources:\n${latest.sources.map((s) => `[${s.n}] ${s.name} — ${s.title} (${s.url})`).join('\n')}`
    : '';
  return `EVENT: ${event.title}
CATEGORY: ${event.category || 'Other'}
SUMMARY: ${event.summary || '(none)'}

ARTICLES IN THIS EVENT:
${arts || '(none)'}
${notes ? `\nTHE USER'S OWN NOTES / CUSTOM DATA ON THIS EVENT:\n${notes}\n` : ''}${research ? `\nLATEST DEEP-DIVE BRIEFING:\n${research}\n` : ''}`;
}

const SYSTEM = `You are a sharp, even-handed news research assistant. The user is looking at one news event in their personal news dashboard and wants to discuss it.
- Ground answers in the provided articles, the user's notes and the briefing. Cite articles as (1), (2) etc. and briefing sources as [n].
- Clearly separate what is reported/verified from what is claimed, disputed or your own general knowledge. If you add general background knowledge, say so, and note it may be out of date.
- Be balanced: when outlets disagree, present the different accounts and who reports them.
- Be concise and use Markdown (short paragraphs, bullets). If the provided material and any web results can't answer something, say so and suggest running a Deep dive with a specific focus.`;

const WEB_RULES = `
- WEB SEARCH RESULTS were fetched just now for this question. Use them when the event's own material falls short. Cite each one you use as a Markdown link with its number, like [W1](url), using the exact URL given. Results marked "headline only" support only what the headline itself says.
- If the web results don't answer the question either, say so plainly rather than guessing.`;

// Decide whether the question needs a web search, and with what queries.
async function planWebSearch(event, history, message) {
  try {
    const r = await chatJSON(
      [
        {
          role: 'system',
          content:
            'You decide whether a question about a news event needs a web search. The assistant already has the event\'s articles, the user\'s notes and any briefing. Return JSON {"search":true|false,"queries":[1-2 short keyword queries, 3-7 words, no quotes or operators],"research":true|false}. Set search true when the question asks for facts, figures, history, people, later developments, definitions or evidence that the listed material is unlikely to cover, or when the user asks you to look something up. Set search false for opinions, summaries, comparisons or rewording of the material already provided. Set research true when studies, statistics or official data would help.',
        },
        {
          role: 'user',
          content: `EVENT: ${event.title}\nSUMMARY: ${truncate(event.summary || '', 500)}\nARTICLE HEADLINES:\n${event.articleIds
            .map((id) => db().articles[id]?.title)
            .filter(Boolean)
            .slice(0, 15)
            .map((t) => '- ' + t)
            .join('\n')}\n${history.length ? `\nRECENT CHAT:\n${history.slice(-4).map((m) => `${m.role}: ${truncate(m.content, 300)}`).join('\n')}\n` : ''}\nQUESTION: ${message}`,
        },
      ],
      { temperature: 0, maxTokens: 300 }
    );
    const queries = (r.queries || []).map(String).filter(Boolean).slice(0, 2);
    return { search: Boolean(r.search) && queries.length > 0, queries, research: Boolean(r.research) };
  } catch {
    return { search: false, queries: [], research: false };
  }
}

// Search news, Wikipedia and (when useful) research papers and fact-checkers; read the top pages.
export async function webSearch(plan, { have = new Set() } = {}) {
  const [news, wiki, papers, checks, web] = await Promise.allSettled([
    searchNews(plan.queries, { timespan: '30d', perSource: 8 }),
    searchWikipedia(plan.queries[0]),
    plan.research ? searchPapers(plan.queries[0], { max: 3 }) : [],
    searchSites(plan.queries[0], ['politifact.com', 'factcheck.org', 'snopes.com', 'fullfact.org', 'gov'], { max: 4 }),
    searchWeb(plan.queries[0], { max: 6 }), // empty unless a web search key is set
  ]);
  const val = (s, d) => (s.status === 'fulfilled' ? s.value : d);
  const hits = val(news, { results: [] }).results.filter((r) => !have.has(r.url));
  const readable = hits.filter((r) => r.via !== 'googlenews').slice(0, 5);
  const pages = await mapLimit(readable, 5, (r) => fetchArticle(r.url, { timeout: 9000 }));
  const out = [];
  // Full web results (official pages first), read in full.
  const webHits = val(web, [])
    .filter((r) => !have.has(r.url))
    .sort((a, b) => Number(a.kind === 'news') - Number(b.kind === 'news'))
    .slice(0, 4);
  const webPages = await mapLimit(webHits, 4, (r) => fetchArticle(r.url, { timeout: 9000 }));
  webHits.forEach((r, i) => {
    const text = webPages[i]?.text && webPages[i].text.length > 200 ? truncate(webPages[i].text, 1800) : r.text;
    out.push({ title: r.title, url: r.url, name: r.name, kind: r.kind, meta: r.meta, text: text || r.title, headlineOnly: !text });
  });
  readable.forEach((r, i) => {
    const text = pages[i]?.text && pages[i].text.length > 200 ? truncate(pages[i].text, 1800) : '';
    const info = domainInfo(r.domain || domainOf(r.url));
    out.push({ title: r.title, url: r.url, name: r.sourceName || info.name, kind: sourceKind(r.url), text: text || r.title, headlineOnly: !text });
  });
  for (const w of val(wiki, []).slice(0, 2)) out.push({ title: w.title, url: w.url, name: 'Wikipedia', kind: 'reference', text: truncate(w.text, 1500) });
  for (const p of val(papers, []).filter((x) => x.text).slice(0, 3)) out.push({ title: p.title, url: p.url, name: p.name, kind: 'study', meta: p.meta, text: truncate(p.text, 1200) });
  for (const c of val(checks, []).filter((x) => x.kind !== 'news' && x.title !== x.name).slice(0, 3))
    out.push({ title: c.title, url: c.url, name: c.name, kind: c.kind, meta: c.meta, text: c.title, headlineOnly: true });
  // A couple of extra headlines when little could be read in full.
  if (out.filter((o) => !o.headlineOnly).length < 3)
    for (const r of hits.filter((x) => x.via === 'googlenews').slice(0, 4)) out.push({ title: r.title, url: r.url, name: r.sourceName || domainInfo(r.domain || '').name, kind: 'news', text: r.title, headlineOnly: true });
  return out.slice(0, 12).map((o, i) => ({ n: i + 1, ...o }));
}

export async function streamChat(eventId, message, { onToken, onStatus = () => {}, onSources = () => {}, signal, web = true }) {
  const event = db().events[eventId];
  if (!event) throw new Error('Event not found');
  event.chat = event.chat || [];
  const history = event.chat.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  event.chat.push({ role: 'user', content: message, ts: new Date().toISOString() });
  save();

  let sources = [];
  if (web) {
    const plan = await planWebSearch(event, history, message);
    if (plan.search && !signal?.aborted) {
      onStatus(`Searching the web: ${plan.queries.join(' · ')}`);
      const have = new Set(event.articleIds.map((id) => db().articles[id]?.url).filter(Boolean));
      sources = await webSearch(plan, { have }).catch(() => []);
      if (sources.length) {
        onStatus(`Reading ${sources.length} result${sources.length === 1 ? '' : 's'}…`);
        onSources(sources.map(({ text, ...s }) => s));
      }
    }
  }
  const webBlock = sources.length
    ? `WEB SEARCH RESULTS (fetched now for the latest question):\n${sources
        .map((s) => `[W${s.n}] ${s.kind.toUpperCase()} — ${s.name}${s.meta ? ` (${s.meta})` : ''} — ${s.title}${s.headlineOnly ? ' (headline only)' : ''}\nURL: ${s.url}\n${s.headlineOnly ? '' : s.text}`)
        .join('\n\n')}`
    : '';
  const messages = [
    { role: 'system', content: SYSTEM + (sources.length ? WEB_RULES : '') },
    { role: 'system', content: eventContext(event) },
    ...history,
    ...(webBlock ? [{ role: 'system', content: webBlock }] : []),
    { role: 'user', content: message },
  ];
  let full = '';
  try {
    full = await chatStream(messages, { model: currentModel('research'), onToken, signal });
  } finally {
    if (full) {
      event.chat.push({ role: 'assistant', content: full, ts: new Date().toISOString(), ...(sources.length ? { sources: sources.map(({ text, ...s }) => s) } : {}) });
      save();
    }
  }
  return full;
}
