
import { XMLParser } from 'fast-xml-parser';

const SOURCES = [
  { name: 'ایرنا', url: 'https://www.irna.ir/rss' },
  { name: 'ایسنا', url: 'https://www.isna.ir/rss' },
  { name: 'مهر', url: 'https://www.mehrnews.com/rss' },
  {
    name: 'تسنیم',
    url: 'https://www.tasnimnews.ir/fa/rss/feed/0/0/8/0/AllStories',
  },
  { name: 'خبرآنلاین', url: 'https://www.khabaronline.ir/rss' },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

function getText(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (value && typeof value === 'object') {
    return String(value['#text'] ?? value['#cdata'] ?? '');
  }

  return '';
}

function cleanText(value) {
  return getText(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCategory(value) {
  const result = cleanText(value);
  return result && result.length <= 250 ? result : null;
}

function getRssCategory(item) {
  const raw = item.category;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const categories = values
    .map(value => {
      if (typeof value === 'string' || typeof value === 'number') {
        return cleanCategory(value);
      }

      if (value && typeof value === 'object') {
        return cleanCategory(
          value['#text'] ??
          value['#cdata'] ??
          value['@_term'] ??
          value['@_label'] ??
          ''
        );
      }

      return null;
    })
    .filter(Boolean);

  return categories.length
    ? [...new Set(categories)].join(' | ')
    : null;
}

function getMetaContent(html, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const pattern = new RegExp(
      `\\b${attribute}\\s*=\\s*["']${escaped}["']`,
      'i'
    );

    if (!pattern.test(tag)) continue;

    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);

    if (content?.[1]) {
      return cleanCategory(content[1]);
    }
  }

  return null;
}

function getBreadcrumbCategory(breadcrumb) {
  if (typeof breadcrumb === 'string') {
    return cleanCategory(breadcrumb);
  }

  if (!breadcrumb || typeof breadcrumb !== 'object') {
    return null;
  }

  const items = Array.isArray(breadcrumb.itemListElement)
    ? breadcrumb.itemListElement
    : [];

  const names = items
    .map(entry => {
      const item = entry?.item;

      if (typeof item === 'string') return item;

      return item?.name || entry?.name || '';
    })
    .map(cleanCategory)
    .filter(Boolean)
    .filter(value => !/^(خانه|صفحه اصلی|home)$/i.test(value));

  return names.length ? names[names.length - 1] : null;
}

function findJsonLdCategory(value) {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonLdCategory(item);
      if (found) return found;
    }

    return null;
  }

  const section = cleanCategory(value.articleSection);

  if (section) return section;

  const mainEntity = value.mainEntityOfPage;

  if (mainEntity && typeof mainEntity === 'object') {
    const category = getBreadcrumbCategory(mainEntity.breadcrumb);

    if (category) return category;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findJsonLdCategory(child);
      if (found) return found;
    }
  }

  return null;
}

function getPageCategory(html) {
  const metaCandidates = [
    ['property', 'article:section'],
    ['name', 'article:section'],
    ['name', 'section'],
    ['property', 'og:article:section'],
  ];

  for (const [attribute, value] of metaCandidates) {
    const category = getMetaContent(html, attribute, value);

    if (category) return category;
  }

  const scripts = html.match(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  for (const script of scripts) {
    const json = script
      .replace(/^<script\b[^>]*>/i, '')
      .replace(/<\/script>$/i, '')
      .trim();

    try {
      const category = findJsonLdCategory(JSON.parse(json));

      if (category) return category;
    } catch {
      // JSON نامعتبر نادیده گرفته می‌شود.
    }
  }

  const itemprop = html.match(
    /<[^>]*itemprop=["']articleSection["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  );

  return itemprop?.[1]
    ? cleanCategory(itemprop[1])
    : null;
}

function getItems(data) {
  const items = data?.rss?.channel?.item;

  if (!items) return [];

  return Array.isArray(items) ? items : [items];
}

async function fetchPageCategory(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      return { category: null, reason: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') || '';

    if (
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      return { category: null, reason: 'پاسخ HTML نیست' };
    }

    const html = await response.text();

    if (
      /Just a moment|Checking your browser|cf-chl-|challenge-platform|در حال انتقال/i.test(html)
    ) {
      return { category: null, reason: 'صفحه واسط یا Cloudflare' };
    }

    return {
      category: getPageCategory(html),
      reason: 'بررسی صفحه انجام شد',
    };
  } catch (error) {
    return { category: null, reason: error.message };
  }
}

function testBreadcrumbParser() {
  const tests = [
    {
      name: 'Breadcrumb string',
      input: 'استانها > بوشهر',
      expected: 'استانها > بوشهر',
    },
    {
      name: 'BreadcrumbList object',
      input: {
        itemListElement: [
          {
            item: { name: 'بین الملل' },
            position: 1,
            '@type': 'ListItem',
          },
        ],
      },
      expected: 'بین الملل',
    },
  ];

  let failed = 0;

  console.log('\n========== LOCAL TESTS ==========');

  for (const test of tests) {
    const actual = getBreadcrumbCategory(test.input);
    const passed = actual === test.expected;

    console.log(
      `${passed ? 'PASS' : 'FAIL'} | ${test.name} | ` +
      `expected=${test.expected} | actual=${actual}`
    );

    if (!passed) failed++;
  }

  return failed;
}

async function testSource(source) {
  console.log('\n========================================');
  console.log(`SOURCE: ${source.name}`);
  console.log('========================================');

  try {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });

    console.log('RSS HTTP:', response.status);
    console.log(
      'RSS CONTENT TYPE:',
      response.headers.get('content-type')
    );

    if (!response.ok) {
      console.log('RESULT: RSS request failed');
      return;
    }

    const xml = await response.text();
    const data = parser.parse(xml);
    const items = getItems(data);

    console.log('RSS ITEMS:', items.length);

    if (!items.length) {
      console.log('RESULT: No RSS items found');
      return;
    }

    const item = items[0];
    const title = cleanText(item.title);
    const link = getText(item.link).trim();
    const rssCategory = getRssCategory(item);

    console.log('TITLE:', title);
    console.log('ARTICLE URL:', link);
    console.log('RSS CATEGORY:', rssCategory || 'NULL');

    let pageCategory = null;
    let pageReason = 'به دلیل وجود دسته در RSS بررسی نشد';

    if (!rssCategory && /^https?:\/\//i.test(link)) {
      const result = await fetchPageCategory(link);
      pageCategory = result.category;
      pageReason = result.reason;
    }

    console.log('PAGE CATEGORY:', pageCategory || 'NULL');
    console.log('PAGE RESULT:', pageReason);

    const finalCategory = rssCategory || pageCategory;

    console.log('FINAL SOURCE CATEGORY:', finalCategory || 'NULL');
    console.log(
      'CATEGORY ORIGIN:',
      rssCategory ? 'RSS' : pageCategory ? 'ARTICLE PAGE' : 'NONE'
    );
  } catch (error) {
    console.log('SOURCE ERROR:', error.message);
  }
}

async function main() {
  let failed = testBreadcrumbParser();

  for (const source of SOURCES) {
    await testSource(source);
  }

  console.log('\n========== TEST SUMMARY ==========');
  console.log('LOCAL TEST FAILURES:', failed);
  console.log('DATABASE ACCESS: DISABLED');
  console.log('DATABASE WRITES: NONE');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
