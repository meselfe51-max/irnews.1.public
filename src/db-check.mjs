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
    ORDER BY table_name
  `;

  const existing = rows.map(row => row.table_name);

  console.log('جدول‌های موجود:');
  console.log(existing.join(', '));

  const missing = EXPECTED.filter(
    table => !existing.includes(table)
  );

  if (missing.length > 0) {
    console.error('\nجدول‌های ناموجود:');
    console.error(missing.join(', '));

    process.exitCode = 1;

  } else {
    console.log('\nSUCCESS: هر ۱۱ جدول وجود دارند.');

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

  console.error(
    'خطای دیتابیس:',
    error.code || error.name,
    message
  );

  process.exitCode = 1;

} finally {
  await sql.end({ timeout: 5 });
}
