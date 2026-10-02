// Workers-эквивалент proxy/src/lib/budget-store.js: та же идея (суммы
// нарастающим итогом за день/месяц, по компании и по сотруднику — TZ
// п.3.3), но хранилище — KV вместо файла на диске (Workers не имеет
// файловой системы). KV даёт TTL нативно (expirationTtl), поэтому, в
// отличие от файлового варианта, rate-limit и alert-флаги чистить вручную
// не нужно.
//
// KV не даёт атомарный инкремент — та же нежёсткая гарантия, что и у
// файлового варианта на Node (без блокировок): при двух почти
// одновременных запросах возможна мелкая потеря счёта. Для разумного
// числа операторов это не критично, отмечено как есть.

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function minuteKey() {
  return new Date().toISOString().slice(0, 16).replace(':', ''); // YYYY-MM-DDTHHMM
}

// TZ п.3.4: хранится только агрегированная стоимость, без контента.
// TTL — 2 дня для сумм (нужен только "сегодня"/"этот месяц" пересчитывается
// с нуля каждый месяц своим ключом), 2 минуты для rate-limit счётчиков.
const TOTAL_TTL_SECONDS = 60 * 60 * 24 * 2;
const RATE_TTL_SECONDS = 120;

async function getNumber(kv, key) {
  const raw = await kv.get(key);
  return raw ? Number(raw) : 0;
}

async function addNumber(kv, key, delta, ttlSeconds) {
  const total = (await getNumber(kv, key)) + delta;
  await kv.put(key, String(total), { expirationTtl: ttlSeconds });
  return total;
}

async function getCompanyDailyTotalUsd(kv) {
  return getNumber(kv, `total:day:${todayKey()}`);
}

async function getCompanyMonthlyTotalUsd(kv) {
  return getNumber(kv, `total:month:${monthKey()}`);
}

async function getEmployeeDailyTotalUsd(kv, token) {
  return getNumber(kv, `emp:${token}:day:${todayKey()}`);
}

// Проверяет дневной и месячный лимит компании и (если задан) персональный
// суб-лимит сотрудника — причина отказа возвращается отдельно, чтобы
// расширение могло показать осмысленное сообщение.
async function checkBudget(kv, cfg, token, estimatedCostUsd) {
  const companyDaily = await getCompanyDailyTotalUsd(kv);
  if (companyDaily + estimatedCostUsd > cfg.dailyBudgetUsd) {
    return { exceeded: true, reason: 'company_daily' };
  }

  if (cfg.monthlyBudgetUsd !== null) {
    const companyMonthly = await getCompanyMonthlyTotalUsd(kv);
    if (companyMonthly + estimatedCostUsd > cfg.monthlyBudgetUsd) {
      return { exceeded: true, reason: 'company_monthly' };
    }
  }

  if (cfg.employeeDailyBudgetUsd !== null) {
    const employeeDaily = await getEmployeeDailyTotalUsd(kv, token);
    if (employeeDaily + estimatedCostUsd > cfg.employeeDailyBudgetUsd) {
      return { exceeded: true, reason: 'employee_daily' };
    }
  }

  return { exceeded: false };
}

async function wouldExceedBudget(kv, cfg, token, estimatedCostUsd) {
  return (await checkBudget(kv, cfg, token, estimatedCostUsd)).exceeded;
}

const ALERT_THRESHOLDS = [0.8, 1.0];

function sendAlertWebhook(cfg, payload) {
  if (!cfg.alertWebhookUrl) return Promise.resolve();
  return fetch(cfg.alertWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Не удалось отправить алерт о бюджете:', err.message);
  });
}

// При пересечении 80%/100% дневного бюджета компании — разовый вебхук на
// порог за день. Возвращает промис(ы) алертов, чтобы вызывающий код мог
// отдать их в ctx.waitUntil и не блокировать ответ пользователю.
async function checkAndSendBudgetAlerts(kv, cfg, employeeName) {
  if (!cfg.alertWebhookUrl || cfg.dailyBudgetUsd <= 0) return;

  const spent = await getCompanyDailyTotalUsd(kv);
  const ratio = spent / cfg.dailyBudgetUsd;

  for (const threshold of ALERT_THRESHOLDS) {
    if (ratio < threshold) continue;
    const flagKey = `alert:${todayKey()}:${threshold}`;
    if (await kv.get(flagKey)) continue;
    await kv.put(flagKey, '1', { expirationTtl: TOTAL_TTL_SECONDS });
    await sendAlertWebhook(cfg, {
      type: 'budget_threshold',
      thresholdPercent: Math.round(threshold * 100),
      spentUsd: Number(spent.toFixed(4)),
      limitUsd: cfg.dailyBudgetUsd,
      lastEmployee: employeeName,
      date: todayKey(),
    });
  }
}

