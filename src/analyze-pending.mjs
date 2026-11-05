import postgres from 'postgres';
import { cleanCategory, getPageCategory } from './source-category.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const BATCH_SIZE = 20;

if (!DATABASE_URL) throw new Error('DATABASE_URL تنظیم نشده است.');

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

async function inspectArticlePage(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { category: null, reason: 'INVALID_URL', url: url || null };
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5',
      },
    });

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url;
    const status = response.status;

    if (!response.ok) {
      await response.body?.cancel();
      return { category: null, reason: 'HTTP_ERROR', status, contentType, finalUrl };
    }

    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await response.body?.cancel();
      return { category: null, reason: 'NON_HTML', status, contentType, finalUrl };
    }

    const html = await response.text();
    if (/Just a moment|Checking your browser|cf-chl-|challenge-platform|در حال انتقال/i.test(html)) {
      return {
        category: null, reason: 'BOT_CHALLENGE', status, contentType,
        finalUrl, htmlLength: html.length,
      };
    }

    const category = cleanCategory(getPageCategory(html, finalUrl));
    const htmlPreview = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 700);

    const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || null;

    return {
      category,
      reason: category ? 'CATEGORY_FOUND' : 'CATEGORY_NOT_IN_PARSED_MARKUP',
      status,
      contentType,
      finalUrl,
      htmlLength: html.length,
      pageTitle,
      htmlPreview,
      server: response.headers.get('server'),
      via: response.headers.get('via'),
      hasArticleSectionMeta: /(?:article:section|og:article:section|name=["']section)/i.test(html),
      hasJsonLd: /application\/ld\+json/i.test(html),
      hasBreadcrumb: /BreadcrumbList/i.test(html),
    };
  } catch (error) {
    return {
      category: null,
      reason: error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'TIMEOUT'
        : 'FETCH_ERROR',
      error: error.message,
    };
  }
}

async function main() {
  try {
    const articles = await sql`
      SELECT a.id, a.source_url, a.title, a.source_category, s.name AS source_name
      FROM articles a
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.status = 'pending'
        AND a.deleted_at IS NULL
      ORDER BY a.id ASC
      LIMIT ${BATCH_SIZE}
    `;

    const report = {
      checked: 0,
      already_had_category: 0,
      found_from_page: 0,
      not_found: 0,
      saved: 0,
      reasons: {},
      mode: DRY_RUN ? 'DRY_RUN' : 'LIVE',
    };

    console.log(`حالت اجرا: ${report.mode}`);
    console.log(`حداکثر خبر در این اجرا: ${BATCH_SIZE}`);

    for (const article of articles) {
      report.checked++;
      let category = cleanCategory(article.source_category);
      let diagnostic = null;

      if (category) {
        report.already_had_category++;
      } else {
        diagnostic = await inspectArticlePage(article.source_url);
        category = diagnostic.category;
        if (category) report.found_from_page++;
        else report.not_found++;

        const reason = diagnostic.reason;
        report.reasons[reason] = (report.reasons[reason] || 0) + 1;
      }

      if (category && !DRY_RUN && !article.source_category) {
        const updated = await sql`
          UPDATE articles
          SET source_category = ${category}
          WHERE id = ${article.id}
            AND source_category IS NULL
          RETURNING id
        `;
        if (updated.length) report.saved++;
      }

      console.log(JSON.stringify({
        id: article.id,
        source: article.source_name,
        title: article.title,
        source_url: article.source_url,
        source_category: category,
        diagnostic,
        result: category ? 'found' : 'not_found',
        mode: report.mode,
      }));
    }

    console.log('\n========== گزارش تشخیصی ==========');
    console.log(JSON.stringify(report, null, 2));
    console.log(DRY_RUN
      ? 'DRY_RUN: هیچ داده‌ای در دیتابیس تغییر نکرد.'
      : 'فقط source_category خبرهای دارای دسته ذخیره شد.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای بررسی دسته‌بندی منبع:', error);
  process.exitCode = 1;
});
