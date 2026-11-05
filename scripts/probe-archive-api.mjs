import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
const targetIds = new Set(Array.from({ length: 30 }, (_, index) => String(1405081309163 - index)));
const feeds = [
  { id: 5, label: 'علمی و دانشگاهی' },
  { id: 14, label: 'سیاسی' },
  { id: 20, label: 'فرهنگی و هنری' },
  { id: 34, label: 'اقتصادی' },
  { id: 9, label: 'اجتماعی' },
  { id: 17, label: 'جهان' },
  { id: 24, label: 'ورزشی' },
  { id: 30, label: 'استان‌ها' },
  { id: 28, label: 'عکس' },
  { id: 401, label: 'چندرسانه‌ای' },
  { id: 353, label: 'بازار' },
  { id: 363, label: 'ایسنا+' },
];

for (const feed of feeds) {
  try {
    const response = await fetch(`https://www.isna.ir/rss/tp/${feed.id}`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    const xml = await response.text();
    if (!response.ok || !xml.includes('<rss')) {
      console.log(JSON.stringify({ feed: feed.label, id: feed.id, status: response.status, contentType: response.headers.get('content-type'), length: xml.length, preview: xml.slice(0, 100) }));
      continue;
    }
    const parsed = parser.parse(xml);
    const raw = parsed?.rss?.channel?.item;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const matches = [];
    for (const item of items) {
      const link = typeof item.link === 'string' ? item.link : item.link?.['#text'] || '';
      const id = link.match(/\/news\/(\d+)/)?.[1];
      if (targetIds.has(id)) matches.push({
        id,
        title: item.title,
        category: item.category,
        feed: feed.label,
      });
    }
    console.log(JSON.stringify({
      feed: feed.label,
      id: feed.id,
      status: response.status,
      items: items.length,
      matches,
      sampleCategory: items.slice(0, 2).map(item => item.category ?? null),
    }));
  } catch (error) {
    console.log(JSON.stringify({ feed: feed.label, id: feed.id, error: error.message }));
  }
}
