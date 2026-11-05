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
    const title = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim();
    const meta = html.match(/<meta[^>]+(?:article:section|og:article:section|name=[\\\"']section)[^>]+>/i)?.[0];
    console.log(JSON.stringify({
      source: probe.source,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type'),
      server: response.headers.get('server'),
      length: html.length,
      title: title || null,
      hasJsonLd: /application\\/ld\\+json/i.test(html),
      hasBreadcrumb: /BreadcrumbList/i.test(html),
      hasTransferPage: /Transferring to the website|در حال انتقال|static-pages-/i.test(html),
      meta: meta || null,
      preview: html.slice(0, 180).replace(/\\s+/g, ' '),
    }));
  } catch (error) {
    console.log(JSON.stringify({ source: probe.source, error: error.message }));
  }
}
