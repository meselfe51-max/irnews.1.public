
const SOURCES = [
  { name: 'IRNA', rss: 'https://www.irna.ir/rss' },
  { name: 'ISNA', rss: 'https://www.isna.ir/rss' },
  { name: 'MEHR', rss: 'https://www.mehrnews.com/rss' },
  {
    name: 'TASNIM',
    rss: 'https://www.tasnimnews.ir/fa/rss/feed/0/0/8/0/AllStories',
  },
  { name: 'KHABARONLINE', rss: 'https://www.khabaronline.ir/rss' },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; NewsCategoryDiagnostic/1.0)',
  Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
};

const CATEGORY_KEY =
  /category|section|subject|topic|taxonomy|breadcrumb|rubric|genre/i;

function log(title, value) {
  console.log(`\n--- ${title} ---`);
  console.log(
    typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2)
  );
}

function findCategoryFields(value, path = '', results = []) {
  if (!value || typeof value !== 'object') return results;

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findCategoryFields(item, `${path}[${index}]`, results)
    );
    return results;
  }

  for (const [key, child] of Object.entries(value)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (CATEGORY_KEY.test(key)) {
      results.push({ path: currentPath, value: child });
    }

    if (child && typeof child === 'object') {
      findCategoryFields(child, currentPath, results);
    }
  }

  return results;
}

function getItems(value, results = []) {
  if (!value || typeof value !== 'object') return results;

  if (Array.isArray(value)) {
    value.forEach(item => getItems(item, results));
    return results;
  }

  for (const [key, child] of Object.entries(value)) {
    if (/^(item|entry)$/i.test(key)) {
      if (Array.isArray(child)) results.push(...child);
      else results.push(child);
    } else if (child && typeof child === 'object') {
      getItems(child, results);
    }
  }

  return results;
}

function getLink(item) {
  const value = item.link;

  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry;
      if (entry?.['@_href']) return entry['@_href'];
    }
  }

  if (value?.['@_href']) return value['@_href'];

  return item.guid?.['#text'] || item.guid || item.id || null;
}

function extractHtmlEvidence(html) {
  const results = [];
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    if (CATEGORY_KEY.test(tag)) {
      results.push({ type: 'meta', value: tag });
    }
  }

  const scripts = html.match(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  for (const script of scripts) {
    if (CATEGORY_KEY.test(script)) {
      results.push({
        type: 'json-ld',
        value: script.slice(0, 12000),
      });
    }
  }

  const patterns = [
    /articleSection/gi,
    /article:section/gi,
    /breadcrumb/gi,
    /category/gi,
    /section/gi,
  ];

  const seen = new Set();

  for (const pattern of patterns) {
    let match;
    let count = 0;

    while ((match = pattern.exec(html)) && count < 8) {
      const start = Math.max(0, match.index - 180);
      const end = Math.min(html.length, match.index + 400);
      const snippet = html.slice(start, end);

      if (!seen.has(snippet)) {
        seen.add(snippet);
        results.push({ type: 'html-snippet', value: snippet });
      }

      count++;
    }
  }

  return results;
}

async function inspectSource(source) {
  console.log('\n\n========================================');
  console.log(`SOURCE: ${source.name}`);
  console.log('========================================');

  try {
    const response = await fetch(source.rss, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });

    const rssText = await response.text();

    log('RSS RESPONSE', {
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type'),
      bodyLength: rssText.length,
    });

    if (!response.ok) {
      log('RESULT', 'RSS request failed');
      return;
    }

    const items = getItems(
      new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
        trimValues: true,
      }).parse(rssText)
    );

    log('RSS ITEM COUNT', items.length);

    if (!items.length) {
      log('RESULT', 'No RSS items found');
      return;
    }

    const item = items[0];
    const articleUrl = getLink(item);

    log('FIRST RSS ITEM', item);
    log('RSS CATEGORY FIELDS', findCategoryFields(item));

    if (
      typeof articleUrl !== 'string' ||
      !/^https?:\/\//i.test(articleUrl)
    ) {
      log('ARTICLE URL', articleUrl);
      return;
    }

    log('ARTICLE URL', articleUrl);

    const articleResponse = await fetch(articleUrl, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });

    const html = await articleResponse.text();

    log('ARTICLE RESPONSE', {
      status: articleResponse.status,
      finalUrl: articleResponse.url,
      contentType: articleResponse.headers.get('content-type'),
      bodyLength: html.length,
    });

    log('HTML CATEGORY EVIDENCE', extractHtmlEvidence(html));
  } catch (error) {
    log('SOURCE ERROR', error.message);
  }
}

async function main() {
  console.log('FIVE-SOURCE CATEGORY DIAGNOSTIC');
  console.log('DATABASE ACCESS: DISABLED');

  for (const source of SOURCES) {
    await inspectSource(source);
  }

  console.log('\nALL SOURCES INSPECTED');
}

main().catch(error => {
  console.error('DIAGNOSTIC FAILED:', error);
  process.exitCode = 1;
});
