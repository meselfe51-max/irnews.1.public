import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL تنظیم نشده است.');
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: 'require',
  max: 1,
  connect_timeout: 20
});

const sources = JSON.parse(
  readFileSync(new URL('../sources.json', import.meta.url), 'utf8')
);

try {
  let saved = 0;
  let skipped = 0;

  for (const source of sources) {
    if (!source.rss_url) {
      console.log(`SKIPPED: ${source.name} - RSS ندارد`);
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO sources (
        name,
        rss_url,
        enabled,
        interval_minutes
      )
      VALUES (
        ${source.name},
        ${source.rss_url},
        ${source.enabled !== false},
        ${source.interval_minutes || 15}
      )
      ON CONFLICT (rss_url)
      DO UPDATE SET
        name = EXCLUDED.name,
        enabled = EXCLUDED.enabled,
        interval_minutes = EXCLUDED.interval_minutes
    `;

    console.log(`SAVED: ${source.name}`);
    saved++;
  }

  const rows = await sql`
    SELECT name, rss_url, enabled, interval_minutes
    FROM sources
    ORDER BY id
  `;

  console.log('\nنتیجه انتقال منابع:');
  console.table(rows);

  console.log(`\nذخیره یا به‌روزرسانی: ${saved}`);
  console.log(`ردشده: ${skipped}`);

} catch (error) {
  console.error('خطای دیتابیس:', error.message);
  process.exitCode = 1;

} finally {
  await sql.end({ timeout: 5 });
}
