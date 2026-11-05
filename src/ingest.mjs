function decodeHtml(value) {
  return value
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function fetchPageCategoryFromHtml(html) {
  // 1. متاتگ article:section
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const property =
      tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1];

    if (
      property &&
      ['article:section', 'og:article:section'].includes(
        property.toLowerCase()
      )
    ) {
      const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1];

      if (content?.trim()) {
        return decodeHtml(content);
      }
    }
  }

  // 2. اطلاعات دسته‌بندی در JSON-LD
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const match of scripts) {
    try {
      const data = JSON.parse(match[1]);

      const nodes = Array.isArray(data) ? data : [data];

      for (const node of nodes) {
        const article = node?.['@type'] === 'NewsArticle'
          ? node
          : null;

        const breadcrumb = article?.mainEntityOfPage?.breadcrumb;

        if (typeof breadcrumb === 'string' && breadcrumb.trim()) {
          return breadcrumb.trim();
        }

        const items = breadcrumb?.itemListElement;

        if (Array.isArray(items)) {
          const names = items
            .map(item => {
              const value = item?.item?.name ?? item?.name;
              return typeof value === 'string' ? value.trim() : null;
            })
            .filter(Boolean);

          if (names.length) {
            return names.join(' > ');
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}
