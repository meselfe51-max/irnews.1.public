import { XMLParser } from 'fast-xml-parser';
import {
  getText,
  cleanText,
  getRssCategory,
  fetchPageCategory,
} from '../src/source-category.mjs';

const SOURCES = [
  { name: 'IRNA', rss: 'https://www.irna.ir/rss' },
  { name: 'ISNA', rss: 'https://www.isna.ir/rss' },
  { name: 'MEHR', rss: 'https://www.mehrnews.com/rss' },
  { name: 'TASNIM', rss: 'https://www.tasnimnews.ir/fa/rss/feed/0/0/8/0/AllStories' },
  { name: 'KHABARONLINE', rss: 'https://www.khabaronline.ir/rss' },
];

const SAMPLE_SIZE = 5;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

function getItems(data) {
  const items = data?.rss?.channel?.item;
  return !items ? [] : Array.isArray(items) ? items : [items];
}

function getLink(item) {
  const link = item.link;
  if (typeof link === 'string') return link.trim();
  if (link && typeof link === 'object' && link['@_href']) return link['@_href'];
  const guid = getText(item.guid).trim();
  return /^https?:\/\//i.test(guid) ? guid : '';
}

async function inspect(source) {
  console.log(`\n=== ${source.name} ===`);

  try {
    const response = await fetch(source.rss, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'LifeNewsBot/1.0',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);

    const xml = await response.text();
    const data = parser.parse(xml);
    const items = getItems(data).slice(0, SAMPLE_SIZE);

    if (!items.length) {
      throw new Error('RSS channel.item پیدا نشد یا پاسخ RSS معتبر نیست.');
    }

    let rssCount = 0;
    let pageCount = 0;
    let missingCount = 0;

    console.log(`نمونه بررسی‌شده: ${items.length}`);

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const title = cleanText(item.title) || '(بدون عنوان)';
      const link = getLink(item);

      let category = getRssCategory(item);
      let pageCategory = null;
      let method = 'RSS';

      // Independently probe one live article page per source to verify fallback parsing.
      if (index === 0 && link) {
        pageCategory = await fetchPageCategory(link);
      }

      if (category) {
        rssCount++;
      } else if (link) {
        category = pageCategory || await fetchPageCategory(link);
        method = category ? 'ARTICLE_PAGE' : 'NOT_FOUND';
        if (category) pageCount++;
        else missingCount++;
      } else {
        method = 'NOT_FOUND (NO ARTICLE URL)';
        missingCount++;
      }

      console.log(JSON.stringify({
        sample: index + 1,
        title,
        category,
        pageCategory: index === 0 ? pageCategory : undefined,
        method,
      }));
    }

    console.log(
      `SUMMARY: RSS=${rssCount}, PAGE_FALLBACK=${pageCount}, MISSING=${missingCount}`
    );
  } catch (error) {
    console.log(`SOURCE_ERROR: ${error.message}`);
  }
}

console.log('PRODUCTION PARSER DIAGNOSTIC; DATABASE ACCESS: NONE');
for (const source of SOURCES) await inspect(source);
console.log('DIAGNOSTIC COMPLETE');
