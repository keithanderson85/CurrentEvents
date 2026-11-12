import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/feeds.js';
import { parseJSONLoose } from '../src/llm.js';
import { clusterHeuristic, tokens } from '../src/cluster.js';
import { extractArticle } from '../src/fetcher.js';
import { domainInfo } from '../src/sources.js';

const feed = { key: 'x', name: 'Example', lean: 'center' };

test('parses RSS items with media images', () => {
  const xml = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
    <item><title>Hello &amp; world</title><link>https://ex.com/a?utm=1</link><description>&lt;p&gt;Body&lt;/p&gt;</description>
    <pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate><media:content url="https://ex.com/a.jpg" medium="image" width="800"/></item>
    <item><title>Second</title><link>https://ex.com/b</link><description><![CDATA[<img src="https://ex.com/b.jpg"> text]]></description></item>
  </channel></rss>`;
  const items = parseFeed(xml, feed);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Hello & world');
  assert.equal(items[0].image, 'https://ex.com/a.jpg');
  assert.equal(items[0].summary, 'Body');
  assert.equal(items[1].image, 'https://ex.com/b.jpg');
});

test('parses RDF and Atom feeds', () => {
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>RDF item</title><link>https://dw.com/x</link><dc:date>2026-11-10T10:00:00Z</dc:date></item></rdf:RDF>`;
  assert.equal(parseFeed(rdf, feed)[0].title, 'RDF item');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom item</title><link rel="alternate" href="https://ex.com/atom"/><updated>2026-11-10T10:00:00Z</updated></entry></feed>`;
  assert.equal(parseFeed(atom, feed)[0].url, 'https://ex.com/atom');
});

test('parses JSON wrapped in prose or code fences', () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('Sure! {"events":[]} hope that helps'), { events: [] });
});

test('heuristic clustering groups same-story headlines from different outlets', () => {
  const pool = [
    { id: '1', title: 'Earthquake strikes southern Turkey, killing dozens', source: 'A' },
    { id: '2', title: 'Deadly earthquake strikes southern Turkey', source: 'B' },
    { id: '3', title: 'Stock markets rally on tech earnings', source: 'C' },
  ];
  const groups = clusterHeuristic(pool, [], {});
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].articleIds.sort(), ['1', '2']);
  assert.ok(tokens('The earthquakes in Turkey').has('earthquake'));
});

test('extracts article text and og:image', () => {
  const html = `<html><head><meta property="og:image" content="/img.jpg"><title>T</title></head><body><nav><p>Menu menu menu menu menu menu menu menu menu</p></nav><article><p>${'Real paragraph text. '.repeat(5)}</p></article></body></html>`;
  const a = extractArticle(html, 'https://ex.com/story');
  assert.equal(a.image, 'https://ex.com/img.jpg');
  assert.match(a.text, /Real paragraph/);
  assert.doesNotMatch(a.text, /Menu/);
});

test('rates known domains', () => {
  assert.equal(domainInfo('https://apnews.com/article/x').neutral, true);
  assert.equal(domainInfo('https://edition.cnn.com/x').lean, 'left');
});
