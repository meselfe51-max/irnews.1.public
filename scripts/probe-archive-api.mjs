const probes = [
  { source: 'irna-www', url: 'https://www.irna.ir/news/86312839/' },
  { source: 'irna-root', url: 'https://irna.ir/news/86312839/' },
  { source: 'irna-www2', url: 'https://www2.irna.ir/news/86312839/' },
  { source: 'isna-www', url: 'https://www.isna.ir/news/1405081309147/' },
  { source: 'isna-root', url: 'https://isna.ir/news/1405081309147/' },
  { source: 'isna-www2', url: 'https://www2.isna.ir/news/1405081309147/' },
];

for (const probe of probes) {
  try {
    const response = await fetch(probe.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LifeNewsMetadataProbe/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5',
      },
    });
    const html = await response.text();
    const titleStart = html.toLowerCase().indexOf('<title');
    const titleEnd = titleStart >= 0 ? html.toLowerCase().indexOf('</title>', titleStart) : -1;
    const title = titleEnd > titleStart
      ? html.slice(html.indexOf('>', titleStart) + 1, titleEnd).replace(/<[^>]+>/g, ' ').trim()
      : null;
    console.log(JSON.stringify({
      source: probe.source,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type'),
      server: response.headers.get('server'),
      length: html.length,
      title,
      hasJsonLd: html.includes('application/ld+json'),
      hasBreadcrumb: html.includes('BreadcrumbList'),
      hasTransferPage: html.includes('Transferring to the website') || html.includes('در حال انتقال') || html.includes('static-pages-'),
      hasArticleSection: html.includes('article:section') || html.includes('og:article:section'),
      preview: html.slice(0, 180).replace(/\\s+/g, ' '),
    }));
  } catch (error) {
    console.log(JSON.stringify({ source: probe.source, error: error.message }));
  }
}
