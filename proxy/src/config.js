require('dotenv').config();

const MOCK_MODE = process.env.MOCK_MODE === 'true';

// `||` тут был бы багом: DAILY_BUDGET_USD=0 (валидное значение, "лимит
// исчерпан всегда") — falsy, `Number('0') || 5` тихо подменило бы его на 5.
function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
}

// Та же логика, но для опциональных лимитов без дефолта: отсутствие
// значения -> null ("лимит не задан"), а не какое-то число по умолчанию.
function nullableNumberFromEnv(value) {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Сотрудники компании-клиента: каждому — свой токен, чтобы можно было
// (а) считать расход по отдельности, (б) ограничивать отдельного
// сотрудника суб-лимитом, (в) отозвать доступ одному, не трогая остальных.
// EXTENSION_TOKENS — JSON {"токен": "имя сотрудника", ...}. Если его нет,
// используется старый одиночный EXTENSION_TOKEN как один "default"-токен —
// это сохраняет обратную совместимость с уже задеплоенными инсталляциями,
// которые ставили один токен на всех.
function parseEmployeeTokens(rawJson, legacySingleToken) {
  const map = {};

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      for (const [token, name] of Object.entries(parsed)) {
        if (token) map[token] = String(name || token);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('EXTENSION_TOKENS не распарсился как JSON, игнорирую:', err.message);
    }
  }

  if (Object.keys(map).length === 0 && legacySingleToken) {
    map[legacySingleToken] = 'default';
  }

  return map;
}

const config = {
  port: numberFromEnv(process.env.PORT, 8787),
  mockMode: MOCK_MODE,
  extensionToken: process.env.EXTENSION_TOKEN || '',
  // Один вендор на всё: транскрипция (TZ п.5.2) и перевод/умный ответ
  // (TZ п.4.2, 6.2) теперь оба на OpenAI — один ключ, не два.
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  dailyBudgetUsd: numberFromEnv(process.env.DAILY_BUDGET_USD, 5),
  // null = не ограничен (только дневной лимит действует). Защита от
  // медленного перерасхода, который дневной лимит не ловит — каждый день
  // укладываются, а за месяц набегает больше, чем глава компании ожидал.
  monthlyBudgetUsd: nullableNumberFromEnv(process.env.MONTHLY_BUDGET_USD),
  // null = нет персонального потолка, только общий бюджет компании.
  // Если задан — ни один сотрудник не потратит за день больше этой суммы,
  // даже если в общем бюджете ещё есть место (защита от одного активного
  // сотрудника, съедающего весь дневной лимит компании в одиночку).
  employeeDailyBudgetUsd: nullableNumberFromEnv(process.env.EMPLOYEE_DAILY_BUDGET_USD),
  employeeTokens: parseEmployeeTokens(process.env.EXTENSION_TOKENS, process.env.EXTENSION_TOKEN),
  // Защита от зацикливания/бага, а не от дорогих запросов — лимит на
  // количество запросов в минуту с одного токена, независимо от суммы.
  rateLimitPerMinute: numberFromEnv(process.env.RATE_LIMIT_PER_MINUTE, 20),
  // Если задан — при пересечении порога расхода (80% и 100% дневного
  // бюджета компании) шлём POST с коротким JSON на этот адрес, чтобы глава
  // компании узнал не постфактум из жалоб сотрудников, а сразу.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  // Отдельный секрет для GET /admin/usage — не должен совпадать с
  // операторскими токенами (те достаются каждому сотруднику и могут утечь
  // из расширения так же, как ключ модели).
  adminToken: process.env.ADMIN_TOKEN || '',
};

// Fail closed, not open: без токена авторизация бессмысленна (TZ п.3.2),
// без ключей вне мок-режима реальные вызовы всё равно провалятся —
// лучше не стартовать вообще, чем стартовать и тихо 500-ить на каждый запрос.
function assertStartupInvariants() {
  const problems = [];

  if (Object.keys(config.employeeTokens).length === 0) {
    problems.push('Ни EXTENSION_TOKENS, ни EXTENSION_TOKEN не заданы — авторизация прокси невозможна (TZ п.3.2).');
  }

  if (!config.mockMode) {
    if (!config.openaiApiKey) {
      problems.push('MOCK_MODE=false, но OPENAI_API_KEY пуст.');
    }
  }

  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Прокси не запущен, обнаружены проблемы конфигурации:\n' + problems.map((p) => '  - ' + p).join('\n'));
    process.exit(1);
  }
}

module.exports = { config, assertStartupInvariants };
