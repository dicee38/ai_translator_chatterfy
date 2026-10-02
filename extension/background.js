// Service worker: единственное место в расширении, которое реально ходит
// в прокси. Content script никогда не ходит туда напрямую — шлёт
// сообщение сюда, это исключает зависимость от CSP/CORS конкретной
// страницы Chatterfy и держит сетевой код прокси в одном месте.
// Адрес прокси и токен настраиваются через попап (этап 5, popup.js),
// хранятся в chrome.storage.local; дефолты на случай, если оператор ещё
// ничего не сохранял, — см. shared-defaults.js.
importScripts('shared-defaults.js');

// TODO(вечер): CFT_DEFAULT_EXTENSION_TOKEN в shared-defaults.js должен
// совпадать с EXTENSION_TOKEN из proxy/.env на реальном/локальном прокси
// (или просто сохраните свой токен через попап — он переживёт дефолт).
async function getProxyConfig() {
  const stored = await chrome.storage.local.get(['proxyBaseUrl', 'extensionToken']);
  return {
    proxyBaseUrl: stored.proxyBaseUrl || CFT_DEFAULT_PROXY_BASE_URL,
    extensionToken: stored.extensionToken || CFT_DEFAULT_EXTENSION_TOKEN,
  };
}

async function handleTranslate({ text, dialectContext, targetLang, direction }) {
  const { proxyBaseUrl, extensionToken } = await getProxyConfig();

  let response;
  try {
    response = await fetch(`${proxyBaseUrl}/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Token': extensionToken,
      },
      body: JSON.stringify({ text, dialectContext: dialectContext || [], targetLang, direction }),
    });
  } catch (err) {
    return { ok: false, kind: 'network_error', message: 'Не удалось связаться с прокси.' };
  }

  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    // error: 'rate_limited' — лимит запросов/минуту (TZ, вопрос "как не дать
    // сотруднику зациклиться"), отдельно от 'budget_exceeded' — закончились
    // деньги. Разные причины, разное сообщение оператору.
    const kind = body.error === 'rate_limited' ? 'rate_limited' : 'budget_exceeded';
    return { ok: false, kind, message: body.message || 'Дневной лимит бюджета на перевод исчерпан.' };
  }

  if (!response.ok) {
    return { ok: false, kind: 'network_error', message: `Прокси вернул ошибку ${response.status}.` };
  }

  const data = await response.json().catch(() => null);
  if (!data || typeof data.translation !== 'string') {
    return { ok: false, kind: 'network_error', message: 'Прокси вернул неожиданный ответ.' };
  }

  return { ok: true, translation: data.translation };
}

// Живьём выяснилось (этап 1, docs/TZ.md §5.2): OpenAI определяет формат
// аудио по РАСШИРЕНИЮ имени файла в multipart, не по Content-Type — имя
// без расширения даёт 400 "Unsupported file format". Голосовые Chatterfy
// не всегда .ogg (бывает и .mp3), поэтому берём расширение из самого URL.
function guessFileName(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const base = pathname.split('/').pop();
    if (base && /\.\w+$/.test(base)) return base;
  } catch (err) {
    // не критично — просто используем фолбэк ниже
  }
  return 'voice.ogg';
}

// Feature 2 (TZ п.5.2): скачивание голосового — тоже здесь, а не в content
// script. Bucket с голосовыми — сторонний домен (S3), нужен в
// host_permissions manifest.json; скачивание из background обходит
// зависимость от CORS-заголовков самого бакета (см. рассуждение в шапке
// файла про причину, по которой прокси вообще дёргается отсюда).
async function handleTranscribe({ url, durationSeconds }) {
  const { proxyBaseUrl, extensionToken } = await getProxyConfig();

  let audioResponse;
  try {
    audioResponse = await fetch(url);
  } catch (err) {
    return { ok: false, kind: 'network_error', message: 'Не удалось скачать голосовое сообщение.' };
  }
  if (!audioResponse.ok) {
    return { ok: false, kind: 'network_error', message: `Не удалось скачать голосовое (${audioResponse.status}).` };
  }

  const buffer = await audioResponse.arrayBuffer();
  const contentType = audioResponse.headers.get('content-type') || 'application/octet-stream';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), guessFileName(url));
  // Реальная длительность из Chatterfy API (files[].meta.duration) — прокси
  // использует её для точного расчёта бюджета вместо угадывания по размеру
  // файла (см. docs/TZ.md §5.2 про разрыв между счётчиком и фактом).
  if (typeof durationSeconds === 'number') {
    form.append('durationSeconds', String(durationSeconds));
  }

  let response;
  try {
    response = await fetch(`${proxyBaseUrl}/transcribe`, {
      method: 'POST',
      headers: { 'X-Extension-Token': extensionToken },
      body: form,
    });
  } catch (err) {
    return { ok: false, kind: 'network_error', message: 'Не удалось связаться с прокси.' };
  }

  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const kind = body.error === 'rate_limited' ? 'rate_limited' : 'budget_exceeded';
    return { ok: false, kind, message: body.message || 'Дневной лимит бюджета исчерпан.' };
  }

  if (!response.ok) {
    return { ok: false, kind: 'network_error', message: `Прокси вернул ошибку ${response.status}.` };
  }

  const data = await response.json().catch(() => null);
  if (!data || typeof data.transcript !== 'string') {
    return { ok: false, kind: 'network_error', message: 'Прокси вернул неожиданный ответ.' };
  }

  return { ok: true, transcript: data.transcript, language: data.language };
}

// Feature 3 (TZ п.6, "перспектива" — сделана после того, как Feature 1 и 2
// обкатаны в реальном использовании).
async function handleSuggestReply({ conversationContext, operatorPersona }) {
  const { proxyBaseUrl, extensionToken } = await getProxyConfig();

  let response;
  try {
    response = await fetch(`${proxyBaseUrl}/suggest-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Token': extensionToken,
      },
      body: JSON.stringify({ conversationContext, operatorPersona }),
    });
  } catch (err) {
    return { ok: false, kind: 'network_error', message: 'Не удалось связаться с прокси.' };
  }

  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const kind = body.error === 'rate_limited' ? 'rate_limited' : 'budget_exceeded';
    return { ok: false, kind, message: body.message || 'Дневной лимит бюджета исчерпан.' };
  }

  if (!response.ok) {
    return { ok: false, kind: 'network_error', message: `Прокси вернул ошибку ${response.status}.` };
  }

  const data = await response.json().catch(() => null);
  if (!data || typeof data.replyInDialect !== 'string' || typeof data.backTranslationRu !== 'string') {
    return { ok: false, kind: 'network_error', message: 'Прокси вернул неожиданный ответ.' };
  }

  return { ok: true, replyInDialect: data.replyInDialect, backTranslationRu: data.backTranslationRu };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'translate') {
    handleTranslate(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, kind: 'network_error', message: String(err) }));
    return true; // ответ асинхронный
  }
  if (message && message.type === 'transcribe') {
    handleTranscribe(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, kind: 'network_error', message: String(err) }));
    return true; // ответ асинхронный
  }
  if (message && message.type === 'suggestReply') {
    handleSuggestReply(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, kind: 'network_error', message: String(err) }));
    return true; // ответ асинхронный
  }
  return false;
});
