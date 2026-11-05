import postgres from 'postgres';
import { XMLParser } from 'fast-xml-parser';
import { cleanCategory, getPageCategory, getRssCategory, getText } from './source-category.mjs';
import { ISNA_RSS_FEEDS } from './isna-rss-feeds.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const BATCH_SIZE = 200;
const blockedSourceHosts = new Set();
const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.href.toLowerCase();
  } catch {
    return String(value || '').trim().replace(/\/$/, '').toLowerCase();
  }
}

function articleIdentity(value) {
  try {
    const url = new URL(value);
    const path = url.pathname;
    const tasnim = path.match(/\/news\/\d{4}\/\d{1,2}\/\d{1,2}\/(\d+)(?:\/|$)/i);
    const standard = path.match(/\/(?:news|photo|video)\/(\d+)(?:\/|$)/i);
    const id = tasnim?.[1] || standard?.[1];
    if (!id) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '') + '|' + id;
  } catch {
    return null;
  }
}

async function loadRssCategories(sources) {
  const categories = new Map();
  const categoriesByIdentity = new Map();

  for (const source of sources) {
    if (!source.rss_url) continue;

    try {
      const response = await fetch(source.rss_url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
      });

      if (!response.ok) {
        console.log(`RSS_CATEGORY_FETCH_FAILED source=${source.name} status=${response.status}`);
        continue;
      }

      const xml = await response.text();
      const data = rssParser.parse(xml);
      const rawItems = data?.rss?.channel?.item;
      const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

      for (const item of items) {
        const link = getText(item.link).trim();
        const category = getRssCategory(item);
        if (link && category) {
          categories.set(normalizeUrl(link), category);
          const identity = articleIdentity(link);
          if (identity) categoriesByIdentity.set(identity, category);
        }
      }

      console.log(`RSS_CATEGORY_INDEX source=${source.name} items=${items.length} categorized=${items.filter(item => getRssCategory(item)).length} identities=${items.filter(item => articleIdentity(getText(item.link).trim())).length}`);

    } catch (error) {
      console.log(`RSS_CATEGORY_FETCH_FAILED source=${source.name} error=${error.message}`);
    }
  }

  return { categories, categoriesByIdentity };
}

async function loadIsnaServiceCategories() {
  const categories = new Map();
  const failedFeeds = [];
  let checkedFeeds = 0;

  for (let offset = 0; offset < ISNA_RSS_FEEDS.length; offset += 6) {
    const batch = ISNA_RSS_FEEDS.slice(offset, offset + 6);
    const results = await Promise.all(batch.map(async feed => {
      try {
        const response = await fetch(feed.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml',
          },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const xml = await response.text();
        if (!xml.includes('<rss')) throw new Error('NON_RSS_RESPONSE');

        const data = rssParser.parse(xml);
        const rawItems = data?.rss?.channel?.item;
        const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

        return { feed, items };
      } catch (error) {
        return { feed, error: error.message };
      }
    }));

    for (const result of results) {
      if (result.error) {
        failedFeeds.push({ id: result.feed.id, error: result.error });
        continue;
      }

      checkedFeeds++;
      for (const item of result.items) {
        const link = getText(item.link).trim();
        const identity = articleIdentity(link);
        if (!identity || !identity.startsWith('isna.ir|')) continue;

        const category = getRssCategory(item) || cleanCategory(result.feed.label);
        if (!category) continue;

        const current = categories.get(identity);
        const depth = category.split(' > ').length;
        const currentDepth = current ? current.split(' > ').length : 0;
        if (!current || depth > currentDepth) categories.set(identity, category);
      }
    }
  }

  console.log(JSON.stringify({
    event: 'ISNA_SERVICE_RSS_INDEX',
    feeds_total: ISNA_RSS_FEEDS.length,
    feeds_ok: checkedFeeds,
    feeds_failed: failedFeeds.length,
    article_identities: categories.size,
    failed_feed_samples: failedFeeds.slice(0, 5),
  }));

  return categories;
}

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

  let sourceHost;
  let requestUrl;
  try {
    requestUrl = new URL(url);
    sourceHost = requestUrl.hostname.toLowerCase().replace(/^www\./, '');
    if (sourceHost === 'irna.ir') {
      requestUrl.hostname = 'www2.irna.ir';
      const articleId = requestUrl.pathname.match(/^\/(?:news|photo|video)\/(\d+)/i)?.[1];
      if (articleId) requestUrl.pathname = `/news/${articleId}/`;
    }
  } catch {
    return { category: null, reason: 'INVALID_URL', url };
  }
  if (blockedSourceHosts.has(sourceHost)) {
    return { category: null, reason: 'SOURCE_HOST_BLOCKED', sourceHost };
  }

  try {
    const response = await fetch(requestUrl.href, {
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
    const server = response.headers.get('server') || '';
    if (
      /Just a moment|Checking your browser|cf-chl-|challenge-platform/i.test(html)
      || (/ArvanCloud/i.test(server) && /Transferring to the website|در حال انتقال/i.test(html))
      || /\/cdn-cgi\/assets\/css\/static-pages-/i.test(html)
    ) {
      blockedSourceHosts.add(sourceHost);
      return {
        category: null, reason: 'SOURCE_HOST_BLOCKED', status, contentType,
        finalUrl, htmlLength: html.length, server,
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
    const sources = await sql`
      SELECT id, name, rss_url
      FROM sources
      WHERE enabled = true
      ORDER BY id
    `;
    const articles = await sql`
      SELECT a.id, a.source_url, a.title, a.source_category, s.name AS source_name
      FROM articles a
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.status = 'pending'
        AND a.deleted_at IS NULL
        AND (a.source_category IS NULL OR a.source_category = '')
      ORDER BY a.id ASC
      LIMIT ${BATCH_SIZE}
    `;

    const { categories: rssCategories, categoriesByIdentity } = await loadRssCategories(sources);
    const needsIsnaArchive = articles.some(article => {
      if (article.source_name !== 'ایسنا') return false;
      const identity = articleIdentity(article.source_url);
      return !rssCategories.has(normalizeUrl(article.source_url))
        && !(identity && categoriesByIdentity.has(identity));
    });
    const isnaServiceCategories = needsIsnaArchive
      ? await loadIsnaServiceCategories()
      : new Map();

    const report = {
      checked: 0,
      already_had_category: 0,
      found_from_rss_or_page: 0,
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
        const normalizedUrl = normalizeUrl(article.source_url);
        const identity = articleIdentity(article.source_url);
        category = rssCategories.get(normalizedUrl)
          || (identity ? categoriesByIdentity.get(identity) : null)
          || (article.source_name === 'ایسنا' && identity
            ? isnaServiceCategories.get(identity)
            : null)
          || null;
        if (category) {
          diagnostic = {
            reason: rssCategories.has(normalizedUrl)
              ? 'CATEGORY_FOUND_IN_RSS_URL'
              : isnaServiceCategories.has(identity)
                ? 'CATEGORY_FOUND_IN_ISNA_SERVICE_RSS'
                : 'CATEGORY_FOUND_IN_RSS_ID',
            identity,
          };
        } else {
          diagnostic = await inspectArticlePage(article.source_url);
          category = diagnostic.category;
        }
        if (category) report.found_from_rss_or_page++;
        else report.not_found++;

        const reason = diagnostic.reason;
        report.reasons[reason] = (report.reasons[reason] || 0) + 1;
      }

      if (category && !DRY_RUN && !article.source_category) {
        const updated = await sql`
          UPDATE articles
          SET source_category = ${category}
          WHERE id = ${article.id}
            AND (source_category IS NULL OR source_category = '')
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
