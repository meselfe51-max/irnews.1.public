
import postgres from 'postgres';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { getText, cleanText, getRssCategory, fetchPageCategory } from './source-category.mjs';

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

  if (!title || !link || !/^https?:\/\//i.test(link)) {
    return false;
  }

  const imageUrl = getImage(item);

  const publishedAt = parseDate(
    item.pubDate || item.published || item.updated
  );

  // اول دسته RSS؛ فقط در صورت نبود آن، صفحه همان خبر بررسی می‌شود.
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

  return {
    inserted: result.length > 0,
    hasSourceCategory: Boolean(sourceCategory),
  };
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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const data = parser.parse(xml);
    const items = getItems(data);

    if (!items.length) {
      throw new Error('هیچ خبر RSS پیدا نشد.');
    }

    let inserted = 0;
    let withSourceCategory = 0;

    for (const item of items) {
      const saved = await saveArticle(source, item);

      if (saved?.inserted) {
        inserted++;

        if (saved.hasSourceCategory) {
          withSourceCategory++;
        }
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
      `دارای دسته منبع (RSS یا صفحه خبر): ${withSourceCategory}`
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
