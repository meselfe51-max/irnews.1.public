import postgres from 'postgres';
import { fetchPageCategory, cleanCategory } from './source-category.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const BATCH_SIZE = 20;

if (!DATABASE_URL) throw new Error('DATABASE_URL تنظیم نشده است.');

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

async function main() {
  try {
    const articles = await sql`
      SELECT id, source_url, title, source_category
      FROM articles
      WHERE status = 'pending'
        AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
    `;

    const report = {
      checked: 0,
      already_had_category: 0,
      found_from_page: 0,
      not_found: 0,
      saved: 0,
      mode: DRY_RUN ? 'DRY_RUN' : 'LIVE',
    };

    console.log(`حالت اجرا: ${report.mode}`);
    console.log(`حداکثر خبر در این اجرا: ${BATCH_SIZE}`);

    for (const article of articles) {
      report.checked++;
      let category = cleanCategory(article.source_category);
      let origin = 'RSS';

      if (category) {
        report.already_had_category++;
      } else {
        category = await fetchPageCategory(article.source_url);
        origin = 'صفحه خبر';
        if (category) report.found_from_page++;
        else report.not_found++;
      }

      if (category && !DRY_RUN && !article.source_category) {
        const updated = await sql`
          UPDATE articles
          SET source_category = ${category}
          WHERE id = ${article.id}
            AND source_category IS NULL
          RETURNING id
        `;
        if (updated.length) report.saved++;
      }

      console.log(JSON.stringify({
        id: article.id,
        title: article.title,
        source_category: category,
        category_origin: category ? origin : null,
        result: category ? 'found' : 'not_found',
        mode: report.mode,
      }));
    }

    console.log('\\n========== گزارش ==========');
    console.log(JSON.stringify(report, null, 2));
    console.log(DRY_RUN
      ? 'حالت آزمایشی: هیچ داده‌ای در دیتابیس تغییر نکرد.'
      : 'فقط source_category خبرهای دارای دسته ذخیره شد.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای دریافت دسته‌بندی منبع:', error);
  process.exitCode = 1;
});
