import { readFileSync, appendFileSync } from 'node:fs';

const SOURCES_FILE = new URL('../sources.json', import.meta.url);
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

async function fetchUrl(url) {
  const started = Date.now();

  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return {
    response,
    duration: Date.now() - started,
  };
}

function absoluteUrl(value, base) {
  try {
    return new URL(value.replace(/&amp;/g, '&'), base).href;
  } catch {
    return null;
  }
}

function discoverFeeds(html, siteUrl) {
  const urls = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];

  for (const tag of linkTags) {
    if (!/(rss|atom)\+xml/i.test(tag)) continue;

    const match = tag.match(/href=["']([^"']+)["']/i);

    if (match) {
      const url = absoluteUrl(match[1], siteUrl);
      if (url) urls.push(url);
    }
  }

  const hrefMatches = html.matchAll(
    /href=["']([^"']*(?:rss|feed)[^"']*)["']/gi
  );

  for (const match of hrefMatches) {
    const url = absoluteUrl(match[1], siteUrl);
    if (url) urls.push(url);
  }

  return [...new Set(urls)];
}

function inspectFeed(xml) {
  if (!/<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(xml)) {
    return null;
  }

  const items = xml.split(/<(?:item|entry)(?:\s|>)/i).slice(1);

  if (items.length === 0) {
    return null;
  }

  const first = items[0];

  return {
    items: items.length,
    hasTitle: /<title(?:\s|>)/i.test(first),
    hasLink:
      /<link(?:\s|>)/i.test(first) ||
      /<guid(?:\s|>)/i.test(first),
    itemBlocks: items,
  };
}

function extractImage(itemBlocks, feedUrl) {
  const patterns = [
    /<enclosure\b[^>]*url=["']([^"']+)["']/i,
    /<media:content\b[^>]*url=["']([^"']+)["']/i,
    /<media:thumbnail\b[^>]*url=["']([^"']+)["']/i,
    /<img\b[^>]*src=["']([^"']+)["']/i,
  ];

  for (const item of itemBlocks.slice(0, 10)) {
    for (const pattern of patterns) {
      const match = item.match(pattern);

      if (match) {
        const url = absoluteUrl(match[1], feedUrl);

        if (url && /^https?:\/\//i.test(url)) {
          return url;
        }
      }
    }
  }

  return null;
}

async function checkSource(source) {
  const result = {
    name: source.name || 'Unknown',
    enabled: source.enabled !== false,
    status: '✅ OK',
    site: '-',
    rss: '-',
    rssUrl: '',
    image: '-',
  };

  let siteUrl;

  try {
    siteUrl = new URL(source.site);

    if (!['http:', 'https:'].includes(siteUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    result.status = '❌ FAIL';
    result.site = 'Invalid site URL';
    result.rss = 'Not checked';
    result.image = 'Not checked';

    return result;
  }

  let siteHtml = '';

  try {
    const { response, duration } = await fetchUrl(source.site);

    result.site = `${response.status} (${duration}ms)`;

    if (response.ok) {
      siteHtml = await response.text();
    } else {
      result.status = '❌ FAIL';
    }
  } catch (error) {
    result.site = `ERROR: ${error.message}`;
    result.status = '❌ FAIL';
  }

  const candidates = [];

  if (source.rss_url) {
    candidates.push(source.rss_url);
  }

  if (siteHtml) {
    candidates.push(...discoverFeeds(siteHtml, source.site));
  }

  for (const path of [
    '/rss',
    '/fa/rss',
    '/rss.xml',
    '/feed',
    '/feed/rss',
  ]) {
    candidates.push(new URL(path, source.site).href);
  }

  let feed = null;
  const feedDiagnostics = [];

  for (const candidate of [...new Set(candidates)].slice(0, 12)) {
    try {
      const { response, duration } = await fetchUrl(candidate);

      if (!response.ok) {
        feedDiagnostics.push(`${candidate} -> HTTP ${response.status}`);
        continue;
      }

      const xml = await response.text();
      const parsed = inspectFeed(xml);

      if (parsed) {
        feed = {
          url: candidate,
          duration,
          ...parsed,
        };

        break;
      }
      feedDiagnostics.push(`${candidate} -> not RSS (${(response.headers.get('content-type') || 'unknown content-type')})`);
    } catch (error) {
      feedDiagnostics.push(`${candidate} -> ${error.message}`);
      // بررسی آدرس بعدی
    }
  }

  if (!feed) {
    result.rss = 'No valid RSS feed found';
    if (source.id === 'irna') {
      console.log(`  IRNA diagnostics: ${feedDiagnostics.slice(0, 6).join(' | ')}`);
    }
    result.image = 'Not checked';
    result.status = '❌ FAIL';

    return result;
  }

  result.rssUrl = feed.url;
  result.rss = `Valid (${feed.duration}ms), ${feed.items} entries`;

  if (!feed.hasTitle || !feed.hasLink) {
    result.status = '⚠️ PARTIAL';
  }

  const imageUrl = extractImage(feed.itemBlocks, feed.url);

  if (!imageUrl) {
    result.image = 'No image URL in feed';
    result.status = '⚠️ PARTIAL';

    return result;
  }

  try {
    const { response, duration } = await fetchUrl(imageUrl);

    const contentType =
      response.headers.get('content-type') || '';

    const validImage =
      response.ok &&
      contentType.toLowerCase().startsWith('image/');

    result.image =
      `${response.status} ` +
      `${contentType.split(';')[0]} ` +
      `(${duration}ms)`;

    try {
      await response.body?.cancel();
    } catch {
      // نادیده گرفتن خطای بستن اتصال
    }

    if (!validImage) {
      result.status = '⚠️ PARTIAL';
    }
  } catch (error) {
    result.image = `ERROR: ${error.message}`;
    result.status = '⚠️ PARTIAL';
  }

  return result;
}

let sources;

try {
  sources = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));

  if (!Array.isArray(sources)) {
    throw new Error('Expected an array in sources.json');
  }
} catch (error) {
  console.error(`Cannot read sources.json: ${error.message}`);
  process.exit(1);
}

