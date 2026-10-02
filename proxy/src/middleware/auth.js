const { config } = require('../config');

// TZ п.3.2: токен в заголовке X-Extension-Token. Теперь токенов может быть
// несколько — по одному на сотрудника компании (config.employeeTokens),
// это и даёт персональные суб-лимиты/разбивку расхода (budget-store.js),
// и позволяет отозвать доступ одному сотруднику, не трогая остальных.
// Токен можно вытащить из расширения, как и ключ модели — это ожидаемо и
// ограничивается бюджетным лимитом, а не секретностью самого токена.
function requireExtensionToken(req, res, next) {
  const provided = req.get('X-Extension-Token');
  const employeeName = provided && config.employeeTokens[provided];

  if (!provided || !employeeName) {
    return res.status(401).json({ error: 'unauthorized', message: 'Неверный или отсутствующий X-Extension-Token.' });
  }

  req.employeeToken = provided;
  req.employeeName = employeeName;
  next();
}

// Отдельный секрет для админского эндпоинта — не должен быть одним из
// операторских токенов (те раздаются сотрудникам и считаются утечкоспособными).
function requireAdminToken(req, res, next) {
  const provided = req.get('X-Admin-Token');

  if (!config.adminToken || !provided || provided !== config.adminToken) {
    return res.status(401).json({ error: 'unauthorized', message: 'Неверный или отсутствующий X-Admin-Token.' });
  }

  next();
}

module.exports = { requireExtensionToken, requireAdminToken };
