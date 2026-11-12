// News sources used to build the front page.
//
// The mix is deliberate: wire services and public broadcasters (which tend to be the most
// neutral), plus outlets from across the political spectrum and from outside the US, so an
// event is seen through several lenses. `lean` is an approximate rating drawn from public
// media-bias ratings (AllSides / Ad Fontes style); treat it as a rough guide, not gospel.
//
// lean: 'left' | 'lean-left' | 'center' | 'lean-right' | 'right'
// kind: 'wire' | 'public' | 'newspaper' | 'broadcast' | 'digital'

const DEFAULT_FEEDS = [
  { key: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', lean: 'center', kind: 'public' },
  { key: 'bbc-top', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', lean: 'center', kind: 'public' },
  { key: 'npr', name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', lean: 'lean-left', kind: 'public' },
  { key: 'pbs', name: 'PBS NewsHour', url: 'https://www.pbs.org/newshour/feeds/rss/headlines', lean: 'center', kind: 'public' },
  { key: 'dw', name: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-en-all', lean: 'center', kind: 'public' },
  { key: 'france24', name: 'France 24', url: 'https://www.france24.com/en/rss', lean: 'center', kind: 'public' },
  { key: 'cbc', name: 'CBC News', url: 'https://www.cbc.ca/webfeed/rss/rss-world', lean: 'lean-left', kind: 'public' },
  { key: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lean: 'lean-left', kind: 'broadcast' },
  { key: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', lean: 'lean-left', kind: 'newspaper' },
  { key: 'nyt', name: 'New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', lean: 'lean-left', kind: 'newspaper' },
  { key: 'abc', name: 'ABC News', url: 'https://abcnews.go.com/abcnews/topstories', lean: 'lean-left', kind: 'broadcast' },
  { key: 'cbs', name: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main', lean: 'lean-left', kind: 'broadcast' },
  { key: 'cnbc', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', lean: 'center', kind: 'broadcast' },
  { key: 'wsj', name: 'Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', lean: 'center', kind: 'newspaper' },
  { key: 'thehill', name: 'The Hill', url: 'https://thehill.com/news/feed/', lean: 'center', kind: 'digital' },
  { key: 'sky', name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/world.xml', lean: 'center', kind: 'broadcast' },
  { key: 'fox', name: 'Fox News', url: 'https://moxie.foxnews.com/google-publisher/latest.xml', lean: 'right', kind: 'broadcast' },
  { key: 'nypost', name: 'New York Post', url: 'https://nypost.com/news/feed/', lean: 'lean-right', kind: 'newspaper' },
  { key: 'washexam', name: 'Washington Examiner', url: 'https://www.washingtonexaminer.com/feed/', lean: 'right', kind: 'digital' },
];

// FEEDS_FILE lets you swap in your own list (JSON array with the same fields).
import fs from 'node:fs';
export const FEEDS = process.env.FEEDS_FILE ? JSON.parse(fs.readFileSync(process.env.FEEDS_FILE, 'utf8')) : DEFAULT_FEEDS;

// Domains preferred during a deep dive: wire services, public broadcasters, and outlets
// with strong factual-reporting records and a near-center rating.
export const NEUTRAL_DOMAINS = {
  'apnews.com': { name: 'Associated Press', lean: 'center', kind: 'wire' },
  'reuters.com': { name: 'Reuters', lean: 'center', kind: 'wire' },
  'afp.com': { name: 'AFP', lean: 'center', kind: 'wire' },
  'bbc.com': { name: 'BBC News', lean: 'center', kind: 'public' },
  'bbc.co.uk': { name: 'BBC News', lean: 'center', kind: 'public' },
  'npr.org': { name: 'NPR', lean: 'lean-left', kind: 'public' },
  'pbs.org': { name: 'PBS NewsHour', lean: 'center', kind: 'public' },
  'dw.com': { name: 'Deutsche Welle', lean: 'center', kind: 'public' },
  'france24.com': { name: 'France 24', lean: 'center', kind: 'public' },
  'bloomberg.com': { name: 'Bloomberg', lean: 'center', kind: 'newspaper' },
  'csmonitor.com': { name: 'Christian Science Monitor', lean: 'center', kind: 'newspaper' },
  'axios.com': { name: 'Axios', lean: 'center', kind: 'digital' },
  'thehill.com': { name: 'The Hill', lean: 'center', kind: 'digital' },
  'wsj.com': { name: 'Wall Street Journal', lean: 'center', kind: 'newspaper' },
  'cnbc.com': { name: 'CNBC', lean: 'center', kind: 'broadcast' },
  'news.sky.com': { name: 'Sky News', lean: 'center', kind: 'broadcast' },
  'abc.net.au': { name: 'ABC Australia', lean: 'center', kind: 'public' },
  'cbc.ca': { name: 'CBC News', lean: 'lean-left', kind: 'public' },
};

// Extra lean info for domains that show up in searches but are not "neutral".
export const OTHER_DOMAINS = {
  'nytimes.com': { name: 'New York Times', lean: 'lean-left' },
  'washingtonpost.com': { name: 'Washington Post', lean: 'lean-left' },
  'theguardian.com': { name: 'The Guardian', lean: 'lean-left' },
  'cnn.com': { name: 'CNN', lean: 'left' },
  'msnbc.com': { name: 'MSNBC', lean: 'left' },
  'nbcnews.com': { name: 'NBC News', lean: 'lean-left' },
  'abcnews.go.com': { name: 'ABC News', lean: 'lean-left' },
  'cbsnews.com': { name: 'CBS News', lean: 'lean-left' },
  'aljazeera.com': { name: 'Al Jazeera', lean: 'lean-left' },
  'foxnews.com': { name: 'Fox News', lean: 'right' },
  'nypost.com': { name: 'New York Post', lean: 'lean-right' },
  'washingtonexaminer.com': { name: 'Washington Examiner', lean: 'right' },
  'dailywire.com': { name: 'Daily Wire', lean: 'right' },
  'breitbart.com': { name: 'Breitbart', lean: 'right' },
  'foxbusiness.com': { name: 'Fox Business', lean: 'right' },
  'newsweek.com': { name: 'Newsweek', lean: 'center' },
  'usatoday.com': { name: 'USA Today', lean: 'lean-left' },
  'politico.com': { name: 'Politico', lean: 'lean-left' },
  'ft.com': { name: 'Financial Times', lean: 'center' },
  'economist.com': { name: 'The Economist', lean: 'lean-left' },
};

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function domainInfo(domainOrUrl) {
  const d = domainOrUrl.includes('/') ? domainOf(domainOrUrl) : domainOrUrl.replace(/^www\./, '');
  const all = { ...OTHER_DOMAINS, ...NEUTRAL_DOMAINS };
  if (all[d]) return { domain: d, ...all[d], neutral: Boolean(NEUTRAL_DOMAINS[d]) };
  // Match subdomains, e.g. "edition.cnn.com" -> "cnn.com".
  const hit = Object.keys(all).find((k) => d.endsWith('.' + k));
  if (hit) return { domain: d, ...all[hit], neutral: Boolean(NEUTRAL_DOMAINS[hit]) };
  return { domain: d, name: d, lean: 'unknown', neutral: false };
}
