// Самопроверка Workers-скелета БЕЗ wrangler/Cloudflare-аккаунта и БЕЗ
// реальных ключей: вызывает экспортированный `fetch(request, env)`
// напрямую (Workers-модуль — обычный JS с Fetch API, Node их тоже
// понимает), с фейковым KV вместо настоящего. Проверяет то же самое,
// что proxy/test/verify-skeleton.js для Node-версии: auth, роутинг,
// бюджетный счётчик — на моках.
//
// Запуск: npm run test:skeleton (из proxy/workers/).
// Это НЕ проверяет реальный деплой/wrangler dev — только логику воркера.

import worker from '../src/index.js';

const TOKEN = 'test-token-for-skeleton-check';

// Считает операции (чтобы проверять расход квоты записи) и умеет
// изображать исчерпанную суточную квоту — ровно тем сообщением, которым
// Cloudflare валит реальный kv.put() на бесплатном тарифе.
function createFakeKv({ failPut = false } = {}) {
  const store = new Map();
  const counts = { get: 0, put: 0 };
  return {
    counts,
    async get(key, options) {
      counts.get += 1;
      const raw = store.has(key) ? store.get(key) : null;
      if (raw !== null && options && options.type === 'json') {
        try {
          return JSON.parse(raw);
        } catch (_) {
          return null;
        }
      }
      return raw;
    },
    async put(key, value) {
      counts.put += 1;
      if (failPut) {
        throw new Error('KV put() limit exceeded for the day.');
      }
      store.set(key, String(value));
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    MOCK_MODE: 'true',
    EXTENSION_TOKEN: TOKEN,
    OPENAI_API_KEY: '',
    DAILY_BUDGET_USD: '5',
    BUDGET_KV: createFakeKv(),
    ...overrides,
  };
}

function translateRequest(token = TOKEN, text = 'Привет') {
  return new Request('http://local/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Extension-Token': token },
    body: JSON.stringify({ text, dialectContext: [] }),
  });
}

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures += 1;
  }
}

