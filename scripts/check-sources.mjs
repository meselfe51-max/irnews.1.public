// Source reachability test (step 2 of the build plan).
// Runs on GitHub Actions (servers outside Iran) to see whether news sources
// answer, expose an RSS feed, and serve images to a foreign site.
// No dependencies, Node 18+.

import { readFileSync, appendFileSync } from 'node:fs';

const sources = JSON.parse(
  readFileSync(new URL('../sources.json', import.meta.url), 'utf8')
);

const UA = 'Mozilla/5.0 (compatible; NewsSourceCheck/1.0)';
const TIMEOUT_MS = 20000;
const COMMON_FEED_PATHS = ['/rss', '/rss.xml', '/feed', '/feed.xml', '/fa/rss'];

async function get(url, headers = {}, readBody = true) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = readBody ? await res.text() : '';
    if (!readBody) await res.body?.cancel();
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - start,
      type: res.headers.get('content-type') || '',
      text,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - start,
      type: '',
      text: '',
      error: String(e?.cause?.code || e?.message || e),
    };
  }
}

function discoverFeeds(html, baseUrl) {
  const found = [];
  const re = /<link\b[^>]*>/gi;
  for (const tag of html.match(re) || []) {
    if (!/type=["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const m = tag.match(/href=["']([^"']+)["']/i);
    if (!m) continue;
    try {
      found.push(new URL(m[1], baseUrl).href);
    } catch {}
  }
  return [...new Set(found)];
}

function parseFeed(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  const first = items[0] || '';
  const title = /<title\b/i.test(first);
  const link = /<link\b/i.test(first);
  let image = null;
  const patterns = [
    /<enclosure[^>]+url=["']([^"']+)["']/i,
    /<media:content[^>]+url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["']/i,
    /&lt;img[^&]+src=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = first.match(p);
    if (m) {
      image = m[1];
      break;
    }
  }
  return { count: items.length, title, link, image };
}

async function checkSource(src) {
  const r = { name: src.name };

  // 1) homepage
  const home = await get(src.homepage);
  r.home = home.ok ? `OK ${home.status} (${home.ms}ms)` : `FAIL ${home.status || home.error}`;

  // 2) find feed
  let feedUrl = src.rss_url;
  r.feedSource = feedUrl ? 'manual' : '';
  if (!feedUrl && home.ok) {
    const discovered = discoverFeeds(home.text, src.homepage);
    if (discovered.length) {
      feedUrl = discovered[0];
      r.feedSource = 'autodiscovery';
    }
  }
  if (!feedUrl) {
    for (const p of COMMON_FEED_PATHS) {
      const u = new URL(p, src.homepage).href;
      const t = await get(u);
      if (t.ok && /<(rss|feed)\b/i.test(t.text)) {
        feedUrl = u;
        r.feedSource = 'guessed path';
        break;
      }
    }
  }
  if (!feedUrl) {
    r.feed = 'NOT FOUND (put the RSS address in sources.json as rss_url)';
    r.verdict = 'FAIL';
    return r;
  }
  r.feedUrl = feedUrl;

  // 3) fetch feed
  const feed = await get(feedUrl);
  if (!feed.ok) {
    r.feed = `FAIL ${feed.status || feed.error}`;
    r.verdict = 'FAIL';
    return r;
  }
  const parsed = parseFeed(feed.text);
  r.feed = `OK ${feed.status} (${feed.ms}ms), items: ${parsed.count}, title: ${parsed.title}, link: ${parsed.link}`;
  if (parsed.count === 0) {
    r.verdict = 'FAIL';
    return r;
  }

  // 4) image test, with a foreign Referer (approximate hotlink check)
  if (!parsed.image) {
    r.image = 'no image found in first item';
    r.verdict = 'PARTIAL';
    return r;
  }
  const imgUrl = new URL(parsed.image, feedUrl).href;
  const img = await get(imgUrl, { Referer: 'https://example.org/' }, false);
  const isImage = /^image\//i.test(img.type);
  r.image = img.ok && isImage
    ? `OK ${img.status} ${img.type} (${img.ms}ms)`
    : `PROBLEM ${img.status || img.error} ${img.type}`;
  r.verdict = img.ok && isImage ? 'OK' : 'PARTIAL';
  return r;
}

const results = [];
for (const src of sources) {
  console.log(`Checking ${src.name} ...`);
  results.push(await checkSource(src));
}

const icon = { OK: '✅', PARTIAL: '⚠️', FAIL: '❌' };
let md = '# Source reachability test\n\n';
md += '| Source | Verdict | Homepage | Feed | Image |\n|---|---|---|---|---|\n';
for (const r of results) {
  md += `| ${r.name} | ${icon[r.verdict]} ${r.verdict} | ${r.home} | ${r.feed} | ${r.image || '-'} |\n`;
}
md += '\n## Feed addresses\n\n';
for (const r of results) {
  md += `- ${r.name}: ${r.feedUrl || '-'} (${r.feedSource || 'none'})\n`;
}
md +=
  '\nNotes: OK = feed and image reachable from this server. PARTIAL = feed works but image missing or blocked. ' +
  'FAIL = feed not reachable or not found. This test runs on a GitHub server; it does not prove Telegram can fetch the same images, ' +
  'and the fake Referer only approximates a real hotlink check.\n';

console.log('\n' + md);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
