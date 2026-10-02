// Приблизительные цены для оценки стоимости запроса (бюджетный счётчик,
// TZ п.3.3). Это ПЛЕЙСХОЛДЕРЫ — проверить точные актуальные цены в
// прайсинге OpenAI перед реальными вызовами вечером (и актуальное имя
// дешёвой чат-модели — см. TODO в lib/openai.js) и поправить здесь при
// расхождении. Точный дневной лимит и так предварительный (TZ п.10),
// поэтому грубая оценка на старте — ожидаемо, не блокер.

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

// Грубая оценка токенов из длины строки без токенизатора — 4 символа на
// токен, обычное приближение для латиницы/кириллицы. Для реального
// бюджетного контроля не критична точность до токена, важно не пропустить
// сильно недооценённую стоимость.
function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateTranslateCostUsd({ text, dialectContext }) {
  const contextText = Array.isArray(dialectContext) ? dialectContext.join(' ') : '';
  const inputTokens = estimateTokensFromText(text) + estimateTokensFromText(contextText) + 200; // +200 на системный промпт
  const outputTokens = estimateTokensFromText(text) + 50; // перевод обычно похожей длины

  const inputCost = (inputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_INPUT_TOKENS_USD;
  const outputCost = (outputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_OUTPUT_TOKENS_USD;
  return inputCost + outputCost;
}

// Feature 3 (TZ п.6): контекст диалога обычно больше, чем у /translate
// (10-15 сообщений с обеих сторон, не 5-10 только входящих), и системный
// промпт длиннее (просим строгий JSON с двумя полями) — отдельная оценка,
// не переиспользуем estimateTranslateCostUsd как есть.
function estimateSuggestReplyCostUsd({ conversationContext, operatorPersona }) {
  const contextText = Array.isArray(conversationContext)
    ? conversationContext.map((m) => (m && m.text) || '').join(' ')
    : '';
  const inputTokens = estimateTokensFromText(contextText) + estimateTokensFromText(operatorPersona) + 300;
  const outputTokens = 300; // ответ + обратный перевод, обычно короткие
  const inputCost = (inputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_INPUT_TOKENS_USD;
  const outputCost = (outputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_OUTPUT_TOKENS_USD;
  return inputCost + outputCost;
}

// ФОЛБЭК, не основной путь: когда вызывающий код не знает реальную
// длительность (см. estimateTranscribeCostUsdFromDuration — именно он
// используется, когда расширение передаёт настоящую files[].meta.duration
// из Chatterfy API). Угадывание по размеру файла — крайний случай для
// мест вроде ручного curl-теста без этих данных под рукой, не для
// обычного рабочего пути через расширение.
const ASSUMED_BYTES_PER_SECOND = 2500;

function estimateTranscribeCostUsdFromFileSize(fileSizeBytes) {
  const estimatedSeconds = fileSizeBytes / ASSUMED_BYTES_PER_SECOND;
  const estimatedMinutes = estimatedSeconds / 60;
  return estimatedMinutes * TRANSCRIBE_PRICE_PER_MINUTE_USD;
}

function estimateTranscribeCostUsdFromDuration(durationSeconds) {
  return (durationSeconds / 60) * TRANSCRIBE_PRICE_PER_MINUTE_USD;
}

// Фактическая стоимость по реальному usage из ответа OpenAI — точнее
// оценки по длине строки, использовать когда она известна.
function computeChatCostUsdFromUsage(usage) {
  if (!usage) return 0;
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const inputCost = (inputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_INPUT_TOKENS_USD;
  const outputCost = (outputTokens / 1_000_000) * OPENAI_CHAT_PRICE_PER_1M_OUTPUT_TOKENS_USD;
  return inputCost + outputCost;
}

module.exports = {
  estimateTranslateCostUsd,
  estimateSuggestReplyCostUsd,
  estimateTranscribeCostUsdFromFileSize,
  estimateTranscribeCostUsdFromDuration,
  computeChatCostUsdFromUsage,
};
