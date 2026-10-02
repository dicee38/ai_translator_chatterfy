const { checkBudget, getBudgetStatus, checkRateLimit, recordRateLimitHit } = require('../lib/budget-store');
const { config } = require('../config');

const REASON_MESSAGES = {
  company_daily: 'Дневной лимит бюджета компании на перевод/расшифровку исчерпан. Попробуйте завтра.',
  company_monthly: 'Месячный лимит бюджета компании исчерпан. Попробуйте в следующем месяце.',
  employee_daily: 'Ваш персональный дневной лимит исчерпан. Остальные сотрудники компании могут продолжать пользоваться сервисом.',
};

// Лимит на количество запросов в минуту с одного токена — отдельно от
// бюджета в долларах. Ловит зацикливание/баг раньше, чем это стоило бы
// денег: даже дешёвый запрос, повторённый 200 раз за минуту, подозрителен.
function enforceRateLimit(req, res, next) {
  if (!checkRateLimit(req.employeeToken)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `Слишком много запросов (лимит ${config.rateLimitPerMinute}/мин). Подождите немного.`,
    });
  }

  recordRateLimitHit(req.employeeToken);
  next();
}

// TZ п.3.3: при превышении лимита — 429 с понятным телом, не молчаливое
// продолжение трат. Расширение показывает это как отдельное UI-состояние
// ("дневной лимит исчерпан"), не как обычную сетевую ошибку — поэтому
// error: 'budget_exceeded' должен быть стабильным, различимым полем.
function enforceBudget(estimateCostUsd) {
  return (req, res, next) => {
    const estimatedCostUsd = estimateCostUsd(req);
    const result = checkBudget(req.employeeToken, estimatedCostUsd);

    if (result.exceeded) {
      return res.status(429).json({
        error: 'budget_exceeded',
        reason: result.reason,
        message: REASON_MESSAGES[result.reason],
        budget: getBudgetStatus(req.employeeToken),
      });
    }

    req.estimatedCostUsd = estimatedCostUsd;
    next();
  };
}

module.exports = { enforceBudget, enforceRateLimit };
