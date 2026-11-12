// Local stand-in for news feeds, article pages and OpenRouter, used for offline testing and screenshots.
// Run: node test/mock-server.js   (port 4100). All content is clearly fictional sample data.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4100);
const base = `http://localhost:${PORT}`;

const STORIES = [
  { key: 'storm', heads: ['Storm Elena makes landfall on Gulf coast, thousands without power', 'Hurricane Elena slams coast as officials urge residents to shelter', 'Elena landfall: power outages spread across coastal counties', 'Storm Elena brings flooding and record winds to Gulf coast', 'Gulf coast braces as Elena knocks out power to thousands', 'Elena: flooding and outages after overnight landfall'], hue: 205 },
  { key: 'rates', heads: ['Central bank holds interest rates steady, signals patience', 'Fed keeps interest rates unchanged amid cooling inflation', 'Interest rates held steady as central bank weighs slowing economy'], hue: 140 },
  { key: 'chip', heads: ['Northwind unveils new AI chip to rival industry leaders', 'Northwind AI chip launch targets data centre market', 'Investors cheer Northwind AI chip unveiling'], hue: 275 },
  { key: 'talks', heads: ['Peace talks resume in Geneva after months of stalemate', 'Geneva peace talks restart with ceasefire on agenda', 'Delegations return to Geneva as peace talks resume'], hue: 30 },
  { key: 'fire', heads: ['Wildfire forces evacuations in hills north of city', 'Fast-moving wildfire prompts evacuations, crews battle winds'], hue: 10 },
  { key: 'solo1', heads: ['Local library celebrates centennial with community festival'], hue: 90 },
  { key: 'solo2', heads: ['Marathon champion announces retirement after record career'], hue: 330 },
];
const SEARCH_DB = [
  { id: 'iran-ap', title: 'Iran conflict: strikes reported near Isfahan as tensions rise', source: 'Associated Press', terms: ['iran'], hue: 15 },
  { id: 'iran-reuters', title: 'Oil prices jump as Iran conflict escalates', source: 'Reuters', terms: ['iran'], hue: 45 },
  { id: 'iran-bbc', title: 'What we know about the fighting involving Iran', source: 'BBC News', terms: ['iran'], hue: 200 },
  { id: 'iran-fox', title: 'Lawmakers react to escalating Iran war', source: 'Fox News', terms: ['iran'], hue: 350 },
  { id: 'iran-recipe', title: 'Iranian saffron rice recipe for the holidays', source: 'Food Weekly', terms: ['iran'], hue: 60 },
];
const SOURCES = ['bbc', 'npr', 'fox', 'guardian', 'pbs', 'dw', 'nypost'];
const NAMES = { bbc: 'BBC News', npr: 'NPR', fox: 'Fox News', guardian: 'The Guardian', pbs: 'PBS NewsHour', dw: 'Deutsche Welle', nypost: 'New York Post' };
const LEANS = { bbc: 'center', npr: 'lean-left', fox: 'right', guardian: 'lean-left', pbs: 'center', dw: 'center', nypost: 'lean-right' };

function itemsFor(src) {
  const si = SOURCES.indexOf(src);
  const out = [];
  STORIES.forEach((s, k) => {
    const h = s.heads[si % s.heads.length];
    if (s.key.startsWith('solo') && si !== k % SOURCES.length) return;
    if (s.heads.length < 3 && si > 2) return;
    if (s.key !== 'storm' && si > 4) return;
    const id = `${s.key}-${src}`;
    out.push({ id, title: h, hue: (s.hue + si * 23) % 360, mins: 20 + k * 35 + si * 7, story: s.key });
  });
  return out;
}