const results = [];

console.log('\n========== NEWS SOURCES CHECK ==========\n');

for (const source of sources) {
  const result = await checkSource(source);

  results.push(result);

  console.log(
    `${result.status} ${result.name} [${result.enabled ? 'ENABLED' : 'DISABLED - DIAGNOSTIC ONLY'}]\n` +
    `  Site : ${result.site}\n` +
    `  RSS  : ${result.rss}\n` +
    `  URL  : ${result.rssUrl || '-'}\n` +
    `  Image: ${result.image}\n`
  );
}

const active = results.filter(item => item.enabled);
const activeSuccessful = active.filter(item => item.status === '✅ OK').length;
const activePartial = active.filter(item => item.status === '⚠️ PARTIAL').length;
const activeFailed = active.filter(item => item.status === '❌ FAIL').length;
const disabled = results.filter(item => !item.enabled);
const disabledWithFeed = disabled.filter(item => item.status === '✅ OK').length;

console.log('========== SUMMARY ==========');
console.log(`Total sources: ${results.length}`);
console.log(`Enabled sources: ${active.length}`);
console.log(`Enabled successful: ${activeSuccessful}`);
console.log(`Enabled partial: ${activePartial}`);
console.log(`Enabled failed: ${activeFailed}`);
console.log(`Disabled diagnostic checks: ${disabled.length}`);
console.log(`Disabled with valid feed: ${disabledWithFeed}`);

const summary = [
  '# News Sources Check',
  '',
  `- Total: ${results.length}`,
  `- Enabled: ${active.length}`,
  `- Enabled successful: ${activeSuccessful}`,
  `- Enabled partial: ${activePartial}`,
  `- Enabled failed: ${activeFailed}`,
  `- Disabled diagnostic checks: ${disabled.length}`,
  `- Disabled with valid feed: ${disabledWithFeed}`,
  '',
  '| Source | Enabled | Status | Site | RSS | Image |',
  '|---|---|---|---|---|---|',
  ...results.map(item =>
    `| ${item.name} | ${item.enabled ? 'yes' : 'no'} | ${item.status} | ${item.site} | ${item.rss} | ${item.image} |`
  ),
  '',
  '## RSS URLs',
  '',
  ...results.filter(item => item.rssUrl).map(item => `- ${item.name}: ${item.rssUrl}`),
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (activeFailed > 0 || activePartial > 0) {
  console.error('\n❌ One or more enabled sources need attention.');
  process.exitCode = 1;
} else {
  console.log('\n✅ All enabled sources passed. Disabled sources were checked for diagnostics only.');
}
