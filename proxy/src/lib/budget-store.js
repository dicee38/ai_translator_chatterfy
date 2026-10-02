const fs = require('fs');
const path = require('path');
const { config } = require('../config');

// TZ п.3.3: суммарная стоимость нарастающим итогом за день/месяц, по
// компании в целом и по каждому сотруднику отдельно — в простом
// хранилище. Для VPS-варианта деплоя — файл на диске; для Cloudflare
// Workers это же место заменяется на KV (интерфейс ниже не меняется).
// TZ п.3.4: хранится только агрегированная стоимость, без самого контента.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'budget.json');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// Без двоеточия нарочно: rate-ключи парсятся через lastIndexOf(':') ниже
// (pruneOldRateKeys), а "HH:MM" сам содержит двоеточие — с ним
// lastIndexOf находил бы двоеточие ВНУТРИ минутки, а не разделитель между
// токеном и меткой времени, и префикс каждый раз считался бы "старым".
function minuteKey() {
  return new Date().toISOString().slice(0, 16).replace(':', ''); // YYYY-MM-DDTHHMM
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getNumber(key) {
  const store = readStore();
  return store[key] || 0;
}

function addNumber(key, delta) {
  const store = readStore();
  store[key] = (store[key] || 0) + delta;
  writeStore(store);
  return store[key];
}

function getFlag(key) {
  const store = readStore();
  return Boolean(store[key]);
}

function setFlag(key) {
  const store = readStore();
  store[key] = true;
  writeStore(store);
}

// Файловое хранилище не имеет TTL (в отличие от KV в Workers-версии) —
// без чистки ключи "rate:*" копились бы вечно. Это дешёвая защита от
// зацикливания/бага, не нужна криптографическая точность, поэтому просто
// выкидываем всё старше 5 минут при каждой записи счётчика скорости.
function pruneOldRateKeys(store) {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString().slice(0, 16).replace(':', '');
  for (const key of Object.keys(store)) {
    if (key.startsWith('rate:') && key.slice(key.lastIndexOf(':') + 1) < cutoff) {
      delete store[key];
    }
  }
}

function bumpRateCounter(token) {
  const store = readStore();
  pruneOldRateKeys(store);
  const key = `rate:${token}:${minuteKey()}`;
  store[key] = (store[key] || 0) + 1;
  writeStore(store);
  return store[key];
}

function getCompanyDailyTotalUsd() {
  return getNumber(`total:day:${todayKey()}`);
}

function getCompanyMonthlyTotalUsd() {
  return getNumber(`total:month:${monthKey()}`);
}

function getEmployeeDailyTotalUsd(token) {
  return getNumber(`emp:${token}:day:${todayKey()}`);
}

// Проверяет все уровни разом: дневной и месячный лимит компании, и (если
// задан) персональный дневной суб-лимит сотрудника — любой из них может
// сработать первым, причина возвращается отдельным полем, чтобы расширение
// могло показать осмысленное сообщение, а не общее "бюджет исчерпан".
function checkBudget(token, estimatedCostUsd) {
  const companyDaily = getCompanyDailyTotalUsd();
  if (companyDaily + estimatedCostUsd > config.dailyBudgetUsd) {
    return { exceeded: true, reason: 'company_daily' };
  }

  if (config.monthlyBudgetUsd !== null) {
    const companyMonthly = getCompanyMonthlyTotalUsd();
    if (companyMonthly + estimatedCostUsd > config.monthlyBudgetUsd) {
      return { exceeded: true, reason: 'company_monthly' };
    }
  }

  if (config.employeeDailyBudgetUsd !== null) {
    const employeeDaily = getEmployeeDailyTotalUsd(token);
    if (employeeDaily + estimatedCostUsd > config.employeeDailyBudgetUsd) {
      return { exceeded: true, reason: 'employee_daily' };
    }
  }

  return { exceeded: false };
}

// Обратная совместимость для кода, которому не нужна причина отказа.
function wouldExceedBudget(token, estimatedCostUsd) {
  return checkBudget(token, estimatedCostUsd).exceeded;
}

const ALERT_THRESHOLDS = [0.8, 1.0];

// Не блокирует ответ: шлём алерт "в фоне", ошибка вебхука не должна
// повлиять на сам перевод/расшифровку.
function sendAlertWebhook(payload) {
  if (!config.alertWebhookUrl) return;
  fetch(config.alertWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Не удалось отправить алерт о бюджете:', err.message);
  });
}

