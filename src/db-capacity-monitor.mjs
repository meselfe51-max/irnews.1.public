import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const limitBytes = Number(process.env.DB_STORAGE_LIMIT_BYTES);

if (!databaseUrl) throw new Error('DATABASE_URL تنظیم نشده است.');
if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
  console.warn('DB_STORAGE_LIMIT_BYTES تنظیم نشده؛ پایش ظرفیت تا زمان تنظیم این Secret اجرا نمی‌شود.');
  process.exit(0);
}

const sql = postgres(databaseUrl, {
  ssl: 'require',
  max: 1,
  prepare: false,
  connect_timeout: 15,
});

async function sendTelegram(message) {
  if (!botToken || !chatId) {
    console.warn('هشدار ظرفیت محاسبه شد اما TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
    signal: AbortSignal.timeout(15000),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(`ارسال هشدار تلگرام ناموفق بود: HTTP ${response.status}`);
  }
  return true;
}

try {
  await sql`
    CREATE TABLE IF NOT EXISTS system_alert_state (
      alert_key TEXT PRIMARY KEY,
      alert_level TEXT NOT NULL,
      last_value_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const [usage] = await sql`
    SELECT
      pg_database_size(current_database())::bigint AS used_bytes,
      current_database() AS database_name
  `;

  const usedBytes = Number(usage.used_bytes);
  const percent = (usedBytes / limitBytes) * 100;
  const level = percent >= 90 ? 'critical' : percent >= 80 ? 'warning' : 'normal';

  const [previous] = await sql`
    SELECT alert_level
    FROM system_alert_state
    WHERE alert_key = 'database_storage'
  `;

  const previousLevel = previous?.alert_level || 'normal';
  const formatBytes = value => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    return `${size.toFixed(2)} ${units[unit]}`;
  };

  console.log(JSON.stringify({
    database: usage.database_name,
    used_bytes: usedBytes,
    limit_bytes: limitBytes,
    used_percent: Number(percent.toFixed(2)),
    alert_level: level,
    previous_level: previousLevel,
  }, null, 2));

  if (level !== previousLevel) {
    let message;

    if (level === 'critical') {
      message = `🚨 هشدار بحرانی ظرفیت دیتابیس

مصرف: ${percent.toFixed(1)}٪
فضای مصرف‌شده: ${formatBytes(usedBytes)}
ظرفیت تنظیم‌شده: ${formatBytes(limitBytes)}
فضای باقی‌مانده: ${formatBytes(Math.max(0, limitBytes - usedBytes))}

برای جلوگیری از توقف ذخیره خبرها، ظرفیت Neon را افزایش بده یا فضای مصرفی را مدیریت کن.`;
    } else if (level === 'warning') {
      message = `⚠️ هشدار ظرفیت دیتابیس

مصرف: ${percent.toFixed(1)}٪
فضای مصرف‌شده: ${formatBytes(usedBytes)}
ظرفیت تنظیم‌شده: ${formatBytes(limitBytes)}
فضای باقی‌مانده: ${formatBytes(Math.max(0, limitBytes - usedBytes))}

بهتر است برای افزایش ظرفیت برنامه‌ریزی کنی.`;
    } else if (previousLevel !== 'normal') {
      message = `✅ وضعیت ظرفیت دیتابیس عادی شد.

مصرف فعلی: ${percent.toFixed(1)}٪
فضای مصرف‌شده: ${formatBytes(usedBytes)}
ظرفیت تنظیم‌شده: ${formatBytes(limitBytes)}`;
    }

    let alertDelivered = true;
    if (message) {
      alertDelivered = await sendTelegram(message);
    }

    if (alertDelivered) {
      await sql`
        INSERT INTO system_alert_state (alert_key, alert_level, last_value_bytes, updated_at)
        VALUES ('database_storage', ${level}, ${usedBytes}, NOW())
        ON CONFLICT (alert_key) DO UPDATE SET
          alert_level = EXCLUDED.alert_level,
          last_value_bytes = EXCLUDED.last_value_bytes,
          updated_at = NOW()
      `;
    } else {
      console.warn('هشدار ارسال نشد؛ سطح هشدار ثبت نشد تا در اجرای بعدی دوباره تلاش شود.');
    }
  } else {
    await sql`
      UPDATE system_alert_state
      SET last_value_bytes = ${usedBytes}, updated_at = NOW()
      WHERE alert_key = 'database_storage'
    `;
  }
} finally {
  await sql.end({ timeout: 5 });
}
