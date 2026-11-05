import { getPageCategory } from '../src/source-category.mjs';

const paths = [
  '/photo/86312802/',
  '/photo/86312802',
  '/news/86312802/',
  '/news/86312802',
  '/video/86312790/',
  '/news/86312790/',
];
for (const path of paths) {
  try {
    const response = await fetch('https://www2.irna.ir' + path, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)', Accept: 'text/html,application/xhtml+xml' },
    });
    const html = await response.text();
    console.log(JSON.stringify({
      path,
      status: response.status,
      finalUrl: response.url,
      length: html.length,
      category: getPageCategory(html, response.url),
      title: html.includes('<title') ? html.slice(html.indexOf('<title'), html.indexOf('</title>') + 8).replace(/<[^>]+>/g, ' ').trim() : null,
      preview: html.slice(0, 100).replace(/\\s+/g, ' '),
    }));
  } catch (error) {
    console.log(JSON.stringify({ path, error: error.message }));
  }
}
