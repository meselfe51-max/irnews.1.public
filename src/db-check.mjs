import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('❌ DATABASE_URL تنظیم نشده؛ اسم Secret را چک کنید');
  process.exit(1);
}

const sql = postgres(url, { ssl: 'require', max: 1, prepare: false, connect_timeout: 15 });

const EXPECTED = [
  'admin_sessions', 'admins', 'ai_usage', 'article_versions', 'articles',
  'categories', 'events', 'login_attempts', 'logs', 'settings', 'sources',
];

try {
  const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
  const have = rows.map((r) => r.table_name);
  console.log('جدول‌های موجود:', have.join(', ') || '(هیچ)');

  const missing = EXPECTED.filter((t) => !have.includes(t));
  console.log(missing.length ? `❌ جدول‌های ناموجود: ${missing.join(', ')}` : '✅ هر ۱۱ جدول وجود دارد');

  if (!missing.length) {
    const [c] = await sql`
      select
        (select count(*)::int from sources) as sources,
        (select count(*)::int from categories) as categories,
        (select count(*)::int from settings) as settings,
        (select count(*)::int from articles) as articles
    `;
    console.log('تعداد ردیف‌ها:', JSON.stringify(c));
  }
} catch (err) {
  const msg = String(err.message || '').replace(/postgres(ql)?:\/\/\S+/g, '***');
  console.error('❌ اتصال یا کوئری شکست خورد:', err.code || err.name, '-', msg);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
