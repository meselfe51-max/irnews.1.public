const url = 'https://www2.irna.ir/news/86312802/';
const response = await fetch(url, {
  redirect: 'follow',
  signal: AbortSignal.timeout(15000),
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)', Accept: 'text/html,application/xhtml+xml' },
});
const html = await response.text();
const terms = ['breadcrumb','articleSection','og:article','section','عکس','استان','موضوع','خبر'];
const snippets = {};
for (const term of terms) {
  const index = html.toLowerCase().indexOf(term.toLowerCase());
  snippets[term] = index >= 0 ? html.slice(Math.max(0,index-250),Math.min(html.length,index+650)).replace(/\\s+/g,' ') : null;
}
console.log(JSON.stringify({
  status: response.status,
  length: html.length,
  snippets,
  htmlStart: html.slice(0, 7000),
}, null, 2));
