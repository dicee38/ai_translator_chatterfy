// Дублирует proxy/src/lib/pricing.js — держать в синхроне вручную.
// Не шарится между Node- и Workers-версией прокси напрямую: разные
// системы модулей (CommonJS vs Workers ESM) и разные деплой-таргеты,
// а сам файл — чистые вычисления без I/O, дублировать дешевле, чем
// городить cross-runtime import ради ~50 строк.
//
// Приблизительные цены для оценки стоимости запроса (бюджетный счётчик,
// TZ п.3.3). Это ПЛЕЙСХОЛДЕРЫ — проверить точные актуальные цены в
// прайсинге OpenAI перед реальными вызовами и поправить здесь при
// расхождении (см. также TODO в lib/openai.js про имя модели).

const OPENAI_CHAT_PRICE_PER_1M_INPUT_TOKENS_USD = 0.4;
const OPENAI_CHAT_PRICE_PER_1M_OUTPUT_TOKENS_USD = 1.6;

// Подтверждено официальным прайсингом OpenAI (developers.openai.com/api/docs/pricing,
// проверено 2026-10-02): gpt-transcribe — $0.0045/мин.
//
// Предыдущее значение $0.05/мин было МЕТОДОЛОГИЧЕСКОЙ ОШИБКОЙ, не просто
// устаревшей цифрой: "калибровка" на этапе 1 поделила наш же счётчик
// (посчитанный по estimateTranscribeCostUsdFromFileSize — оценке
// ДЛИТЕЛЬНОСТИ ПО РАЗМЕРУ ФАЙЛА) на РЕАЛЬНУЮ длительность из
// Chatterfy API (meta.duration) — две разные величины длительности
// смешались в одной дроби. Если угаданная по размеру длительность была
// завышена, туда же "утекла" и цена за минуту — отсюда разрыв в разы
// между счётчиком и фактом, на который справедливо указал оператор.
const TRANSCRIBE_PRICE_PER_MINUTE_USD = 0.0045;

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateTranslateCostUsd({ text, dialectContext }) {
  const contextText = Array.isArray(dialectContext) ? dialectContext.join(' ') : '';
  const inputTokens = estimateTokensFromText(text) + estimateTokensFromText(contextText) + 200;
  const outputTokens = estimateTokensFromText(text) + 50;

  const inputCost = (inputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_INPUT_TOKENS_USD;
  const outputCost = (outputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_OUTPUT_TOKENS_USD;
  return inputCost + outputCost;
}

// ФОЛБЭК, не основной путь: когда вызывающий код не знает реальную
// длительность (см. estimateTranscribeCostUsdFromDuration — именно он
// используется, когда расширение передаёт настоящую files[].meta.duration
// из Chatterfy API).
const ASSUMED_BYTES_PER_SECOND = 2500;

export function estimateTranscribeCostUsdFromFileSize(fileSizeBytes) {
  const estimatedSeconds = fileSizeBytes / ASSUMED_BYTES_PER_SECOND;
  const estimatedMinutes = estimatedSeconds / 60;
  return estimatedMinutes * TRANSCRIBE_PRICE_PER_MINUTE_USD;
}

export function estimateTranscribeCostUsdFromDuration(durationSeconds) {
  return (durationSeconds / 60) * TRANSCRIBE_PRICE_PER_MINUTE_USD;
}

// Фактическая стоимость по реальному usage из ответа OpenAI (точнее
// оценки по длине строки из estimateTranslateCostUsd) — считать бюджетный
// расход по факту, когда он известен, а не по грубой прикидке до вызова.
export function computeChatCostUsdFromUsage(usage) {
  if (!usage) return 0;
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const inputCost = (inputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_INPUT_TOKENS_USD;
  const outputCost = (outputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_OUTPUT_TOKENS_USD;
  return inputCost + outputCost;
}
