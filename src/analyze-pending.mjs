
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL تنظیم نشده است.');
}

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 1,
  connect_timeout: 15,
  prepare: false,
});

const BATCH_SIZE = 50;
const REFERENCE_LIMIT = 3000;
const DUPLICATE_THRESHOLD = 0.82;
const MIN_TITLE_TOKENS = 4;

const STOP_WORDS = new Set([
  'از', 'به', 'در', 'با', 'برای', 'که', 'را',
  'و', 'این', 'آن', 'یک', 'تا', 'اما', 'نیز',
  'شد', 'شود', 'کرد', 'کرده', 'است', 'هست',
  'می', 'خواهد', 'بر', 'پس', 'هم', 'هر',
  'چه', 'چند', 'روی', 'بین', 'بعد', 'قبل',
]);

function normalizeText(value) {
  return String(value || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200c\u200f]/g, ' ')
    .replace(/[ـ]/g, '')
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

function classifyArticle(article, categories) {
  const text = normalizeText(
    `${article.title} ${article.body_original || ''}`
  );

  const results = [];

  for (const category of categories) {
    const keywords = Array.isArray(category.keywords)
      ? category.keywords
      : [];

    let score = 0;
    const matched = [];

    for (const keyword of keywords) {
      const normalized = normalizeText(keyword);

      if (!normalized || normalized.length < 2) continue;

      const escaped = normalized.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      const pattern = new RegExp(
        `(^| )${escaped}( |$)`,
        'u'
      );

      if (pattern.test(text)) {
        score += normalized.includes(' ') ? 3 : 1;
        matched.push(keyword);
      }
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

  if (!results.length) {
    return {
      categoryId: null,
      matches: [],
    };
  }

  const best = results[0];
  const second = results[1];

  // If two categories have very close scores,
  // do not assign an uncertain category automatically.
  if (second && best.score - second.score < 2) {
    return {
      categoryId: null,
      matches: results.slice(0, 3),
    };
  }

  return {
    categoryId: best.id,
    matches: results.slice(0, 3),
  };
}

function determinePriority(article) {
  const title = normalizeText(article.title);

  const breaking = [
    'خبر فوری',
    'فوری',
    'لحظه ای',
  ];

  const veryHigh = [
    'انفجار',
    'زلزله',
    'سیل',
    'آتش سوزی',
    'وضعیت اضطراری',
  ];

  const high = [
    'هشدار',
    'تعطیلی',
    'تصمیم مهم',
    'افزایش قیمت',
    'کاهش قیمت',
    'تصویب',
  ];

  if (breaking.some(word => title.includes(word))) {
    return { score: 100, level: 'breaking' };
  }

  if (veryHigh.some(word => title.includes(word))) {
    return { score: 80, level: 'very_high' };
  }

  if (high.some(word => title.includes(word))) {
    return { score: 60, level: 'high' };
  }

  return { score: 40, level: 'normal' };
}

function findPossibleDuplicate(article, references) {
  const titleTokens = tokenize(article.title);

  if (titleTokens.length < MIN_TITLE_TOKENS) {
    return null;
  }

  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of references) {
    if (
      candidate.id === article.id ||
      candidate.source_id === article.source_id
    ) {
      continue;
    }

    const titleScore = similarity(
      article.title,
      candidate.title
    );

    const bodyScore = similarity(
      article.body_original,
      candidate.body_original
    );

    const exactTitle =
      normalizeText(article.title) ===
      normalizeText(candidate.title);

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

async function main() {
  try {
    const result = await sql.begin(async tx => {
      const categories = await tx`
        SELECT id, slug, keywords
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
          category_id
        FROM articles
        WHERE status = 'pending'
        ORDER BY fetched_at ASC, id ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      console.log(`تعداد اخبار انتخاب‌شده: ${articles.length}`);

      if (!articles.length) {
        return {
          processed: 0,
          duplicates: 0,
          categorized: 0,
        };
      }

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

      let processed = 0;
      let duplicates = 0;
      let categorized = 0;

      for (const article of articles) {
        const classification = classifyArticle(
          article,
          categories
        );

        const priority = determinePriority(article);

        const duplicate = findPossibleDuplicate(
          article,
          references
        );

        const updated = await tx`
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

        if (classification.categoryId !== null) {
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

        processed++;

        console.log(
          `خبر ${article.id}: ` +
          `دسته=${classification.categoryId ?? 'نامشخص'}، ` +
          `اولویت=${priority.level}، ` +
          `تکراری=${duplicate ? 'احتمالی' : 'خیر'}`
        );
      }

      return {
        processed,
        duplicates,
        categorized,
        remaining: Math.max(0, articles.length - processed),
      };
    });

    console.log('\nنتیجه نهایی:');
    console.log(JSON.stringify(result, null, 2));

  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error('خطای پردازش:', error.message);
  process.exitCode = 1;
});
