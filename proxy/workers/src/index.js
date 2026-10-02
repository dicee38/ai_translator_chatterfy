import { config as buildConfig } from './config.js';
import * as budgetStore from './lib/budget-store.js';
import * as openai from './lib/openai.js';
import { estimateTranslateCostUsd, estimateTranscribeCostUsdFromFileSize, estimateTranscribeCostUsdFromDuration, estimateSuggestReplyCostUsd } from './lib/pricing.js';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // тот же лимит, что у multer в Node-версии

function parseDurationSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REASON_MESSAGES = {
  company_daily: 'Дневной лимит бюджета компании на перевод/расшифровку исчерпан. Попробуйте завтра.',
  company_monthly: 'Месячный лимит бюджета компании исчерпан. Попробуйте в следующем месяце.',
  employee_daily: 'Ваш персональный дневной лимит исчерпан. Остальные сотрудники компании могут продолжать пользоваться сервисом.',
};

function budgetExceededResponse(reason, budget) {
  return json(
    {
      error: 'budget_exceeded',
      reason,
      message: REASON_MESSAGES[reason],
      budget,
    },
    429
  );
}

function rateLimitedResponse(cfg) {
  return json(
    {
      error: 'rate_limited',
      message: `Слишком много запросов (лимит ${cfg.rateLimitPerMinute}/мин). Подождите немного.`,
    },
    429
  );
}

// Общая проверка rate-limit + бюджета перед выполнением платного вызова —
// одна и та же логика нужна всем трём маршрутам, вынесена, чтобы не
// дублировать трижды.
async function enforceLimits(env, cfg, token, estimatedCostUsd) {
  if (!(await budgetStore.checkRateLimit(env.BUDGET_KV, cfg, token))) {
    return rateLimitedResponse(cfg);
  }
  await budgetStore.recordRateLimitHit(env.BUDGET_KV, token);

  const result = await budgetStore.checkBudget(env.BUDGET_KV, cfg, token, estimatedCostUsd);
  if (result.exceeded) {
    return budgetExceededResponse(result.reason, await budgetStore.getBudgetStatus(env.BUDGET_KV, cfg, token));
  }

  return null;
}

// Без обязательной авторизации — но если X-Extension-Token передан и
// валиден, добавляет персональный суб-лимит этого сотрудника (budget.employee).
async function handleHealth(request, cfg, env) {
  const provided = request.headers.get('X-Extension-Token');
  const token = provided && cfg.employeeTokens[provided] ? provided : null;
  const budget = await budgetStore.getBudgetStatus(env.BUDGET_KV, cfg, token);
  return json({ ok: true, mockMode: cfg.mockMode, budget });
}

async function handleAdminUsage(request, cfg, env) {
  const provided = request.headers.get('X-Admin-Token');
  if (!cfg.adminToken || !provided || provided !== cfg.adminToken) {
    return json({ error: 'unauthorized', message: 'Неверный или отсутствующий X-Admin-Token.' }, 401);
  }
  return json(await budgetStore.getAdminUsageReport(env.BUDGET_KV, cfg));
}

// TZ п.3.1: POST /translate { text, dialectContext, targetLang? } -> { translation }
async function handleTranslate(request, cfg, env, auth) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_request', message: 'Тело запроса должно быть JSON.' }, 400);
  }

  const { text, dialectContext, targetLang } = body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return json({ error: 'bad_request', message: 'Поле text обязательно и должно быть непустой строкой.' }, 400);
  }
  if (dialectContext !== undefined && !Array.isArray(dialectContext)) {
    return json({ error: 'bad_request', message: 'Поле dialectContext должно быть массивом строк.' }, 400);
  }
  // 'to_dialect' — перевод в диалект собеседника (написание ответа, как в
  // TZ п.4.2), 'to_operator_language' — обратное (чтение входящего). Любое
  // другое/отсутствующее значение — безопасный дефолт 'to_dialect'.
  const direction = body.direction === 'to_operator_language' ? 'to_operator_language' : 'to_dialect';

  const estimatedCostUsd = estimateTranslateCostUsd({ text, dialectContext });
  const limitResponse = await enforceLimits(env, cfg, auth.token, estimatedCostUsd);
  if (limitResponse) return limitResponse;

  const result = await openai.translate(cfg, { text, dialectContext: dialectContext || [], targetLang, direction });

  // TZ п.3.4: в KV уходит только стоимость, не текст.
  await budgetStore.recordCost(env.BUDGET_KV, cfg, auth.token, auth.name, result.costUsd);

  return json({ translation: result.translation });
}

