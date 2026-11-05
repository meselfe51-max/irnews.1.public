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
console.log('STATUS', response.status, 'LENGTH', html.length, 'CATEGORY', getPageCategory(html, url));
console.log('HTML_START', html.slice(0, 14000));
