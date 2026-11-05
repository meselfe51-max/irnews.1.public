import postgres from 'postgres';

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL تنظیم نشده است.');
  process.exit(1);
}

const sql = postgres(url, {
  ssl: 'require',
  max: 1,
  prepare: false,
  connect_timeout: 15
});

const EXPECTED = [
  'admin_sessions',
  'admins',
  'ai_usage',
  'article_versions',
  'articles',
  'categories',
  'events',
  'login_attempts',
  'logs',
  'settings',
  'sources'
];

try {
  const rows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;

  const existing = rows.map(row => row.table_name);
  const missing = EXPECTED.filter(table => !existing.includes(table));

  console.log('جدول‌های موجود:');
  console.log(existing.join(', '));

  if (missing.length > 0) {
    console.error('\nجدول‌های ناموجود:', missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log('\nSUCCESS: هر ۱۱ جدول وجود دارند.');
  }

  if (existing.includes('articles')) {
    const columns = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'articles'
        AND column_name = 'source_category'
    `;

    if (columns.length === 0) {
      console.error('MISSING: ستون articles.source_category وجود ندارد.');
      process.exitCode = 1;
    } else {
      const column = columns[0];
      console.log('articles.source_category:', JSON.stringify(column));

      if (column.data_type !== 'text') {
        console.error('INVALID TYPE: نوع source_category باید text باشد.');
        process.exitCode = 1;
      } else {
        console.log('SUCCESS: ستون source_category با نوع text موجود است.');
      }
    }

    const [counts] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM sources) AS sources,
        (SELECT COUNT(*)::int FROM categories) AS categories,
        (SELECT COUNT(*)::int FROM settings) AS settings,
        (SELECT COUNT(*)::int FROM articles) AS articles
    `;

    console.log('\nتعداد رکوردها:');
    console.log(JSON.stringify(counts, null, 2));

    // Read-only audit: verify actual source-category coverage and distribution.
    const [categoryCoverage] = await sql`
      SELECT
        COUNT(*)::int AS total_articles,
        COUNT(*) FILTER (
          WHERE source_category IS NOT NULL AND BTRIM(source_category) <> ''
        )::int AS with_source_category,
        COUNT(*) FILTER (
          WHERE source_category IS NULL OR BTRIM(source_category) = ''
        )::int AS without_source_category,
        COUNT(DISTINCT BTRIM(source_category)) FILTER (
          WHERE source_category IS NOT NULL AND BTRIM(source_category) <> ''
        )::int AS distinct_source_categories,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_articles
      FROM articles
    `;

    console.log('\nگزارش پوشش دسته‌بندی منبع (فقط خواندنی):');
    console.log(JSON.stringify(categoryCoverage, null, 2));

    const categoryDistribution = await sql`
      SELECT
        BTRIM(source_category) AS source_category,
        COUNT(*)::int AS article_count
      FROM articles
      WHERE source_category IS NOT NULL
        AND BTRIM(source_category) <> ''
      GROUP BY BTRIM(source_category)
      ORDER BY article_count DESC, source_category
      LIMIT 30
    `;

    console.log('\n۳۰ دسته پرتکرار منبع:');
    console.log(JSON.stringify(categoryDistribution, null, 2));
  }
    const sourceCoverage = await sql`
      SELECT
        COALESCE(s.name, 'منبع نامشخص') AS source_name,
        COUNT(a.id)::int AS total_articles,
        COUNT(a.id) FILTER (
          WHERE a.source_category IS NOT NULL AND BTRIM(a.source_category) <> ''
        )::int AS with_source_category,
        COUNT(a.id) FILTER (
          WHERE a.source_category IS NULL OR BTRIM(a.source_category) = ''
        )::int AS without_source_category,
        COUNT(DISTINCT BTRIM(a.source_category)) FILTER (
          WHERE a.source_category IS NOT NULL AND BTRIM(a.source_category) <> ''
        )::int AS distinct_categories
      FROM articles a
      LEFT JOIN sources s ON s.id = a.source_id
      GROUP BY s.name
      ORDER BY total_articles DESC, source_name
    `;

    console.log('\nپوشش دسته‌بندی به تفکیک خبرگزاری (فقط خواندنی):');
    console.log(JSON.stringify(sourceCoverage, null, 2));

    const pendingWithoutCategory = await sql`
      SELECT COUNT(*)::int AS pending_without_source_category
      FROM articles
      WHERE status = 'pending'
        AND deleted_at IS NULL
        AND (source_category IS NULL OR BTRIM(source_category) = '')
    `;

    console.log('\nاخبار در انتظار بدون دسته منبع:');
    console.log(JSON.stringify(pendingWithoutCategory[0], null, 2));
} catch (error) {
  const message = String(error.message || '')
    .replace(/postgres(ql)?:\/\/\S+/g, '***');

  console.error('خطای دیتابیس:', error.code || error.name, message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
