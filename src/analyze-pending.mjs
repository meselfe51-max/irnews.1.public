
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN !== 'false';

const BATCH_SIZE = 20;
const REQUEST_TIMEOUT_MS = 12000;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL تنظیم نشده است.');
}

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

function cleanCategory(value) {
  if (typeof value !== 'string') return null;

  const result = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return result.length > 0 && result.length <= 250
    ? result
    : null;
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

    if (content?.[1]) {
      return cleanCategory(content[1]);
    }
  }

  return null;
}

function findJsonLdSection(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

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

  return itemprop?.[1]
    ? cleanCategory(itemprop[1])
    : null;
}

async function fetchPageCategory(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    const html = await response.text();

    return getPageCategory(html);
  } catch (error) {
    console.warn(
      `دریافت دسته صفحه ناموفق بود: ${url} | ${error.message}`
    );

    return null;
  }
}

async function main() {
  try {
    const articles = await sql`
      SELECT
        id,
        source_url,
        title,
        source_category
      FROM articles
      WHERE status = 'pending'
        AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
    `;

    const report = {
      checked: 0,
      already_had_category: 0,
      found_from_page: 0,
      not_found: 0,
      saved: 0,
      mode: DRY_RUN ? 'DRY_RUN' : 'LIVE',
    };

    console.log(`حالت اجرا: ${report.mode}`);
    console.log(`حداکثر خبر در این اجرا: ${BATCH_SIZE}`);

    for (const article of articles) {
      report.checked++;

      let category = cleanCategory(article.source_category);
      let origin = 'RSS';

      if (category) {
        report.already_had_category++;
      } else {
        category = await fetchPageCategory(article.source_url);
        origin = 'صفحه خبر';

        if (category) {
          report.found_from_page++;
        } else {
          report.not_found++;
        }
      }

      if (
        category &&
        !DRY_RUN &&
        !article.source_category
      ) {
        const updated = await sql`
          UPDATE articles
          SET source_category = ${category}
          WHERE id = ${article.id}
            AND source_category IS NULL
          RETURNING id
        `;

        if (updated.length > 0) {
          report.saved++;
        }
      }

      console.log(
        JSON.stringify({
          id: article.id,
          title: article.title,
          source_category: category,
          category_origin: category ? origin : null,
          result: category ? 'found' : 'not_found',
          mode: report.mode,
        })
      );
    }

    console.log('\n========== گزارش ==========');
    console.log(JSON.stringify(report, null, 2));

    if (DRY_RUN) {
      console.log(
        'حالت آزمایشی: هیچ داده‌ای در دیتابیس تغییر نکرد.'
      );
    } else {
      console.log(
        'فقط ستون source_category برای خبرهای دارای دسته منبع ذخیره شد.'
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای دریافت دسته‌بندی منبع:', error);
  process.exitCode = 1;
});
