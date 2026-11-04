
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

// حالت پیش‌فرض همیشه آزمایشی است.
// فقط با DRY_RUN=false پردازش واقعی انجام می‌شود.
const DRY_RUN = process.env.DRY_RUN !== 'false';

const BATCH_SIZE = 50;
const REFERENCE_LIMIT = 3000;
const MIN_CATEGORY_SCORE = 2;

const STOP_WORDS = new Set([
  'از', 'به', 'در', 'با', 'برای', 'که', 'را',
  'و', 'این', 'آن', 'یک', 'تا', 'اما', 'نیز',
  'شد', 'شود', 'کرد', 'کرده', 'است', 'هست',
  'می', 'خواهد', 'بر', 'پس', 'هم', 'هر',
  'چه', 'چند', 'روی', 'بین', 'بعد', 'قبل',
]);

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL تنظیم نشده است.');
}

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

function normalizeText(value) {
  return String(value || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200c\u200f]/g, ' ')
    .replace(/ـ/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter(word =>
      word.length > 1 &&
      !STOP_WORDS.has(word)
    );
}

function similarity(first, second) {
  const a = new Set(tokenize(first));
  const b = new Set(tokenize(second));

  if (!a.size || !b.size) return 0;

  let intersection = 0;

  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = new Set([...a, ...b]).size;

  return union ? intersection / union : 0;
}

function containsPhrase(text, phrase) {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedPhrase = ` ${normalizeText(phrase)} `;

  return normalizedPhrase.trim().length > 0 &&
    normalizedText.includes(normalizedPhrase);
}

