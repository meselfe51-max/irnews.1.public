import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not configured.");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: "require",
  max: 1,
  prepare: false,
  connect_timeout: 15
});

try {
  await sql.begin(async tx => {
    await tx`
      ALTER TABLE articles
        ADD COLUMN IF NOT EXISTS telegram_delivery_status text NOT NULL DEFAULT 'not_sent',
        ADD COLUMN IF NOT EXISTS telegram_delivery_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS telegram_delivery_error text,
        ADD COLUMN IF NOT EXISTS telegram_sent_at timestamptz
    `;
    await tx`
      CREATE INDEX IF NOT EXISTS articles_telegram_delivery_idx
      ON articles (telegram_delivery_status, published_at DESC)
      WHERE status = 'published' AND deleted_at IS NULL
    `;
  });

  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'articles'
      AND column_name IN (
        'telegram_delivery_status',
        'telegram_delivery_attempts',
        'telegram_delivery_error',
        'telegram_sent_at'
      )
    ORDER BY column_name
  `;
  const expected = 4;
  if (columns.length !== expected) throw new Error(`Expected ${expected} delivery columns, found ${columns.length}`);
  console.log("SUCCESS: Telegram delivery tracking schema is ready.");
  console.log(columns.map(row => row.column_name).join(", "));
} catch (error) {
  console.error("Migration failed:", error.code || error.name, error.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