async function recordCost(kv, cfg, token, employeeName, costUsd) {
  await addNumber(kv, `total:day:${todayKey()}`, costUsd, TOTAL_TTL_SECONDS);
  await addNumber(kv, `total:month:${monthKey()}`, costUsd, TOTAL_TTL_SECONDS * 16); // с запасом на весь месяц
  await addNumber(kv, `emp:${token}:day:${todayKey()}`, costUsd, TOTAL_TTL_SECONDS);
  await addNumber(kv, `emp:${token}:month:${monthKey()}`, costUsd, TOTAL_TTL_SECONDS * 16);
  await checkAndSendBudgetAlerts(kv, cfg, employeeName);
}

async function getBudgetStatus(kv, cfg, token) {
  const spent = await getCompanyDailyTotalUsd(kv);
  const status = {
    limitUsd: cfg.dailyBudgetUsd,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, cfg.dailyBudgetUsd - spent).toFixed(4)),
    monthly: null,
    employee: null,
  };

  if (cfg.monthlyBudgetUsd !== null) {
    const monthlySpent = await getCompanyMonthlyTotalUsd(kv);
    status.monthly = {
      limitUsd: cfg.monthlyBudgetUsd,
      spentUsd: Number(monthlySpent.toFixed(4)),
      remainingUsd: Number(Math.max(0, cfg.monthlyBudgetUsd - monthlySpent).toFixed(4)),
    };
  }

  if (token && cfg.employeeDailyBudgetUsd !== null) {
    const employeeSpent = await getEmployeeDailyTotalUsd(kv, token);
    status.employee = {
      name: cfg.employeeTokens[token] || null,
      limitUsd: cfg.employeeDailyBudgetUsd,
      spentUsd: Number(employeeSpent.toFixed(4)),
      remainingUsd: Number(Math.max(0, cfg.employeeDailyBudgetUsd - employeeSpent).toFixed(4)),
    };
  }

  return status;
}

// Для GET /admin/usage — разбивка расхода по каждому известному сотруднику.
async function getAdminUsageReport(kv, cfg) {
  const employees = await Promise.all(
    Object.entries(cfg.employeeTokens).map(async ([token, name]) => ({
      name,
      spentTodayUsd: Number((await getEmployeeDailyTotalUsd(kv, token)).toFixed(4)),
      spentMonthUsd: Number((await getNumber(kv, `emp:${token}:month:${monthKey()}`)).toFixed(4)),
    }))
  );
  employees.sort((a, b) => b.spentTodayUsd - a.spentTodayUsd);

  return {
    date: todayKey(),
    month: monthKey(),
    company: {
      dailyLimitUsd: cfg.dailyBudgetUsd,
      spentTodayUsd: Number((await getCompanyDailyTotalUsd(kv)).toFixed(4)),
      monthlyLimitUsd: cfg.monthlyBudgetUsd,
      spentMonthUsd: Number((await getCompanyMonthlyTotalUsd(kv)).toFixed(4)),
    },
    employeeDailyLimitUsd: cfg.employeeDailyBudgetUsd,
    employees,
  };
}

// Fixed-window лимит запросов в минуту на токен — независимо от цены
// конкретного запроса, ловит зацикливание/баг/злоупотребление раньше, чем
// это стоило бы денег.
async function checkRateLimit(kv, cfg, token) {
  const key = `rate:${token}:${minuteKey()}`;
  const current = await getNumber(kv, key);
  return current < cfg.rateLimitPerMinute;
}

async function recordRateLimitHit(kv, token) {
  const key = `rate:${token}:${minuteKey()}`;
  await addNumber(kv, key, 1, RATE_TTL_SECONDS);
}

export {
  checkBudget,
  wouldExceedBudget,
  recordCost,
  getBudgetStatus,
  getAdminUsageReport,
  checkRateLimit,
  recordRateLimitHit,
};
