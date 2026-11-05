import { getPageCategory } from '../src/source-category.mjs';

const url = 'https://www2.irna.ir/news/86312839/';
const response = await fetch(url, {
  redirect: 'follow',
  signal: AbortSignal.timeout(15000),
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsMetadataProbe/1.0)',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5',
  },
});
const html = await response.text();
const anchors = [...html.matchAll(/<a\\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)<\\/a>/gi)]
  .map(match => ({
    href: match[1],
    text: match[2].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim(),
  }))
  .filter(item => item.text || /service|category|section/i.test(item.href))
  .slice(0, 80);
const hints = [...html.matchAll(/.{0,120}(?:breadcrumb|category|section|service|موضوع|گروه خبری|دسته).{0,180}/gi)]
  .slice(0, 40)
  .map(match => match[0].replace(/\\s+/g, ' '));
console.log(JSON.stringify({
  status: response.status,
  finalUrl: response.url,
  length: html.length,
  parsedCategory: getPageCategory(html, url),
  anchors,
  hints,
}, null, 2));
