
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

const BATCH_SIZE = 200;
const REFERENCE_LIMIT = 5000;

function normalizeText(value) {
  return String(value || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u200c/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenize(value) {
  const stopWords = new Set([
    'از', 'به', 'در', 'با', 'برای', 'که',
    'را', 'و', 'این', 'آن', 'یک', 'تا',
    'اما', 'نیز', 'شد', 'شود', 'کرد',
    'کرده', 'است', 'هست', 'می', 'خواهد',
  ]);

  return new Set(
    normalizeText(value)
      .split(' ')
      .filter(word => word.length > 1 && !stopWords.has(word))
  );
}

function similarity(first, second) {
  const a = tokenize(first);
  const b = tokenize(second);

  if (!a.size || !b.size) return 0;

  let intersection = 0;

  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = new Set([...a, ...b]).size;

  return union ? intersection / union : 0;
}

function findCategory(article, categories) {
  const text = normalizeText(
    `${article.title} ${article.body_original || ''}`
  );

  let bestCategory = null;
  let bestScore = 0;

  for (const category of categories) {
    const keywords = Array.isArray(category.keywords)
      ? category.keywords
      : [];

    let score = 0;

    for (const keyword of keywords) {
      const normalizedKeyword = normalizeText(keyword);

      if (
        normalizedKeyword.length >= 2 &&
        text.includes(normalizedKeyword)
      ) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category.id;
    }
  }

  return bestCategory;
}

function determinePriority(article) {
  const title = normalizeText(article.title);

  const breakingWords = [
    'خبر فوری',
    'فوری',
    'لحظه ای',
    'فوریه',
  ];

  const veryHighWords = [
    'زلزله',
    'انفجار',
    'سیل',
    'آتش سوزی',
    'بحران',
    'اضطراری',
  ];

  const highWords = [
    'تعطیلی',
    'هشدار',
    'تصمیم مهم',
    'افزایش قیمت',
    'کاهش قیمت',
    'تصویب',
  ];

  if (breakingWords.some(word => title.includes(word))) {
    return { score: 100, level: 'breaking' };
  }

  if (veryHighWords.some(word => title.includes(word))) {
    return { score: 80, level: 'very_high' };
  }

  if (highWords.some(word => title.includes(word))) {
    return { score: 60, level: 'high' };
  }

  return { score: 40, level: 'normal' };
}

function findPossibleDuplicate(article, references) {
  const title = normalizeText(article.title);

  if (!title) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of references) {
    if (
      candidate.id === article.id ||
      candidate.source_id === article.source_id
    ) {
      continue;
    }

    const candidateTitle = normalizeText(candidate.title);

    if (!candidateTitle) continue;

    const exactTitle = title === candidateTitle;
    const titleScore = similarity(article.title, candidate.title);

    const bodyScore = similarity(
      article.body_original,
      candidate.body_original
    );

    const isLikelyDuplicate =
      exactTitle ||
      (
        tokenize(article.title).size >= 4 &&
        titleScore >= 0.90 &&
        bodyScore >= 0.72
      );

    if (isLikelyDuplicate) {
      const score = exactTitle
        ? 1
        : titleScore * 0.7 + bodyScore * 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          id: candidate.id,
          source_id: candidate.source_id,
          score: Number(score.toFixed(3)),
        };
      }
    }
  }

  return bestMatch;
}

async function main() {
  try {
    const result = await sql.begin(async tx => {
      const categories = await tx`
        SELECT id, name, slug, keywords
        FROM categories
        WHERE enabled = true
        ORDER BY id
      `;

      const articles = await tx`
        SELECT
          id,
          source_id,
          title,
          body_original,
          category_id,
          verification
        FROM articles
        WHERE status = 'pending'
        ORDER BY priority_score DESC NULLS LAST, fetched_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      console.log(`اخبار در صف پردازش: ${articles.length}`);

      if (!articles.length) {
        return {
          processed: 0,
          duplicates: 0,
          categorized: 0,
        };
      }

      const references = await tx`
        SELECT id, source_id, title, body_original
        FROM articles
        ORDER BY fetched_at DESC
        LIMIT ${REFERENCE_LIMIT}
      `;

      let processed = 0;
      let duplicates = 0;
      let categorized = 0;

      for (const article of articles) {
        const categoryId = findCategory(article, categories);
        const priority = determinePriority(article);

        const duplicate = findPossibleDuplicate(
          article,
          references
        );

        await tx`
          UPDATE articles
          SET
            category_id = COALESCE(${categoryId}, category_id),
            priority_score = ${priority.score},
            priority_level = ${priority.level},
            verification = COALESCE(verification, 'unverified'),
            status = 'ready_for_review'
          WHERE id = ${article.id}
            AND status = 'pending'
        `;

        if (categoryId !== null) {
          categorized++;
        }

        if (duplicate) {
          duplicates++;

          await tx`
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
              'احتمال خبر تکراری شناسایی شد؛ نیازمند بررسی مدیر',
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

        processed++;

        console.log(
          `پردازش خبر ${article.id} | ` +
          `دسته: ${categoryId ?? 'نامشخص'} | ` +
          `اولویت: ${priority.level} | ` +
          `تکراری احتمالی: ${duplicate ? 'بله' : 'خیر'}`
        );
      }

      return {
        processed,
        duplicates,
        categorized,
      };
    });

    console.log('\nنتیجه پردازش:');
    console.log(JSON.stringify(result, null, 2));

  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای پردازش اخبار:', error.message);
  process.exitCode = 1;
});
