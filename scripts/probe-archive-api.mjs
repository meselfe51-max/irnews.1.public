const urls = [
  'https://www2.irna.ir/news/86312790/',
  'https://www2.irna.ir/news/86312802/',
];
for (const url of urls) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)', Accept: 'text/html,application/xhtml+xml' },
  });
  const html = await response.text();
  const articleStart = html.indexOf('<article');
  const articleEnd = html.indexOf('</article>', articleStart);
  console.log(JSON.stringify({
    url,
    status: response.status,
    articleMarkup: articleStart >= 0 ? html.slice(articleStart, articleEnd > articleStart ? articleEnd + 10 : articleStart + 6000) : null,
  }));
}
