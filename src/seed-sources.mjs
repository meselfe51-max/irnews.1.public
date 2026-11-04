// Reads sources.json and saves the sources into the database.
// Safe to run many times (updates instead of duplicating).

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add it in GitHub: Settings > Secrets and variables > Actions.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 20 });

const sources = JSON.parse(
  readFileSync(new URL('../sources.json', import.meta.url), 'utf8')
);

try {
  let saved = 0;
  for (const s of sources) {
    if (!s.rss_url) {
      console.log(`Skipped (no rss_url): ${s.name}`);
      continue;
    }
    await sql`
      insert into sources (name, rss_url, enabled)
      values (${s.name}, ${s.rss_url}, ${s.enabled !== false})
      on conflict (rss_url) do update
        set name = excluded.name, enabled = excluded.enabled
    `;
    console.log(`Saved: ${s.name}`);
    saved++;
  }
  const rows = await sql`select count(*)::int as n from sources`;
  console.log(`Done. Saved now: ${saved}. Total sources in database: ${rows[0].n}`);
} catch (e) {
  console.error('Database error:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
