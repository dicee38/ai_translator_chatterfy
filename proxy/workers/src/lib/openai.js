import {
  estimateTranscribeCostUsdFromFileSize,
  estimateTranscribeCostUsdFromDuration,
  estimateTranslateCostUsd,
  computeChatCostUsdFromUsage,
} from './pricing.js';

// Живая проверка показала: инструкция "ответь только переводом, без
// пояснений", зашитая внутрь user-сообщения, не всегда соблюдается —
// на неоднозначном/грязном тексте модель иногда отвечала целым
// рассуждением ("похоже, это казахский язык... примерный смысл...")
// вместо чистого перевода. Вынесено в отдельное system-сообщение —
// модели заметно надёжнее следуют системным инструкциям, чем тем же
// текстом внутри user-хода.
const TRANSLATE_SYSTEM_PROMPT = 'Ты выполняешь только одну задачу — перевод текста. Отвечай СТРОГО только самим переводом: без пояснений, без анализа языка/диалекта, без вариантов, без вводных фраз вроде "Похоже, это..." или "Примерный смысл:", без кавычек вокруг перевода. Даже если текст короткий, неоднозначный или содержит опечатки — всё равно дай один наиболее вероятный перевод, никогда не описывай, что текст непонятен. Переводи ВЕСЬ текст целиком, включая приветствия и вводные слова — не оставляй отдельные слова непереведёнными на исходном языке, даже если они кажутся общепонятными.';

// Промпт — тот же, что в proxy/src/lib/openai.js (TZ п.4.2), держать в
// синхроне вручную по той же причине, что и pricing.js (см. комментарий там).
//
// direction: 'to_dialect' (по умолчанию, TZ п.4.2 как задумано — оператор
// пишет черновик, перевод идёт В диалект собеседника для отправки) или
// 'to_operator_language' (обратное — прочитать входящее сообщение
// собеседника на русском). Направление определяет content.js по алфавиту
// выделенного текста (см. detectDirection в extension/content.js).
function buildTranslatePrompt({ text, dialectContext, targetLang, direction }) {
  const contextBlock = (dialectContext || [])
    .map((line, i) => `${i + 1}. "${line}"`)
    .join('\n');

  if (direction === 'to_operator_language') {
    return `Вот сообщение от собеседника и контекст последних его сообщений (для лучшего понимания диалекта/сленга):
${contextBlock || '(контекст пуст)'}

Переведи следующее сообщение собеседника на литературный русский язык, сохраняя смысл и тон:
"${text}"

Ответь только переводом, без пояснений.`;
  }

  if (!contextBlock && !targetLang) {
    // Без контекста и без ручного override переводить "в тот же диалект"
    // буквально не во что — эта формулировка промпта раньше сбивала
    // модель с толку (она либо не переводила вовсе, либо переводила
    // частично). Честно просим наиболее вероятный естественный вариант.
    return `Контекст диалекта собеседника недоступен (это либо самое начало переписки, либо ошибка получения истории). Переведи следующий текст оператора на наиболее вероятный естественный разговорный вариант языка, сохраняя тон и уровень формальности — переведи целиком, ни одно слово не должно остаться на исходном языке:
"${text}"

Ответь только переводом, без пояснений.`;
  }

  return `Вот последние сообщения собеседника (используй тот же диалект, стиль И систему письма — если он пишет латиницей/арабизи, а не арабской графикой, отвечай тем же способом):
${contextBlock || '(контекст пуст, ориентируйся только на целевой язык ниже)'}

Переведи следующий текст оператора на тот же диалект${targetLang ? ` (целевой язык: ${targetLang})` : ''} целиком — ни одно слово, включая приветствия, не должно остаться непереведённым, сохраняя тон и уровень формальности:
"${text}"

Ответь только переводом, без пояснений.`;
}

export async function translate(cfg, { text, dialectContext, targetLang, direction }) {
  const estimatedCostUsd = estimateTranslateCostUsd({ text, dialectContext });

  if (cfg.mockMode) {
    return { translation: `[MOCK перевод] ${text}`, costUsd: estimatedCostUsd };
  }

  const prompt = buildTranslatePrompt({ text, dialectContext, targetLang, direction });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const translation = (data.choices?.[0]?.message?.content ?? '').trim();
  const actualCostUsd = computeChatCostUsdFromUsage(data.usage) || estimatedCostUsd;

  return { translation, costUsd: actualCostUsd };
}

// durationSeconds — РЕАЛЬНАЯ длительность голосового из files[].meta.duration
// в Chatterfy API (расширение передаёт её в /transcribe отдельным полем).
// Это и есть нормальная реализация лимита: OpenAI не отдаёт duration в
// ответе (verbose_json не поддерживается этой моделью, см. ниже), но нам
// и не нужно его угадывать по размеру файла — Chatterfy уже знает точную
// длительность и показывает её в плеере, этого достаточно. Угадывание по
// размеру — только фолбэк на случай, если durationSeconds не передали.
export async function transcribe(cfg, { fileBuffer, fileName, mimeType, durationSeconds }) {
  const estimatedCostUsd = typeof durationSeconds === 'number'
    ? estimateTranscribeCostUsdFromDuration(durationSeconds)
    : estimateTranscribeCostUsdFromFileSize(fileBuffer.length);

  if (cfg.mockMode) {
    return {
      transcript: '[MOCK расшифровка] это фиктивный текст голосового сообщения для проверки скелета прокси',
      language: 'ar',
      costUsd: estimatedCostUsd,
    };
  }

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  form.append('model', 'gpt-transcribe'); // имя из TZ (уже согласовано, см. этап 1 чек-листа)
  // Живьём выяснилось: gpt-transcribe (реально резолвится в
  // gpt-transcribe-api-ev3) НЕ поддерживает response_format: 'verbose_json'
  // — 400 "not compatible with model...Use 'json' or 'text' instead."
  // Поэтому реальную стоимость считаем по durationSeconds (см. выше), а не
  // ждём duration в ответе модели — его там не будет.
  form.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.openaiApiKey}` },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();

  return { transcript: data.text ?? '', language: data.language, costUsd: estimatedCostUsd };
}

