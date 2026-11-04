
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL تنظیم نشده است.');
}

const sql = postgres(databaseUrl, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

function normalizePersian(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ۀ/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/[ـ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupByTitle(articles) {
  const groups = new Map();

  for (const article of articles) {
    const normalized = normalizePersian(article.title);

    if (!normalized) continue;

    if (!groups.has(normalized)) {
      groups.set(normalized, []);
    }

    groups.get(normalized).push(article);
  }

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      title: group[0].title,
      articles: group.map(article => ({
        id: article.id,
        source: article.source_name,
      })),
    }));
}

async function main() {
  try {
    console.log('شروع بررسی فقط‌خواندنی اخبار...');

    const articles = await sql`
      SELECT
        a.id,
        a.title,
        a.body_original,
        a.source_url,
        a.status,
        s.name AS source_name
      FROM articles a
      LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.status = 'pending'
      ORDER BY a.id
    `;

    const emptyTitles = articles.filter(
      article => !normalizePersian(article.title)
    );

    const emptyBodies = articles.filter(
      article => !String(article.body_original || '').trim()
    );

    const shortTitles = articles.filter(
      article => normalizePersian(article.title).length < 5
    );

    const duplicateCandidates = groupByTitle(articles);

    const report = {
      mode: 'READ_ONLY',
      totalPending: articles.length,
      validTitles: articles.length - emptyTitles.length,
      emptyTitles: emptyTitles.map(a => a.id),
      emptyBodies: emptyBodies.map(a => a.id),
      shortTitles: shortTitles.map(a => ({
        id: a.id,
        title: a.title,
      })),
      exactTitleDuplicateGroups: duplicateCandidates,
      duplicateCandidateCount: duplicateCandidates.length,
      databaseModified: false,
    };

    console.log('\nگزارش بررسی:');
    console.log(JSON.stringify(report, null, 2));

  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای بررسی اخبار:', error.message);
  process.exitCode = 1;
});