function rss(src) {
  const items = itemsFor(src)
    .map((it, n) => {
      const img = `${base}/img/${it.id}.svg?h=${it.hue}`;
      // Some items carry media:content, one omits it to exercise the og:image fallback.
      const media = n === 1 ? '' : `<media:content url="${img}" medium="image" width="800"/>`;
      return `<item><title><![CDATA[${it.title}]]></title><link>${base}/article/${it.id}</link><guid>${base}/article/${it.id}</guid>
      <description><![CDATA[<p>Sample summary for “${it.title}”. This is fictional test content used to preview the layout.</p>]]></description>
      <pubDate>${new Date(Date.now() - it.mins * 60e3).toUTCString()}</pubDate>${media}</item>`;
    })
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${NAMES[src]}</title>${items}</channel></rss>`;
}

function svg(id, hue) {
  // A soft "photo-like" gradient scene so the patchwork reads like real headline images.
  const h2 = (hue + 40) % 360;
  const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const cx = 200 + (seed % 400);
  const cy = 120 + (seed % 140);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${h2},45%,28%)"/></linearGradient>
<radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="hsl(${hue},90%,92%)" stop-opacity=".9"/><stop offset="1" stop-color="hsl(${hue},90%,80%)" stop-opacity="0"/></radialGradient></defs>
<rect width="800" height="500" fill="url(#g)"/><circle cx="${cx}" cy="${cy}" r="170" fill="url(#s)"/>
<path d="M0 ${380 - (seed % 60)} Q200 ${300 + (seed % 50)} 400 ${360 - (seed % 40)} T800 ${330 + (seed % 70)} V500 H0Z" fill="hsl(${h2},35%,20%)" opacity=".75"/>
<path d="M0 ${430 - (seed % 30)} Q260 ${380 + (seed % 40)} 520 ${440 - (seed % 30)} T800 ${420} V500 H0Z" fill="hsl(${h2},30%,12%)" opacity=".85"/></svg>`;
}

function articlePage(id) {
  const [story, src] = id.split('-');
  const s = STORIES.find((x) => x.key === story);
  const hue = s ? s.hue : 200;
  const title = s ? s.heads[SOURCES.indexOf(src) % s.heads.length] : id;
  return `<!doctype html><html><head><title>${title}</title><meta property="og:title" content="${title}"><meta property="og:image" content="${base}/img/${id}.svg?h=${hue}">
  <meta property="og:description" content="Fictional sample article."></head><body><article>
  <p>This is a fictional sample article used to test the OpenFrame News app. It stands in for the full text of “${title}”.</p>
  <p>Officials said the situation was developing and that more information would be released later in the day, according to the sample report.</p>
  <p>Different outlets emphasised different details, which the app's deep dive is designed to compare side by side for the reader.</p></article></body></html>`;
}

