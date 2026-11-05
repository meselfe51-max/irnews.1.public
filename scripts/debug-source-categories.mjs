import { XMLParser } from 'fast-xml-parser';

const SOURCES = [
  { name: 'IRNA', rss: 'https://www.irna.ir/rss' },
  { name: 'ISNA', rss: 'https://www.isna.ir/rss' },
  { name: 'MEHR', rss: 'https://www.mehrnews.com/rss' },
  { name: 'TASNIM', rss: 'https://www.tasnimnews.ir/fa/rss/feed/0/0/8/0/AllStories' },
  { name: 'KHABARONLINE', rss: 'https://www.khabaronline.ir/rss' },
];

const SAMPLE_SIZE = 5;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; NewsCategoryDiagnostic/1.0)',
  Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

function text(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return String(value['#text'] ?? value['#cdata'] ?? '');
  return '';
}

function clean(value) {
  const result = text(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\\s+/g, ' ')
    .trim();
  return result && result.length <= 250 ? result : null;
}

function itemsFrom(data) {
  const found = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, child] of Object.entries(value)) {
      if (/^(item|entry)$/i.test(key)) {
        found.push(...(Array.isArray(child) ? child : [child]));
      } else if (child && typeof child === 'object') {
        walk(child);
      }
    }
  }
  walk(data);
  return found;
}

function itemLink(item) {
  const link = item.link;
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    const entry = link.find(x => typeof x === 'string' || x?.['@_href']);
    if (typeof entry === 'string') return entry;
    if (entry?.['@_href']) return entry['@_href'];
  }
  if (link?.['@_href']) return link['@_href'];
  const guid = item.guid;
  return typeof guid === 'string' && /^https?:\\/\\//i.test(guid) ? guid : null;
}

function rssCategory(item) {
  const raw = item.category;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const categories = values.map(value => {
    if (typeof value === 'string' || typeof value === 'number') return clean(value);
    if (value && typeof value === 'object') {
      return clean(value['#text'] ?? value['#cdata'] ?? value['@_term'] ?? value['@_label']);
    }
    return null;
  }).filter(Boolean);
  return categories.length ? [...new Set(categories)].join(' | ') : null;
}

function breadcrumbCategory(breadcrumb, articleUrl) {
  const entries = Array.isArray(breadcrumb?.itemListElement)
    ? breadcrumb.itemListElement
    : [];
  const crumbs = entries.map(entry => {
    const item = entry?.item;
    const url = typeof item === 'string' ? item : item?.['@id'] ?? item?.url ?? '';
    const name = typeof item === 'object' ? item?.name : entry?.name;
    return { name: clean(name), url: String(url) };
  }).filter(x => x.name && !/^(خانه|صفحه اصلی|home)$/i.test(x.name));

  if (!crumbs.length) return null;

  const article = crumbs.findIndex(x =>
    x.url && articleUrl && (
      x.url === articleUrl ||
      x.url.endsWith(new URL(articleUrl).pathname)
    )
  );

  if (article > 0) return crumbs[article - 1].name;
  if (crumbs.length > 1) return crumbs[crumbs.length - 2].name;
  return crumbs[0].name;
}

function jsonLdCategory(value, articleUrl) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = jsonLdCategory(entry, articleUrl);
      if (found) return found;
    }
    return null;
  }

  const section = clean(value.articleSection);
  if (section) return section;

  const breadcrumb = value.mainEntityOfPage?.breadcrumb ??
    (value['@type'] === 'BreadcrumbList' ? value : null);
  const fromBreadcrumb = breadcrumbCategory(breadcrumb, articleUrl);
  if (fromBreadcrumb) return fromBreadcrumb;

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = jsonLdCategory(child, articleUrl);
      if (found) return found;
    }
  }
  return null;
}

function pageCategory(html, articleUrl) {
  const tags = html.match(/<meta\\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/article:section|og:article:section|name=["']section["']/i.test(tag)) continue;
    const match = tag.match(/content=["']([^"']+)["']/i);
    if (match?.[1]) return clean(match[1]);
  }

  const scripts = html.match(/<script\\b[^>]*type=["']application\\/ld\\+json["'][^>]*>[\\s\\S]*?<\\/script>/gi) || [];
  for (const script of scripts) {
    const json = script.replace(/^<script\\b[^>]*>/i, '').replace(/<\\/script>$/i, '').trim();
    try {
      const found = jsonLdCategory(JSON.parse(json), articleUrl);
      if (found) return found;
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return null;
}

async function pageCategoryFor(url) {
  if (!url || !/^https?:\\/\\//i.test(url)) return { category: null, note: 'invalid article URL' };
  try {
    const response = await fetch(url, {
      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { category: null, note: `HTTP ${response.status}` };
    const html = await response.text();
    if (/Just a moment|Checking your browser|cf-chl-|challenge-platform/i.test(html)) {
      return { category: null, note: 'Cloudflare challenge' };
    }
    return { category: pageCategory(html, response.url), note: `HTTP ${response.status}` };
  } catch (error) {
    return { category: null, note: error.message };
  }
}

async function inspect(source) {
  console.log(`\\n=== ${source.name} ===`);
  try {
    const response = await fetch(source.rss, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
    const xml = await response.text();
    if (!/<(rss|feed)\\b/i.test(xml)) throw new Error('Response is not RSS/Atom XML');

    const news = itemsFrom(parser.parse(xml)).slice(0, SAMPLE_SIZE);
    console.log(`RSS items sampled: ${news.length}`);
    let rssCount = 0;
    let pageCount = 0;

    for (let index = 0; index < news.length; index++) {
      const item = news[index];
      const title = clean(item.title) || '(untitled)';
      const url = itemLink(item);
      let category = rssCategory(item);
      let method = 'RSS';

      if (category) {
        rssCount++;
      } else {
        const page = await pageCategoryFor(url);
        category = page.category;
        method = category ? 'ARTICLE_PAGE' : `NOT_FOUND (${page.note})`;
        if (category) pageCount++;
      }

      console.log(JSON.stringify({
        sample: index + 1,
        title,
        category,
        method,
      }));
    }

    console.log(`SUMMARY: RSS=${rssCount}, PAGE_FALLBACK=${pageCount}, MISSING=${news.length - rssCount - pageCount}`);
  } catch (error) {
    console.log(`SOURCE_ERROR: ${error.message}`);
  }
}

console.log('READ-ONLY CATEGORY TEST; DATABASE ACCESS: NONE');
for (const source of SOURCES) await inspect(source);
console.log('DIAGNOSTIC COMPLETE');
