// Самопроверка скелета прокси БЕЗ реальных ключей: поднимает сервер в
// MOCK_MODE=true дважды (с обычным и с нулевым бюджетом) и curl'ит его же
// через fetch, проверяя авторизацию, роутинг и бюджетный счётчик.
// Запуск: npm run test:skeleton (из папки proxy/).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const TOKEN = 'test-token-for-skeleton-check';
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUDGET_FILE = path.join(DATA_DIR, 'budget.json');

function resetBudgetFile() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

function startServer({ port, dailyBudgetUsd, extraEnv }) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_MODE: 'true',
      EXTENSION_TOKEN: TOKEN,
      DAILY_BUDGET_USD: String(dailyBudgetUsd),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  return {
    child,
    getStderr: () => stderr,
  };
}

function waitForHealth(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://localhost:${port}/health`);
          if (res.ok) return resolve();
        } catch (_) {
          // сервер ещё не поднялся
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      reject(new Error('сервер не ответил на /health вовремя'));
    })();
  });
}

async function run() {
  resetBudgetFile();
  let failures = 0;

  const check = (label, cond) => {
    if (cond) {
      console.log(`  OK   ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
      failures += 1;
    }
  };

  // --- Сервер №1: обычный бюджет, проверяем health/auth/routing/happy-path ---
  console.log('== Сервер #1 (обычный бюджет $5/день) ==');
  const port1 = 8797;
  const server1 = startServer({ port: port1, dailyBudgetUsd: 5 });
  try {
    await waitForHealth(port1);

    const health = await fetch(`http://localhost:${port1}/health`).then((r) => r.json());
    check('GET /health отвечает mockMode: true', health.mockMode === true);

    const noAuth = await fetch(`http://localhost:${port1}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', dialectContext: [] }),
    });
    check('POST /translate без токена -> 401', noAuth.status === 401);

    const badAuth = await fetch(`http://localhost:${port1}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': 'wrong-token' },
      body: JSON.stringify({ text: 'hello', dialectContext: [] }),
    });
    check('POST /translate с неверным токеном -> 401', badAuth.status === 401);

    const okTranslate = await fetch(`http://localhost:${port1}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ text: 'Привет, как дела?', dialectContext: ['salam', 'ca va?'] }),
    });
    const okTranslateBody = await okTranslate.json();
    check('POST /translate с верным токеном -> 200', okTranslate.status === 200);
    check('POST /translate возвращает мок-перевод', typeof okTranslateBody.translation === 'string' && okTranslateBody.translation.includes('[MOCK'));

    const badBody = await fetch(`http://localhost:${port1}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ dialectContext: [] }),
    });
    check('POST /translate без text -> 400', badBody.status === 400);

    const fakeOggBuffer = Buffer.from('fake ogg bytes for skeleton test'.repeat(50));
    const form = new FormData();
    form.append('file', new Blob([fakeOggBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    const okTranscribe = await fetch(`http://localhost:${port1}/transcribe`, {
      method: 'POST',
      headers: { 'X-Extension-Token': TOKEN },
      body: form,
    });
    const okTranscribeBody = await okTranscribe.json();
    check('POST /transcribe с файлом и верным токеном -> 200', okTranscribe.status === 200);
    check('POST /transcribe возвращает мок-расшифровку', typeof okTranscribeBody.transcript === 'string' && okTranscribeBody.transcript.includes('[MOCK'));

    const noAuthTranscribe = await fetch(`http://localhost:${port1}/transcribe`, { method: 'POST', body: new FormData() });
    check('POST /transcribe без токена -> 401', noAuthTranscribe.status === 401);

  } finally {
    server1.child.kill();
  }

  // --- Сервер №2: нулевой бюджет, проверяем 429 сразу на первом запросе ---
  console.log('== Сервер #2 (нулевой бюджет, проверка 429) ==');
  const port2 = 8798;
  const server2 = startServer({ port: port2, dailyBudgetUsd: 0 });
  try {
    await waitForHealth(port2);

    const overBudget = await fetch(`http://localhost:${port2}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ text: 'Привет, как дела?', dialectContext: [] }),
    });
    const overBudgetBody = await overBudget.json();
    check('POST /translate при нулевом бюджете -> 429', overBudget.status === 429);
    check('POST /translate 429 содержит error: budget_exceeded', overBudgetBody.error === 'budget_exceeded');
  } finally {
    server2.child.kill();
  }

  resetBudgetFile();

  // --- Сервер №3: мульти-токен (per-employee), суб-лимит, rate limit, admin ---
  console.log('== Сервер #3 (per-employee токены, суб-лимит, rate limit, admin) ==');
  const port3 = 8799;
  const EMP_A = 'token-employee-a';
  const EMP_B = 'token-employee-b';
  const ADMIN_TOKEN = 'test-admin-token';
  const server3 = startServer({
    port: port3,
    dailyBudgetUsd: 5,
    extraEnv: {
      EXTENSION_TOKEN: '',
      EXTENSION_TOKENS: JSON.stringify({ [EMP_A]: 'Иван', [EMP_B]: 'Мария' }),
      EMPLOYEE_DAILY_BUDGET_USD: '0',
      MONTHLY_BUDGET_USD: '50',
      RATE_LIMIT_PER_MINUTE: '2',
      ADMIN_TOKEN,
    },
  });
  try {
    await waitForHealth(port3);

    const empAReq = () => fetch(`http://localhost:${port3}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': EMP_A },
      body: JSON.stringify({ text: 'Привет', dialectContext: [] }),
    });

    const subLimitHit = await empAReq();
    const subLimitBody = await subLimitHit.json();
    check('POST /translate с нулевым персональным суб-лимитом -> 429', subLimitHit.status === 429);
    check('429 причина employee_daily', subLimitBody.reason === 'employee_daily');

    const unknownToken = await fetch(`http://localhost:${port3}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': 'not-a-real-employee-token' },
      body: JSON.stringify({ text: 'Привет', dialectContext: [] }),
    });
    check('POST /translate с неизвестным токеном -> 401', unknownToken.status === 401);

    const noAdminToken = await fetch(`http://localhost:${port3}/admin/usage`);
    check('GET /admin/usage без токена -> 401', noAdminToken.status === 401);

    const adminReport = await fetch(`http://localhost:${port3}/admin/usage`, {
      headers: { 'X-Admin-Token': ADMIN_TOKEN },
    });
    const adminReportBody = await adminReport.json();
    check('GET /admin/usage с верным токеном -> 200', adminReport.status === 200);
    check(
      'GET /admin/usage содержит разбивку по сотрудникам (Иван, Мария)',
      Array.isArray(adminReportBody.employees) &&
      adminReportBody.employees.some((e) => e.name === 'Иван') &&
      adminReportBody.employees.some((e) => e.name === 'Мария')
    );
    check('GET /admin/usage содержит месячный лимит компании', adminReportBody.company.monthlyLimitUsd === 50);
  } finally {
    server3.child.kill();
  }

  resetBudgetFile();

  // --- Сервер №4: rate limit без бюджетного суб-лимита (чтобы не путать причины 429) ---
  console.log('== Сервер #4 (rate limit) ==');
  const port4 = 8800;
  const server4 = startServer({
    port: port4,
    dailyBudgetUsd: 5,
    extraEnv: { RATE_LIMIT_PER_MINUTE: '2' },
  });
  try {
    await waitForHealth(port4);

    const makeReq = () => fetch(`http://localhost:${port4}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ text: 'Привет', dialectContext: [] }),
    });

    await makeReq();
    await makeReq();
    const thirdReq = await makeReq();
    const thirdBody = await thirdReq.json();
    check('POST /translate после превышения лимита запросов/мин -> 429', thirdReq.status === 429);
    check('429 содержит error: rate_limited', thirdBody.error === 'rate_limited');
  } finally {
    server4.child.kill();
  }

  resetBudgetFile();

  console.log('');
  if (failures > 0) {
    console.error(`Провалено проверок: ${failures}`);
    process.exit(1);
  } else {
    console.log('Все проверки скелета прошли (auth, роутинг, бюджет) — без единого реального вызова модели.');
  }
}

run().catch((err) => {
  console.error('Ошибка самопроверки:', err);
  process.exit(1);
});