// При пересечении 80%/100% дневного бюджета компании — разовый вебхук на
// порог за день (флаг в сторе не даёт слать его на каждый следующий запрос).
function checkAndSendBudgetAlerts(employeeName) {
  if (!config.alertWebhookUrl || config.dailyBudgetUsd <= 0) return;

  const spent = getCompanyDailyTotalUsd();
  const ratio = spent / config.dailyBudgetUsd;

  for (const threshold of ALERT_THRESHOLDS) {
    if (ratio < threshold) continue;
    const flagKey = `alert:${todayKey()}:${threshold}`;
    if (getFlag(flagKey)) continue;
    setFlag(flagKey);
    sendAlertWebhook({
      type: 'budget_threshold',
      thresholdPercent: Math.round(threshold * 100),
      spentUsd: Number(spent.toFixed(4)),
      limitUsd: config.dailyBudgetUsd,
      lastEmployee: employeeName,
      date: todayKey(),
    });
  }
}

function recordCost(token, employeeName, costUsd) {
  addNumber(`total:day:${todayKey()}`, costUsd);
  addNumber(`total:month:${monthKey()}`, costUsd);
  addNumber(`emp:${token}:day:${todayKey()}`, costUsd);
  addNumber(`emp:${token}:month:${monthKey()}`, costUsd);
  checkAndSendBudgetAlerts(employeeName);
}

function getBudgetStatus(token) {
  const spent = getCompanyDailyTotalUsd();
  const status = {
    // Плоские поля — для обратной совместимости с popup.js (уже умеет их
    // читать), всегда про дневной бюджет компании в целом.
    limitUsd: config.dailyBudgetUsd,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, config.dailyBudgetUsd - spent).toFixed(4)),
    monthly: null,
    employee: null,
  };

  if (config.monthlyBudgetUsd !== null) {
    const monthlySpent = getCompanyMonthlyTotalUsd();
    status.monthly = {
      limitUsd: config.monthlyBudgetUsd,
      spentUsd: Number(monthlySpent.toFixed(4)),
      remainingUsd: Number(Math.max(0, config.monthlyBudgetUsd - monthlySpent).toFixed(4)),
    };
  }

  if (token && config.employeeDailyBudgetUsd !== null) {
    const employeeSpent = getEmployeeDailyTotalUsd(token);
    status.employee = {
      name: config.employeeTokens[token] || null,
      limitUsd: config.employeeDailyBudgetUsd,
      spentUsd: Number(employeeSpent.toFixed(4)),
      remainingUsd: Number(Math.max(0, config.employeeDailyBudgetUsd - employeeSpent).toFixed(4)),
    };
  }

  return status;
}

// Для GET /admin/usage — разбивка расхода по каждому известному сотруднику
// за сегодня, чтобы глава компании видел, кто сколько тратит, не дожидаясь
// жалоб или исчерпания лимита.
function getAdminUsageReport() {
  const employees = Object.entries(config.employeeTokens).map(([token, name]) => ({
    name,
    spentTodayUsd: Number(getEmployeeDailyTotalUsd(token).toFixed(4)),
    spentMonthUsd: Number(getNumber(`emp:${token}:month:${monthKey()}`).toFixed(4)),
  }));
  employees.sort((a, b) => b.spentTodayUsd - a.spentTodayUsd);

  return {
    date: todayKey(),
    month: monthKey(),
    company: {
      dailyLimitUsd: config.dailyBudgetUsd,
      spentTodayUsd: Number(getCompanyDailyTotalUsd().toFixed(4)),
      monthlyLimitUsd: config.monthlyBudgetUsd,
      spentMonthUsd: Number(getCompanyMonthlyTotalUsd().toFixed(4)),
    },
    employeeDailyLimitUsd: config.employeeDailyBudgetUsd,
    employees,
  };
}

// Простой fixed-window лимит запросов в минуту на токен — защита от
// зацикливания/бага/злоупотребления, не завязанная на цену конкретного
// запроса (в отличие от бюджета в долларах выше).
function checkRateLimit(token) {
  const key = `rate:${token}:${minuteKey()}`;
  const current = getNumber(key);
  return current < config.rateLimitPerMinute;
}

function recordRateLimitHit(token) {
  bumpRateCounter(token);
}

module.exports = {
  checkBudget,
  wouldExceedBudget,
  recordCost,
  getBudgetStatus,
  getAdminUsageReport,
  checkRateLimit,
  recordRateLimitHit,
};
