import { readFileSync, appendFileSync } from 'node:fs';

const file = process.env.SOURCES_FILE || new URL('../sources.json', import.meta.url);
const sources = JSON.parse(readFileSync(file, 'utf8'));

const UA = 'Mozilla/5.0 (compatible; LifeNewsBot/1.0)';
const TIMEOUT_MS = 15000;
const COMMON_PATHS = ['/rss', '/fa/rss', '/rss.xml', '/feed'];

const why = (e) => e?.cause?.code || e?.name || e?.message || 'error';

async function get(url, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { res, ms: Date.now() - t0 };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function toAbs(href, base) {
  try { return new URL(href.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}

function discoverRss(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    if (/type=["']application\/(rss|atom)\+xml["']/i.test(m[0])) {
      const h = /href=["']([^"']+)["']/i.exec(m[0]);
      const abs = h && toAbs(h[1], base);
      if (abs) out.push(abs);
    }
  }
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']*rss[^"']*)["']/gi)) {
    const abs = toAbs(m[1], base);
    if (abs) out.push(abs);
  }
  return out;
}

function parseXml(xml) {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return null;
  const blocks = xml.split(/<(?:item|entry)[\s>]/i).slice(1);
  if (!blocks.length) return null;
  const first = blocks[0];
  return {
    items: blocks.length,
    titleOk: /<title[\s>]/i.test(first),
    linkOk: /<link[\s>]/i.test(first) || /<guid[\s>]/i.test(first),
    blocks,
  };
}

function firstImage(blocks, base) {
  for (const b of blocks.slice(0, 5)) {
    const m =
      /<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i.exec(b) ||
      /<media:content[^>]+url=["']([^"']+)["']/i.exec(b) ||
      /<media:thumbnail[^>]+url=["']([^"']+)["']/i.exec(b) ||
      /(?:<|&lt;)img[^>]+src=(?:["']|&quot;)([^"'&]+)/i.exec(b);
    if (m) {
      const abs = toAbs(m[1], base);
      if (abs && /^https?:/.test(abs)) return abs;
    }
  }
  return null;
}

async function checkSource(s) {
  const r = { name: s.name, site: '-', rss: '-', image: '-', status: '✅ OK', rssUrl: '' };

  // ۱) صفحه‌ی اصلی
  let html = '';
  try {
    const { res, ms } = await get(s.site);
    html = res.ok ? await res.text() : '';
    r.site = `${res.ok ? 'OK' : 'FAIL'} ${res.status} (${ms}ms)`;
  } catch (e) {
    r.site = `FAIL ${why(e)}`;
  }

  // ۲) RSS: اول آدرس دستی، بعد کشف خودکار، بعد مسیرهای رایج
  const candidates = [];
  if (s.rss_url) candidates.push(s.rss_url);
  else {
    candidates.push(...discoverRss(html, s.site));
    for (const p of COMMON_PATHS) candidates.push(new URL(p, s.site).href);
  }
  let feed = null;
  for (const url of [...new Set(candidates)].slice(0, 8)) {
    try {
      const { res, ms } = await get(url);
      if (!res.ok) continue;
      const parsed = parseXml(await res.text());
      if (parsed) {
        feed = { url, ms, ...parsed };
        break;
      }
    } catch { /* کاندیدای بعدی */ }
  }
  if (feed) {
    r.rssUrl = feed.url;
    r.rss = `OK (${feed.ms}ms), items: ${feed.items}, title: ${feed.titleOk}, link: ${feed.linkOk}`;
  } else {
    r.rss = s.rss_url ? 'FAIL (آدرس rss_url جواب RSS معتبر نداد)' : 'NOT FOUND (آدرس RSS را در sources.json بگذارید)';
    r.status = '❌ FAIL';
    return r;
  }

  // ۳) عکس: بدون Referer، مثل وقتی که سرور تلگرام لینک را می‌گیرد
  const img = firstImage(feed.blocks, feed.url);
  if (!img) {
    r.image = 'NO IMAGE in feed';
    r.status = '⚠️ PARTIAL';
  } else {
    try {
      const { res, ms } = await get(img, 2);
      const type = res.headers.get('content-type') || '';
      const good = res.ok && type.startsWith('image/');
      r.image = `${good ? 'OK' : 'PROBLEM'} ${res.status} ${type.split(';')[0]} (${ms}ms)`;
      if (!good) r.status = '⚠️ PARTIAL';
    } catch (e) {
      r.image = `PROBLEM ${why(e)}`;
      r.status = '⚠️ PARTIAL';
    }
  }
  return r;
}

const rows = [];
for (const s of sources) {
  const r = await checkSource(s);
  rows.push(r);
  console.log(`${r.status}  ${r.name}\n   site : ${r.site}\n   rss  : ${r.rss}\n   url  : ${r.rssUrl || '-'}\n   image: ${r.image}\n`);
}

const md = [
  '| منبع | وضعیت | سایت | RSS | عکس |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.status} | ${r.site} | ${r.rss} | ${r.image} |`),
  '',
  ...rows.filter((r) => r.rssUrl).map((r) => `- ${r.name}: \`${r.rssUrl}\``),
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
