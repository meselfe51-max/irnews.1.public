import { readFileSync, appendFileSync } from 'node:fs';

// تنظیمات
const SOURCES_FILE =
  process.env.SOURCES_FILE || new URL('../sources.json', import.meta.url);

const USER_AGENT = 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)';
const TIMEOUT_MS = 15000;
const MAX_RSS_CANDIDATES = 10;

const COMMON_RSS_PATHS = [
  '/rss',
  '/fa/rss',
  '/rss.xml',
  '/feed',
  '/feed/rss',
];

const WHY = (error) =>
  error?.cause?.code ||
  error?.name ||
  error?.message ||
  'Unknown error';

// خواندن منابع
let sources;

try {
  sources = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));

  if (!Array.isArray(sources)) {
    throw new Error('sources.json باید شامل یک آرایه باشد.');
  }
} catch (error) {
  console.error('خطا در خواندن sources.json:', error.message);
  process.exit(1);
}

// دریافت اطلاعات از URL
async function request(url, timeout = TIMEOUT_MS) {
  const startedAt = Date.now();

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept: '*/*',
    },
    signal: AbortSignal.timeout(timeout),
  });

  return {
    response,
    duration: Date.now() - startedAt,
  };
}

// تبدیل لینک نسبی به لینک کامل
function toAbsoluteUrl(href, base) {
  try {
    const clean = href.replace(/&amp;/g, '&');
    return new URL(clean, base).href;
  } catch {
    return null;
  }
}

// استخراج RSS از HTML سایت
function discoverRss(html, base) {
  const found = [];

  // تگ‌های link
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];

    const isFeed =
      /application\/(rss|atom)\+xml/i.test(tag) ||
      /rel=["'][^"']*alternate[^"']*["']/i.test(tag);

    if (!isFeed) continue;

    const href = /href=["']([^"']+)["']/i.exec(tag);

    if (href) {
      const url = toAbsoluteUrl(href[1], base);
      if (url) found.push(url);
    }
  }

  // لینک‌هایی که در آدرسشان rss یا feed وجود دارد
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']([^"']*(?:rss|feed)[^"']*)["'][^>]*>/gi
  )) {
    const url = toAbsoluteUrl(match[1], base);
    if (url) found.push(url);
  }

  return [...new Set(found)];
}

// بررسی اولیه معتبر بودن XML
function parseFeed(xml) {
  const isXmlFeed =
    /<(rss|feed|rdf:RDF)(?:\s|>)/i.test(xml);

  if (!isXmlFeed) return null;

  const blocks = xml.split(
    /<(?:item|entry)(?:\s|>)/i
  ).slice(1);

  if (blocks.length === 0) return null;

  const firstItem = blocks[0];

  const titleOk = /<title(?:\s|>)/i.test(firstItem);

  const linkOk =
    /<link(?:\s|>)/i.test(firstItem) ||
    /<guid(?:\s|>)/i.test(firstItem);

  return {
    items: blocks.length,
    titleOk,
    linkOk,
    blocks,
  };
}

// استخراج اولین عکس از RSS
function findFirstImage(blocks, base) {
  for (const block of blocks.slice(0, 10)) {
    const patterns = [
      /<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i,
      /<media:content\b[^>]*url=["']([^"']+)["'][^>]*>/i,
      /<media:thumbnail\b[^>]*url=["']([^"']+)["'][^>]*>/i,
      /<(?:img|image)\b[^>]*(?:src|url)=["']([^"']+)["'][^>]*>/i,
      /<img\b[^>]*src=(?:["']|&quot;)([^"'&]+)/i,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(block);

      if (!match) continue;

      const imageUrl = toAbsoluteUrl(match[1], base);

      if (
        imageUrl &&
        /^https?:\/\//i.test(imageUrl)
      ) {
        return imageUrl;
      }
    }
  }

  return null;
}

// بررسی یک منبع خبری
async function checkSource(source) {
  const result = {
    name: source.name || 'Unknown',
    site: '-',
    rss: '-',
    rssUrl: '',
    image: '-',
    status: '✅ OK',
  };

  // منابع غیرفعال بررسی نمی‌شوند
  if (source.enabled === false) {
    result.status = '⏭️ SKIPPED';
    result.site = 'Disabled';
    result.rss = 'Disabled';
    result.image = 'Disabled';
    return result;
  }

  // اعتبارسنجی آدرس سایت
  let siteUrl;

  try {
    siteUrl = new URL(source.site);

    if (!['http:', 'https:'].includes(siteUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    result.site =