function mockLLM(body) {
  const sys = body.messages.map((m) => m.content).join('\n');
  const last = [...body.messages].reverse().find((m) => m.role === 'user').content;
  if (/group news articles/.test(sys)) {
    // Group by the story keyword embedded in the headline's first distinctive word.
    const lines = last.split('NEW ARTICLES:\n')[1].split('\n');
    const keys = { storm: /Elena/, rates: /rates/i, chip: /chip/i, talks: /talks/i, fire: /wildfire/i };
    const titles = { storm: 'Storm Elena makes landfall on the Gulf coast', rates: 'Central bank holds interest rates steady', chip: 'Northwind unveils AI chip for data centres', talks: 'Geneva peace talks resume after stalemate', fire: 'Wildfire forces evacuations north of the city' };
    const cats = { storm: 'Climate', rates: 'Business', chip: 'Tech', talks: 'World', fire: 'US' };
    const events = Object.entries(keys)
      .map(([k, re]) => ({
        existing_id: null,
        title: titles[k],
        summary: `Sample summary: ${titles[k].toLowerCase()}. Outlets report the core facts consistently while differing in emphasis. (Fictional test data.)`,
        category: cats[k],
        articles: lines.map((l, i) => (re.test(l) ? Number(l.split('.')[0]) : null)).filter((x) => x !== null),
      }))
      .filter((e) => e.articles.length);
    return JSON.stringify({ events });
  }
  if (/turn a news topic into web news search queries/.test(sys)) {
    const topic = (last.match(/Topic: (.*)/) || [])[1] || '';
    return JSON.stringify({ queries: /iran/i.test(topic) ? ['Iran war', 'Iran strikes', 'Iran conflict oil'] : [topic] });
  }
  if (/deciding which articles belong/.test(sys)) {
    const lines = last.split('ARTICLES:\n')[1].split('\n');
    return JSON.stringify({ relevant: lines.map((l, i) => (/iran/i.test(l) && !/recipe/i.test(l) ? i : null)).filter((x) => x !== null) });
  }
  if (/plan research on a news event/.test(sys))
    return JSON.stringify({
      queries: ['storm elena landfall', 'elena power outages'],
      background: 'Tropical cyclone',
      questions: ['How many people lost power?', 'What is the forecast track?'],
      claims: ['Elena is the strongest Gulf storm in a decade', 'Warmer sea temperatures are making Gulf hurricanes intensify faster', 'More than 400,000 homes lost power'],
      evidence_queries: ['hurricane rapid intensification sea surface temperature', 'hurricane power outage restoration'],
    });
  if (/sceptical, even-handed news editor/.test(sys)) {
    const strong = /Elena|rates/i.test(last);
    return JSON.stringify({
      plain: 'A big storm hit the Gulf coast overnight. Hundreds of thousands of homes lost power and people were told to stay indoors. (Fictional test data.)',
      verdict: strong ? 'confirmed' : /talks/i.test(last) ? 'disputed' : 'developing',
      why: 'Six outlets across the spectrum report the same core facts, citing officials.',
      confirmed: ['The storm made landfall overnight.', 'Large numbers of homes lost power.', 'Officials told residents to shelter in place.'],
      unverified: ['One outlet calls it the strongest Gulf storm in a decade; no agency has said so.', 'The 400,000 outage figure comes from news reports, not the utility.'],
      spin: [
        { side: 'Left', framing: 'Stresses the link to climate change and warmer seas.' },
        { side: 'Right', framing: 'Focuses on how fast the federal response arrived and what it costs.' },
        { side: 'Center', framing: 'Sticks to official guidance and the forecast track.' },
      ],
      missing: 'No outlet says how long it will take to restore power.',
    });
  }
  if (/needs a web search/.test(sys)) {
    const q = (last.match(/QUESTION: (.*)/) || [])[1] || '';
    return JSON.stringify(/look up|latest|how many|study|history|iran/i.test(q) ? { search: true, queries: ['Iran war', 'hurricane rapid intensification'], research: true } : { search: false, queries: [] });
  }
  if (/WEB SEARCH RESULTS/.test(sys)) {
    const url = (sys.match(/\[W1\][^\n]*\nURL: (\S+)/) || [])[1] || 'https://example.org';
    return `I searched the web for this.\n\n- **From the web:** a fresh report covers the point you asked about [W1](${url}).\n- **From this event's articles:** outages are reported across outlets (1)(2).\n\n*(Mock reply for testing.)*`;
  }
  if (/select evidence for fact-checking/.test(sys)) {
    const lines = last.split('SOURCES:\n')[1].split('\n');
    return JSON.stringify({ relevant: lines.map((l, i) => (/unrelated/i.test(l) ? null : i)).filter((x) => x !== null) });
  }
  if (/neutral news summaries/.test(sys)) return JSON.stringify({ title: 'Sample event summary', summary: 'A sample neutral summary of the event. (Fictional.)', category: 'World' });
  if (/research analyst/.test(sys))
    return `## Bottom line\nStorm Elena made landfall on the Gulf coast, causing widespread outages [1][2]. Officials urged residents to shelter in place [3]. Research supports the link between warm water and faster strengthening, but not the "strongest in a decade" label [8][10].\n\n## What we know\n- Landfall occurred overnight, according to multiple outlets [1][2][3].\n- Thousands of homes lost power [1][4].\n\n## Evidence check\n- **Elena is the strongest Gulf storm in a decade** — **Unverified.** Only one outlet says this, and the agency storm records don't support it yet [5][10].\n- **Warmer seas make Gulf hurricanes intensify faster** — **Supported.** A peer-reviewed study of 1982–2020 storms found rapid intensification has become more frequent as sea surface temperatures rose [8].\n- **More than 400,000 homes lost power** — **Partly supported.** News reports give this figure [1][4]; the federal outage summary lists a lower preliminary count [9].\n\n## What the research and official records say\n- A 2023 study in *Nature Communications* links warmer Gulf waters to more frequent rapid intensification [8].\n- The Department of Energy's preliminary situation report lists outages by state [9].\n- A fact-check found the "strongest in a decade" claim has no basis in the official records so far [11].\n\n## Claims & disputed points\n- One outlet described the storm as the strongest in a decade; this is **not corroborated** by others [5].\n\n## Background\nGulf storms of this kind typically form in late summer [6].\n\n## How coverage differs\n- **BBC News** and **PBS** focus on official guidance [1][3]; **Fox News** emphasises the federal response [5].\n\n## Open questions\n- How long will restoration take?\n\n## Source quality note\nCore facts are consistent across wire-style and public-broadcaster sources. *(Fictional sample briefing.)*`;
  return `Here's what the sources say:\n\n- **Confirmed:** landfall and power outages are reported across outlets (1)(2).\n- **Disputed:** claims about storm strength vary [1].\n\n*(This is a mock reply for testing.)*`;
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, base);
    let m;
    if ((m = u.pathname.match(/^\/feeds\/(\w+)\.xml$/))) return res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(rss(m[1]));
    if ((m = u.pathname.match(/^\/img\/([\w-]+)\.svg$/))) return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg(m[1], Number(u.searchParams.get('h') || 200)));
    if ((m = u.pathname.match(/^\/article\/([\w-]+)$/))) return res.writeHead(200, { 'Content-Type': 'text/html' }).end(articlePage(m[1]));
    // Fake web search engines. "Bing" returns real-looking wrapped links + thumbnails; GDELT rate-limits.
    if (u.pathname === '/bing/news/search') {
      const q = u.searchParams.get('q') || '';
      const hits = SEARCH_DB.filter((h) => h.terms.some((t) => q.toLowerCase().includes(t)));
      const items = hits
        .map((h, i) => `<item><title>${h.title}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=${encodeURIComponent(`${base}/article/${h.id}`)}&amp;c=1</link>
        <description>${h.title} — sample search result.</description><pubDate>${new Date(Date.now() - (i + 1) * 3600e3).toUTCString()}</pubDate>
        <News:Source>${h.source}</News:Source><News:Image>${base}/img/${h.id}.svg?h=${h.hue}</News:Image></item>`)
        .join('');
      return res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(`<?xml version="1.0"?><rss xmlns:News="https://www.bing.com/news/search?q=&amp;format=rss"><channel>${items}</channel></rss>`);
    }
    if (u.pathname === '/gnews/rss/search') {
      const q = u.searchParams.get('q') || '';
      if (/site:/.test(q)) {
        // Site-restricted searches: government sites and fact-checkers.
        const ev = /politifact/.test(q)
          ? [{ t: 'Is Elena the strongest Gulf storm in a decade? No evidence yet', s: 'FactCheck.org', u: 'https://www.factcheck.org' }]
          : [
              { t: 'Hurricane Elena advisory archive', s: 'National Hurricane Center (.gov)', u: 'https://www.nhc.noaa.gov' },
              { t: 'Hurricane rapid intensification explained', s: 'National Weather Service (.gov)', u: 'https://www.weather.gov' },
              { t: 'An unrelated news story', s: 'Example News', u: 'https://www.example-news.com' },
            ];
        const xml = ev.map((e, i) => `<item><title>${e.t} - ${e.s}</title><link>https://news.google.com/rss/articles/EV${i}${encodeURIComponent(e.s)}</link><pubDate>${new Date().toUTCString()}</pubDate><source url="${e.u}">${e.s}</source></item>`).join('');
        return res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(`<rss><channel>${xml}</channel></rss>`);
      }
      const hits = SEARCH_DB.filter((h) => h.terms.some((t) => q.toLowerCase().includes(t))).slice(0, 2);
      const items = hits.map((h) => `<item><title>${h.title} - ${h.source}</title><link>https://news.google.com/rss/articles/CBM${h.id}</link><pubDate>${new Date().toUTCString()}</pubDate><source url="https://example.org">${h.source}</source></item>`).join('');
      return res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(`<rss><channel>${items}</channel></rss>`);
    }
    // Fake primary-source APIs (OpenAlex, Federal Register, Bing web search).
    if (u.pathname === '/openalex/works') {
      const abs = (t) => Object.fromEntries([...new Set(t.split(' '))].map((w) => [w, t.split(' ').flatMap((x, i) => (x === w ? [i] : []))]));
      const results = [
        { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1038/s41467-023-00001', title: 'Rapid intensification of Atlantic hurricanes has increased with warming sea surface temperatures', publication_year: 2023, cited_by_count: 214, primary_location: { source: { display_name: 'Nature Communications' }, landing_page_url: 'https://www.nature.com/articles/s41467-023-00001' }, abstract_inverted_index: abs('We analyse 1982 to 2020 Atlantic storms and find rapid intensification events have become more frequent as sea surface temperatures rose. (Fictional test abstract.)'), open_access: {} },
        { id: 'https://openalex.org/W2', title: 'An unrelated study of crop yields', publication_year: 2015, cited_by_count: 3, primary_location: { source: { display_name: 'Agronomy Journal' } }, abstract_inverted_index: abs('Crop yields vary with soil.'), open_access: {} },
      ];
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results }));
    }
    if (u.pathname === '/fedreg/documents.json') {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results: [{ title: 'Emergency declaration: Gulf coast hurricane response', abstract: 'Preliminary outage and response figures for affected states. (Fictional.)', html_url: 'https://www.federalregister.gov/documents/2026/11/10/2026-00001/gulf-hurricane', publication_date: '2026-11-10', type: 'Notice', agencies: [{ name: 'Department of Energy' }] }] }));
    }
    if (u.pathname === '/europepmc/search') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ resultList: { result: [] } }));
    if (u.pathname === '/govuk/search.json')
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results: [{ title: 'Storm overflows and flood response statistics', link: '/government/statistics/flood-response', description: 'Official statistics on flood response. (Fictional.)', public_timestamp: '2026-10-01T09:00:00Z', organisations: [{ title: 'Environment Agency' }] }] }));
    if (u.pathname === '/gdelt/api/v2/doc/doc') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Please limit requests to one every 5 seconds.');
    if (u.pathname === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash-1017' }] }));
    if (u.pathname === '/v1/chat/completions') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      // Behave like a "thinking" model: without reasoning turned off, JSON-mode answers come back empty.
      if (body.response_format && body.reasoning?.enabled !== false && !body.stream) {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '', reasoning: 'thinking…'.repeat(50) }, finish_reason: 'length' }] }));
      }
      const content = mockLLM(body);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': OPENROUTER PROCESSING\n\n');
        for (const chunk of content.match(/.{1,12}/gs)) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 15));
        }
        return res.end('data: [DONE]\n\n');
      }
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    res.writeHead(404).end('not found');
  })
  .listen(PORT, () => console.log(`mock server on ${base}`));

export const mockFeeds = SOURCES.map((k) => ({ key: k, name: NAMES[k], url: `${base}/feeds/${k}.xml`, lean: LEANS[k], kind: 'public' }));