function classifyArticle(article, categories) {
  const content = `${article.title || ''} ${article.body_original || ''}`;

  const results = [];

  for (const category of categories) {
    const keywords = Array.isArray(category.keywords)
      ? category.keywords
      : [];

    let score = 0;
    const matched = [];

    for (const keyword of keywords) {
      if (!containsPhrase(content, keyword)) continue;

      const weight = normalizeText(keyword).includes(' ')
        ? 3
        : 1;

      score += weight;
      matched.push(keyword);
    }

    if (score > 0) {
      results.push({
        id: category.id,
        slug: category.slug,
        score,
        matched,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  if (!results.length || results[0].score < MIN_CATEGORY_SCORE) {
    return {
      categoryId: null,
      matches: results.slice(0, 3),
      reason: 'امتیاز کافی برای دسته‌بندی وجود ندارد',
    };
  }

  const best = results[0];
  const second = results[1];

  if (second && best.score - second.score < 2) {
    return {
      categoryId: null,
      matches: results.slice(0, 3),
      reason: 'امتیاز دسته‌های برتر به یکدیگر نزدیک است',
    };
  }

  return {
    categoryId: best.id,
    matches: results.slice(0, 3),
    reason: 'دسته‌بندی با امتیاز کافی',
  };
}

function determinePriority(article) {
  const title = article.title || '';

  const breaking = [
    'خبر فوری',
    'فوری',
    'لحظه به لحظه',
    'آخرین لحظات',
  ];

  const veryHigh = [
    'وضعیت اضطراری',
    'حمله نظامی',
    'انفجار',
    'زلزله شدید',
  ];

  const high = [
    'هشدار',
    'تعطیلی سراسری',
    'تصمیم مهم',
    'تصویب',
    'استیضاح',
  ];

  if (breaking.some(word => containsPhrase(title, word))) {
    return { score: 100, level: 'breaking' };
  }

  if (veryHigh.some(word => containsPhrase(title, word))) {
    return { score: 80, level: 'very_high' };
  }

  if (high.some(word => containsPhrase(title, word))) {
    return { score: 60, level: 'high' };
  }

  return { score: 40, level: 'normal' };
}

function findPossibleDuplicate(article, references) {
  const titleTokens = tokenize(article.title);

  if (titleTokens.length < 3) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of references) {
    if (
      String(candidate.id) === String(article.id) ||
      String(candidate.source_id) === String(article.source_id)
    ) {
      continue;
    }

    const exactTitle =
      normalizeText(article.title) ===
      normalizeText(candidate.title);

    const titleScore = similarity(
      article.title,
      candidate.title
    );

    const bodyScore = similarity(
      article.body_original,
      candidate.body_original
    );

    const score = exactTitle
      ? 1
      : titleScore * 0.65 + bodyScore * 0.35;

    const likelyDuplicate =
      exactTitle ||
      (
        titleScore >= 0.82 &&
        bodyScore >= 0.65
      );

    if (likelyDuplicate && score > bestScore) {
      bestScore = score;

      bestMatch = {
        id: candidate.id,
        source_id: candidate.source_id,
        score: Number(score.toFixed(3)),
      };
    }
  }

  return bestMatch;
}

async function loadBatch(connection, lastId) {
  if (lastId === null) {
    return connection`
      SELECT
        id,
        source_id,
        title,
        body_original,
        category_id
      FROM articles
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
      ${DRY_RUN ? connection`` : connection`FOR UPDATE`}
    `;
  }

  return connection`
    SELECT
      id,
      source_id,
      title,
      body_original,
      category_id
    FROM articles
    WHERE status = 'pending'
      AND id > ${lastId}
    ORDER BY id ASC
    LIMIT ${BATCH_SIZE}
    ${DRY_RUN ? connection`` : connection`FOR UPDATE`}
  `;
}

async function processBatch(batch, categories, references, connection) {
  const report = {
    processed: 0,
    categorized: 0,
    uncategorized: 0,
    duplicates: 0,
    priorities: {
      breaking: 0,
      very_high: 0,
      high: 0,
      normal: 0,
    },
  };

  for (const article of batch) {
    const classification = classifyArticle(article, categories);
    const priority = determinePriority(article);

    const duplicate = findPossibleDuplicate(
      article,
      references
    );

    if (!DRY_RUN) {
      const updated = await connection`
        UPDATE articles
        SET
          category_id = COALESCE(
            ${classification.categoryId},
            category_id
          ),
          priority_score = ${priority.score},
          priority_level = ${priority.level},
          verification = COALESCE(
            verification,
            'unverified'
          ),
          status = 'ready_for_review'
        WHERE id = ${article.id}
          AND status = 'pending'
        RETURNING id
      `;

      if (!updated.length) continue;

      if (duplicate) {
        await connection`
          INSERT INTO logs (
            level,
            scope,
            message,
            meta,
            created_at
          )
          VALUES (
            'warning',
            'deduplication',
            'احتمال خبر تکراری؛ نیازمند بررسی مدیر',
            ${JSON.stringify({
              article_id: article.id,
              candidate_id: duplicate.id,
              source_id: article.source_id,
              candidate_source_id: duplicate.source_id,
              similarity: duplicate.score,
            })}::jsonb,
            NOW()
          )
        `;
      }
    }

    report.processed++;

    if (classification.categoryId !== null) {
      report.categorized++;
    } else {
      report.uncategorized++;
    }

    report.priorities[priority.level]++;

    if (duplicate) report.duplicates++;

    console.log(
      JSON.stringify({
        id: article.id,
        title: article.title,
        category: classification.categoryId,
        category_reason: classification.reason,
        category_matches: classification.matches,
        priority: priority.level,
        possible_duplicate: duplicate,
        mode: DRY_RUN ? 'DRY_RUN' : 'LIVE',
      })
    );
  }

  return report;
}

function mergeReport(total, current) {
  total.processed += current.processed;
  total.categorized += current.categorized;
  total.uncategorized += current.uncategorized;
  total.duplicates += current.duplicates;

  for (const key of Object.keys(total.priorities)) {
    total.priorities[key] += current.priorities[key];
  }
}

async function main() {
  const total = {
    processed: 0,
    categorized: 0,
    uncategorized: 0,
    duplicates: 0,
    priorities: {
      breaking: 0,
      very_high: 0,
      high: 0,
      normal: 0,
    },
  };

  let lastId = null;
  let batchNumber = 0;

  console.log('================================');
  console.log(`حالت اجرا: ${DRY_RUN ? 'آزمایشی؛ بدون تغییر دیتابیس' : 'واقعی'}`);
  console.log(`اندازه هر بسته: ${BATCH_SIZE}`);
  console.log('================================');

  try {
    const categories = await sql`
      SELECT id, slug, keywords
      FROM categories
      WHERE enabled = true
      ORDER BY id
    `;

    if (!categories.length) {
      throw new Error('هیچ دسته فعال خبری در دیتابیس وجود ندارد.');
    }

    while (true) {
      let batch;

      if (DRY_RUN) {
        batch = await loadBatch(sql, lastId);
      } else {
        batch = await sql.begin(async tx => {
          const selected = await loadBatch(tx, lastId);

          if (!selected.length) return [];

          const references = await tx`
            SELECT
              id,
              source_id,
              title,
              body_original
            FROM articles
            WHERE status <> 'rejected'
              AND deleted_at IS NULL
            ORDER BY fetched_at DESC, id DESC
            LIMIT ${REFERENCE_LIMIT}
          `;

          const currentReport = await processBatch(
            selected,
            categories,
            references,
            tx
          );

          mergeReport(total, currentReport);

          return selected;
        });
      }

      if (!batch.length) break;

      if (DRY_RUN) {
        const references = await sql`
          SELECT
            id,
            source_id,
            title,
            body_original
          FROM articles
          WHERE status <> 'rejected'
            AND deleted_at IS NULL
          ORDER BY fetched_at DESC, id DESC
          LIMIT ${REFERENCE_LIMIT}
        `;

        const currentReport = await processBatch(
          batch,
          categories,
          references,
          sql
        );

        mergeReport(total, currentReport);
      }

      lastId = batch[batch.length - 1].id;
      batchNumber++;

      console.log(
        `بسته ${batchNumber} تمام شد؛ ` +
        `تعداد بررسی‌شده: ${total.processed}`
      );
    }

    console.log('\n========== نتیجه نهایی ==========');
    console.log(JSON.stringify(total, null, 2));

    if (DRY_RUN) {
      console.log(
        '\nحالت آزمایشی بود؛ هیچ تغییری در دیتابیس ثبت نشد.'
      );
    } else {
      console.log(
        '\nپردازش واقعی با موفقیت به پایان رسید.'
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای پردازش:', error);
  process.exitCode = 1;
});
