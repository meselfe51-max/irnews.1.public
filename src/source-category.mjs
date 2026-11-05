export function getText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    if (value['#text'] !== undefined) return String(value['#text']);
    if (value['#cdata'] !== undefined) return String(value['#cdata']);
  }
  return '';
}
export function cleanText(value) {
  return getText(value).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&gt;/gi, '>').replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
export function cleanCategory(value) {
  const result = cleanText(value);
  return result && result.length <= 250 ? result : null;
}
export function getRssCategory(item = {}) {
  const raw = item.category;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const categories = values.map(value => {
    if (typeof value === 'string' || typeof value === 'number') return cleanCategory(value);
    if (value && typeof value === 'object') return cleanCategory(value['#text'] ?? value['#cdata'] ?? value['@_term'] ?? value['@_label'] ?? '');
    return null;
  }).filter(Boolean);
  return categories.length ? [...new Set(categories)].join(' | ') : null;
}
function getMetaContent(html, attribute, value) {
  const escaped = value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const pattern = new RegExp("\\b" + attribute + "\\s*=\\s*[\"']" + escaped + "[\"']", "i");
    if (!pattern.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
    if (content && content[1]) return cleanCategory(content[1]);
  }
  return null;
}
function getBreadcrumbCategory(breadcrumb, articleUrl) {
  if (typeof breadcrumb === 'string') return cleanCategory(breadcrumb);
  if (!breadcrumb || typeof breadcrumb !== 'object') return null;
  const items = Array.isArray(breadcrumb.itemListElement) ? breadcrumb.itemListElement : [];
  const crumbs = items.map(entry => {
    const item = entry && entry.item;
    const url = typeof item === 'string' ? item : item && (item['@id'] || item.url) || '';
    const name = typeof item === 'object' && item ? item.name || entry.name || '' : entry.name || '';
    return { name: cleanCategory(name), url: String(url) };
  }).filter(crumb => crumb.name && !/^(خانه|صفحه اصلی|home)$/i.test(crumb.name));
  if (!crumbs.length) return null;
  let articleIndex = -1;
  if (articleUrl) {
    try {
      const articlePath = new URL(articleUrl).pathname;
      articleIndex = crumbs.findIndex(crumb => {
        if (!crumb.url) return false;
        try {
          const crumbUrl = new URL(crumb.url, articleUrl);
          return crumbUrl.href === new URL(articleUrl).href || crumbUrl.pathname === articlePath;
        } catch { return crumb.url === articleUrl; }
      });
    } catch { articleIndex = -1; }
  }
  if (articleIndex > 0) return crumbs[articleIndex - 1].name;
  if (articleIndex === 0) return null;
  if (crumbs.length > 1) return crumbs[crumbs.length - 2].name;
  return crumbs[0].name;
}
export function findJsonLdCategory(value, articleUrl) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonLdCategory(item, articleUrl);
      if (found) return found;
    }
    return null;
  }
  const section = cleanCategory(value.articleSection);
  if (section) return section;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  const breadcrumb = (value.mainEntityOfPage && value.mainEntityOfPage.breadcrumb) || (types.includes('BreadcrumbList') ? value : null);
  const category = getBreadcrumbCategory(breadcrumb, articleUrl);
  if (category) return category;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findJsonLdCategory(child, articleUrl);
      if (found) return found;
    }
  }
  return null;
}
export function getPageCategory(html, articleUrl) {
  const candidates = [['property','article:section'],['name','article:section'],['name','section'],['property','og:article:section']];
  for (const pair of candidates) {
    const category = getMetaContent(html, pair[0], pair[1]);
    if (category) return category;
  }
  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const json = script.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const category = findJsonLdCategory(JSON.parse(json), articleUrl);
      if (category) return category;
    } catch {}
  }

  // IRNA's legacy www2 host exposes the full section path in its breadcrumb.
  const breadcrumb = html.match(/<(?:ol|ul)\b[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:ol|ul)>/i);
  if (breadcrumb) {
    const items = [...breadcrumb[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(match => cleanCategory(match[1]))
      .filter(value => value && !/^(خانه|صفحه اصلی|home)$/i.test(value));
    if (items.length) return items.join(' > ');
  }

  const itemprop = html.match(/<[^>]*itemprop=["']articleSection["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  return itemprop && itemprop[1] ? cleanCategory(itemprop[1]) : null;
}
export async function fetchPageCategory(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'LifeNewsBot/1.0', Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) return null;
    const html = await response.text();
    if (/Just a moment|Checking your browser|cf-chl-|challenge-platform|در حال انتقال/i.test(html)) return null;
    return getPageCategory(html, url);
  } catch (error) {
    console.warn('دریافت دسته صفحه ناموفق بود: ' + url + ' | ' + error.message);
    return null;
  }
}
