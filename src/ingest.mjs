```javascript
import postgres from 'postgres';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL تنظیم نشده است.');
}

const sql = postgres(databaseUrl, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

const SOURCES = [
  { name: 'ایرنا', rss_url: 'https://www.irna.ir/rss' },
  { name: 'ایسنا', rss_url: 'https://www.isna.ir/rss' },
  { name: 'مهر', rss_url: 'https://www.mehrnews.com/rss' },
  {
    name: 'تسنیم',
    rss_url: 'https://www.tasnimnews.ir/fa/rss/feed/0/0/8/0/AllStories',
  },
  { name: 'خبرآنلاین', rss_url: 'https://www.khabaronline.ir/rss' },
];

function getText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);

  if (value && typeof value === 'object') {
    if (value['#text'] !== undefined) return String(value['#text']);
    if (value['#cdata'] !== undefined) return String(value['#cdata']);
  }

  return '';
}

function cleanText(value) {
  return getText(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCategory(value) {
  const category = cleanText(value);
  return category && category.length <= 250 ? category : null;
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

  return categories.length ? [...new Set(categories)].join(' | ') : null;
}

function getMetaContent(html, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attrPattern = new RegExp(
      `\\b${attribute}\\s*=\\s*["']${escaped}["']`,
      'i'
    );

    if (!attrPattern.test(tag)) continue;

    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
    if (content?.[1]) return cleanCategory(content[1]);
  }

  return null;
}

function findJsonLdSection(value) {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonLdSection(item);
      if (found) return found;
    }
    return null;
  }

  const section = cleanCategory(value.articleSection);
  if (section) return section;

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findJsonLdSection(child);
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
      const category = findJsonLdSection(JSON.parse(json));
      if (category) return category;
    } catch {
      // JSON-LD نامعتبر نادیده گرفته می‌شود.
    }
  }

  const itemprop = html.match(
    /<[^>]*itemprop=["']articleSection["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  );

  return itemprop?.[1] ? cleanCategory(itemprop[1]) : null;
}

async function fetchPageCategory(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'LifeNewsBot/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      return null;
    }

    return getPageCategory(await response.text());
  } catch (error) {
    console.warn(`دریافت دسته صفحه ناموفق بود: ${url} | ${error.message}`);
    return null;
  }
}

function getImage(item) {
  const candidates = [
    item.enclosure?.['@_url'],
    item['media:content']?.['@_url'],
    item['media:thumbnail']?.['@_url'],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }

  const html = [
    getText(item.description),
    getText(item['content:encoded']),
  ].join(' ');

  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] || null;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(getText(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getItems(data) {
  const items = data?.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

async function ensureSources() {
  for (const source of SOURCES) {
    await sql`
      INSERT INTO sources (name, rss_url, enabled, interval_minutes)
      VALUES (${source.name}, ${source.rss_url}, true, 15)
      ON CONFLICT (rss_url)
      DO UPDATE SET
        name = EXCLUDED.name,
        enabled = true
    `;
  }
}

async function saveArticle(source, item) {
  const title = cleanText(item.title);
  const link = getText(item.link).trim();

  const body = cleanText(
    item['content:encoded'] ||
    item.description ||
    item.summary
  );

  if (!title || !link || !/^https?:\/\//i.test(link)) return false;

  const imageUrl = getImage(item);
  const publishedAt = parseDate(
    item.pubDate || item.published || item.updated
  );

  const rssCategory = getRssCategory(item);
  const sourceCategory = rssCategory || await fetchPageCategory(link);

  const contentHash = createHash('sha256')
    .update(`${title}\n${body}`)
    .digest('hex');

  const result = await sql`
    INSERT INTO articles (
      source_id,
      source_url,
      title,
      body_original,
      image_url,
      source_published_at,
      fetched_at,
      status,
      rewrite_state,
      content_hash,
      source_category
    )
    VALUES (
      ${source.id},
      ${link},
      ${title},
      ${body || title},
      ${imageUrl},
      ${publishedAt},
      NOW(),
      'pending',
      'none',
      ${contentHash},
      ${sourceCategory}
    )
    ON CONFLICT (source_url) DO NOTHING
    RETURNING id
  `;

  return result.length > 0;
}

async function fetchSource(source) {
  console.log(`\nدر حال دریافت: ${source.name}`);

  try {
    const response = await fetch(source.rss_url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'LifeNewsBot/1.0',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const xml = await response.text();
    const data = parser.parse(xml);
    const items = getItems(data);

    if (!items.length) throw new Error('هیچ خبر RSS پیدا نشد.');

    let inserted = 0;
    let withSourceCategory = 0;

    for (const item of items) {
      const hasRssCategory = Boolean(getRssCategory(item));
      if (await saveArticle(source, item)) {
        inserted++;
        if (hasRssCategory) withSourceCategory++;
      }
    }

    await sql`
      UPDATE sources
      SET
        last_checked_at = NOW(),
        last_status = 'ok',
        fail_count = 0
      WHERE id = ${source.id}
    `;

    console.log(
      `موفق: ${source.name} | ` +
      `خبرهای فید: ${items.length} | ` +
      `خبرهای جدید: ${inserted} | ` +
      `دارای دسته در RSS: ${withSourceCategory}`
    );
  } catch (error) {
    await sql`
      UPDATE sources
      SET
        last_checked_at = NOW(),
        last_status = 'error',
        fail_count = fail_count + 1
      WHERE id = ${source.id}
    `;

    console.error(`خطا در ${source.name}:`, error.message);
  }
}

async function main() {
  try {
    await ensureSources();

    const sources = await sql`
      SELECT id, name, rss_url
      FROM sources
      WHERE enabled = true
        AND (
          last_checked_at IS NULL
          OR last_checked_at <=
             NOW() - make_interval(mins => interval_minutes)
        )
      ORDER BY id
    `;

    console.log(`تعداد منابع آماده دریافت: ${sources.length}`);

    for (const source of sources) {
      await fetchSource(source);
    }

    const [stats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_articles,
        COUNT(*)::int AS total_articles,
        COUNT(*) FILTER (
          WHERE source_category IS NOT NULL
            AND source_category <> ''
        )::int AS articles_with_source_category
      FROM articles
    `;

    console.log('\nآمار دیتابیس:');
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای اصلی Worker:', error.message);
  process.exitCode = 1;
});