// TZ п.3.1: POST /transcribe multipart/form-data, поле file -> { transcript, language? }
async function handleTranscribe(request, cfg, env, auth) {
  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return json({ error: 'bad_request', message: 'Ожидается multipart/form-data.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'bad_request', message: 'Поле file (multipart) обязательно.' }, 400);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return json({ error: 'bad_request', message: 'Файл слишком большой (лимит 25MB).' }, 400);
  }

  const durationSeconds = parseDurationSeconds(form.get('durationSeconds'));
  const estimatedCostUsd = durationSeconds !== undefined
    ? estimateTranscribeCostUsdFromDuration(durationSeconds)
    : estimateTranscribeCostUsdFromFileSize(file.size);
  const limitResponse = await enforceLimits(env, cfg, auth.token, estimatedCostUsd);
  if (limitResponse) return limitResponse;

  // В памяти, не на диск — Workers и так не имеет файловой системы, так
  // что "не хранить аудио дольше необходимого" (TZ п.3.4) выполняется
  // автоматически, не только по договорённости.
  const fileBuffer = new Uint8Array(await file.arrayBuffer());
  const result = await openai.transcribe(cfg, { fileBuffer, fileName: file.name, mimeType: file.type, durationSeconds });

  await budgetStore.recordCost(env.BUDGET_KV, cfg, auth.token, auth.name, result.costUsd);

  return json({ transcript: result.transcript, language: result.language });
}

function isValidConversationContext(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((m) => m && (m.role === 'operator' || m.role === 'interlocutor') && typeof m.text === 'string' && m.text.trim())
  );
}

// TZ п.3.1: POST /suggest-reply { conversationContext } -> { replyInDialect, backTranslationRu }
async function handleSuggestReply(request, cfg, env, auth) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_request', message: 'Тело запроса должно быть JSON.' }, 400);
  }

  const { conversationContext, operatorPersona } = body || {};
  if (!isValidConversationContext(conversationContext)) {
    return json(
      {
        error: 'bad_request',
        message: 'Поле conversationContext обязательно: непустой массив { role: "operator"|"interlocutor", text: string }.',
      },
      400
    );
  }
  if (operatorPersona !== undefined && typeof operatorPersona !== 'string') {
    return json({ error: 'bad_request', message: 'Поле operatorPersona, если задано, должно быть строкой.' }, 400);
  }

  const estimatedCostUsd = estimateSuggestReplyCostUsd({ conversationContext, operatorPersona });
  const limitResponse = await enforceLimits(env, cfg, auth.token, estimatedCostUsd);
  if (limitResponse) return limitResponse;

  const result = await openai.suggestReply(cfg, { conversationContext, operatorPersona });

  // TZ п.3.4: в KV уходит только стоимость, не текст диалога.
  await budgetStore.recordCost(env.BUDGET_KV, cfg, auth.token, auth.name, result.costUsd);

  return json({ replyInDialect: result.replyInDialect, backTranslationRu: result.backTranslationRu });
}

export default {
  async fetch(request, env) {
    const cfg = buildConfig(env);
    const url = new URL(request.url);

    // Без авторизации, чисто для проверки, что воркер жив и в каком режиме.
    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth(request, cfg, env);
    }

    // Отдельный X-Admin-Token, не операторский — должен быть доступен главе
    // компании без прохождения общей авторизации сотрудников.
    if (request.method === 'GET' && url.pathname === '/admin/usage') {
      return handleAdminUsage(request, cfg, env);
    }

    if (Object.keys(cfg.employeeTokens).length === 0) {
      // Fail closed: без токена(ов) авторизация бессмысленна (TZ п.3.2) —
      // та же логика, что assertStartupInvariants в Node-версии, но Workers
      // не может "не стартовать", поэтому отказываем на каждый запрос.
      return json({ error: 'server_misconfigured', message: 'Ни EXTENSION_TOKENS, ни EXTENSION_TOKEN не заданы на сервере.' }, 500);
    }

    const provided = request.headers.get('X-Extension-Token');
    const employeeName = provided && cfg.employeeTokens[provided];
    if (!provided || !employeeName) {
      return json({ error: 'unauthorized', message: 'Неверный или отсутствующий X-Extension-Token.' }, 401);
    }
    const auth = { token: provided, name: employeeName };

    if (request.method === 'POST' && url.pathname === '/translate') {
      return handleTranslate(request, cfg, env, auth);
    }
    if (request.method === 'POST' && url.pathname === '/transcribe') {
      return handleTranscribe(request, cfg, env, auth);
    }
    if (request.method === 'POST' && url.pathname === '/suggest-reply') {
      return handleSuggestReply(request, cfg, env, auth);
    }

    return json({ error: 'not_found', message: 'Неизвестный маршрут.' }, 404);
  },
};
