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
  }
} catch (error) {
  const message = String(error.message || '')
    .replace(/postgres(ql)?:\/\/\S+/g, '***');

  console.error('خطای دیتابیس:', error.code || error.name, message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