async function run() {
  console.log('== Health / auth / роутинг (обычный бюджет $5/день) ==');
  const env = makeEnv();

  const health = await worker.fetch(new Request('http://local/health'), env).then((r) => r.json());
  check('GET /health отвечает mockMode: true', health.mockMode === true);

  const noAuth = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', dialectContext: [] }),
    }),
    env
  );
  check('POST /translate без токена -> 401', noAuth.status === 401);

  const badAuth = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': 'wrong-token' },
      body: JSON.stringify({ text: 'hello', dialectContext: [] }),
    }),
    env
  );
  check('POST /translate с неверным токеном -> 401', badAuth.status === 401);

  const okTranslate = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ text: 'Привет, как дела?', dialectContext: ['salam', 'ca va?'] }),
    }),
    env
  );
  const okTranslateBody = await okTranslate.json();
  check('POST /translate с верным токеном -> 200', okTranslate.status === 200);
  check(
    'POST /translate возвращает мок-перевод',
    typeof okTranslateBody.translation === 'string' && okTranslateBody.translation.includes('[MOCK')
  );

  const badBody = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ dialectContext: [] }),
    }),
    env
  );
  check('POST /translate без text -> 400', badBody.status === 400);

  const fakeOggBytes = new Uint8Array(50_000).fill(7);
  const form = new FormData();
  form.append('file', new Blob([fakeOggBytes], { type: 'audio/ogg' }), 'voice.ogg');
  const okTranscribe = await worker.fetch(
    new Request('http://local/transcribe', {
      method: 'POST',
      headers: { 'X-Extension-Token': TOKEN },
      body: form,
    }),
    env
  );
  const okTranscribeBody = await okTranscribe.json();
  check('POST /transcribe с файлом и верным токеном -> 200', okTranscribe.status === 200);
  check(
    'POST /transcribe возвращает мок-расшифровку',
    typeof okTranscribeBody.transcript === 'string' && okTranscribeBody.transcript.includes('[MOCK')
  );

  const noAuthTranscribe = await worker.fetch(
    new Request('http://local/transcribe', { method: 'POST', body: new FormData() }),
    env
  );
  check('POST /transcribe без токена -> 401', noAuthTranscribe.status === 401);

  console.log('== Нулевой бюджет (проверка 429) ==');
  const zeroBudgetEnv = makeEnv({ DAILY_BUDGET_USD: '0' });
  const overBudget = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ text: 'Привет, как дела?', dialectContext: [] }),
    }),
    zeroBudgetEnv
  );
  const overBudgetBody = await overBudget.json();
  check('POST /translate при нулевом бюджете -> 429', overBudget.status === 429);
  check('POST /translate 429 содержит error: budget_exceeded', overBudgetBody.error === 'budget_exceeded');

  console.log('== EXTENSION_TOKEN не задан на сервере ==');
  const misconfiguredEnv = makeEnv({ EXTENSION_TOKEN: '' });
  const misconfigured = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    }),
    misconfiguredEnv
  );
  check('POST /translate без EXTENSION_TOKEN на сервере -> 500', misconfigured.status === 500);

  console.log('== Per-employee токены, суб-лимит, rate limit, admin ==');
  const EMP_A = 'token-employee-a';
  const EMP_B = 'token-employee-b';
  const ADMIN_TOKEN = 'test-admin-token';
  const multiEnv = makeEnv({
    EXTENSION_TOKEN: '',
    EXTENSION_TOKENS: JSON.stringify({ [EMP_A]: 'Иван', [EMP_B]: 'Мария' }),
    EMPLOYEE_DAILY_BUDGET_USD: '0',
    MONTHLY_BUDGET_USD: '50',
    ADMIN_TOKEN,
  });

  const subLimitHit = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': EMP_A },
      body: JSON.stringify({ text: 'Привет', dialectContext: [] }),
    }),
    multiEnv
  );
  const subLimitBody = await subLimitHit.json();
  check('POST /translate с нулевым персональным суб-лимитом -> 429', subLimitHit.status === 429);
  check('429 причина employee_daily', subLimitBody.reason === 'employee_daily');

  const unknownToken = await worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': 'not-a-real-employee-token' },
      body: JSON.stringify({ text: 'Привет', dialectContext: [] }),
    }),
    multiEnv
  );
  check('POST /translate с неизвестным токеном -> 401', unknownToken.status === 401);

  const noAdminToken = await worker.fetch(new Request('http://local/admin/usage'), multiEnv);
  check('GET /admin/usage без токена -> 401', noAdminToken.status === 401);

  const adminReport = await worker.fetch(
    new Request('http://local/admin/usage', { headers: { 'X-Admin-Token': ADMIN_TOKEN } }),
    multiEnv
  );
  const adminReportBody = await adminReport.json();
  check('GET /admin/usage с верным токеном -> 200', adminReport.status === 200);
  check(
    'GET /admin/usage содержит разбивку по сотрудникам (Иван, Мария)',
    Array.isArray(adminReportBody.employees) &&
    adminReportBody.employees.some((e) => e.name === 'Иван') &&
    adminReportBody.employees.some((e) => e.name === 'Мария')
  );
  check('GET /admin/usage содержит месячный лимит компании', adminReportBody.company.monthlyLimitUsd === 50);

  console.log('== Rate limit ==');
  const rateEnv = makeEnv({ RATE_LIMIT_PER_MINUTE: '2' });
  const makeRateReq = () => worker.fetch(
    new Request('http://local/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Extension-Token': TOKEN },
      body: JSON.stringify({ text: 'Привет', dialectContext: [] }),
    }),
    rateEnv
  );
  await makeRateReq();
  await makeRateReq();
  const thirdRateReq = await makeRateReq();
  const thirdRateBody = await thirdRateReq.json();
  check('POST /translate после превышения лимита запросов/мин -> 429', thirdRateReq.status === 429);
  check('429 содержит error: rate_limited', thirdRateBody.error === 'rate_limited');

  // Регрессия, из-за которой прокси отваливался в проде: на бесплатном
  // тарифе KV даёт 1000 записей в сутки, а старая реализация писала пять
  // ключей на каждый платный запрос (счётчик запросов/мин + четыре суммы),
  // то есть квота кончалась примерно на 200-м переводе, и дальше kv.put()
  // бросал "KV put() limit exceeded for the day" прямо из обработчика.
  console.log('== Расход квоты записи KV (1000/сутки на бесплатном тарифе) ==');
  const quotaKv = createFakeKv();
  const quotaEnv = makeEnv({ BUDGET_KV: quotaKv, RATE_LIMIT_PER_MINUTE: '1000' });

  const BURST = 50;
  for (let i = 0; i < BURST; i += 1) {
    const res = await worker.fetch(translateRequest(), quotaEnv);
    if (res.status !== 200) {
      check(`все ${BURST} запросов подряд успешны (запрос №${i + 1} -> ${res.status})`, false);
      break;
    }
  }
  check(
    `${BURST} переводов подряд укладываются в 1 запись KV (фактически ${quotaKv.counts.put})`,
    quotaKv.counts.put <= 1
  );
  check(
    'старая реализация потратила бы 5 записей на запрос — теперь это не линейно от числа запросов',
    quotaKv.counts.put < BURST
  );

  // Отложенная запись не должна означать "лимиты перестали считаться":
  // несброшенный расход обязан учитываться проверкой бюджета из памяти.
  console.log('== Лимит соблюдается до сброса в KV ==');
  const unflushedKv = createFakeKv();
  const unflushedEnv = makeEnv({
    BUDGET_KV: unflushedKv,
    DAILY_BUDGET_USD: '0.0005',
    RATE_LIMIT_PER_MINUTE: '1000',
  });

  let unflushedBlockedAt = 0;
  for (let i = 1; i <= 20; i += 1) {
    const res = await worker.fetch(translateRequest(), unflushedEnv);
    if (res.status === 429) {
      unflushedBlockedAt = i;
      break;
    }
  }
  check(
    `дневной бюджет $0.0005 исчерпывается и отдаёт 429 (на запросе №${unflushedBlockedAt})`,
    unflushedBlockedAt > 0
  );

  const unflushedStatus = await worker
    .fetch(new Request('http://local/health', { headers: { 'X-Extension-Token': TOKEN } }), unflushedEnv)
    .then((r) => r.json());
  check('GET /health показывает ещё не сброшенный в KV расход', unflushedStatus.budget.spentUsd > 0);

  // Самое важное: даже когда квота записи реально исчерпана, запрос
  // пользователя должен выполниться, а не превратиться в 500.
  console.log('== Исчерпанная квота записи KV не роняет запросы ==');
  const brokenKv = createFakeKv({ failPut: true });
  const brokenEnv = makeEnv({ BUDGET_KV: brokenKv, RATE_LIMIT_PER_MINUTE: '1000' });

  let brokenFailures = 0;
  let brokenTranslation = '';
  for (let i = 0; i < 10; i += 1) {
    const res = await worker.fetch(translateRequest(), brokenEnv);
    if (res.status !== 200) {
      brokenFailures += 1;
    } else {
      brokenTranslation = (await res.json()).translation;
    }
  }
  check('при падении kv.put() переводы продолжают отдаваться с 200', brokenFailures === 0);
  check('ответ при недоступной записи KV — всё ещё настоящий перевод', brokenTranslation.includes('[MOCK'));

  const brokenStatus = await worker
    .fetch(new Request('http://local/health', { headers: { 'X-Extension-Token': TOKEN } }), brokenEnv)
    .then((r) => r.json());
  check('расход не потерян и виден в /health, хотя в KV записать не удалось', brokenStatus.budget.spentUsd > 0);

  const putsAfterBackoff = brokenKv.counts.put;
  await worker.fetch(translateRequest(), brokenEnv);
  check(
    'после ошибки квоты повторные попытки записи не долбятся на каждый запрос',
    brokenKv.counts.put === putsAfterBackoff
  );

  console.log('');
  if (failures > 0) {
    console.error(`Провалено проверок: ${failures}`);
    process.exit(1);
  } else {
    console.log('Все проверки Workers-скелета прошли (auth, роутинг, бюджет на фейковом KV) — без wrangler/аккаунта Cloudflare и без единого реального вызова модели.');
  }
}

run().catch((err) => {
  console.error('Ошибка самопроверки:', err);
  process.exit(1);
});
