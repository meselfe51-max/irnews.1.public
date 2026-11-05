const probes = [
  { source: 'irna', host: 'www.irna.ir', id: '86312839' },
  { source: 'isna', host: 'www.isna.ir', id: '1405081309147' },
];

for (const probe of probes) {
  const url = new URL('https://freenewsapi.ai/v1/search');
  url.searchParams.set('host', probe.host);
  url.searchParams.set('q', probe.id);
  url.searchParams.set('size', '10');

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', 'User-Agent': 'LifeNewsMetadataProbe/1.0' },
    });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    const rows = Array.isArray(data) ? data : data?.results || data?.items || data?.articles || [];
    console.log(JSON.stringify({
      source: probe.source,
      status: response.status,
      contentType: response.headers.get('content-type'),
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      count: rows.length,
      samples: rows.slice(0, 3).map(row => ({
        title: row.title,
        url: row.url || row.link,
        section: row.section,
        category: row.category,
        categories: row.categories,
        published_at: row.published_at,
      })),
      bodyPreview: rows.length ? undefined : body.slice(0, 700),
    }));
  } catch (error) {
    console.log(JSON.stringify({ source: probe.source, error: error.message }));
  }
}
