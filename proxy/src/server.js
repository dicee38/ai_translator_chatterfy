const express = require('express');
const { config, assertStartupInvariants } = require('./config');
const { requireExtensionToken } = require('./middleware/auth');
const { getBudgetStatus } = require('./lib/budget-store');
const translateRoute = require('./routes/translate');
const transcribeRoute = require('./routes/transcribe');
const suggestReplyRoute = require('./routes/suggest-reply');
const adminRoute = require('./routes/admin');

assertStartupInvariants();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Без обязательной авторизации (чисто для проверки, что процесс жив и в
// каком он режиме) — но если X-Extension-Token передан и валиден, в ответе
// дополнительно появляется персональный суб-лимит именно этого сотрудника
// (budget.employee), не только общий бюджет компании.
app.get('/health', (req, res) => {
  const provided = req.get('X-Extension-Token');
  const token = provided && config.employeeTokens[provided] ? provided : null;
  res.json({ ok: true, mockMode: config.mockMode, budget: getBudgetStatus(token) });
});

// Свой токен (X-Admin-Token), не операторский — должен быть доступен
// главе компании без прохождения общей авторизации сотрудников.
app.use(adminRoute);

app.use(requireExtensionToken);

app.use(translateRoute);
app.use(transcribeRoute);
app.use(suggestReplyRoute);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Внутренняя ошибка прокси.' });
});

app.listen(config.port, () => {
  console.log(`Прокси запущен на http://localhost:${config.port} (MOCK_MODE=${config.mockMode})`);
});
