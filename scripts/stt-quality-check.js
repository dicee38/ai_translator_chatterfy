#!/usr/bin/env node
// Этап 1 чек-листа (docs/TZ.md §5.3, CLAUDE.md): ручная проверка качества
// gpt-transcribe на 10-15 реальных голосовых нужного диалекта — до старта
// Feature 2. Этот скрипт делает техническую часть (найти голосовые в чате,
// скачать, прогнать через /transcribe нашего прокси); саму оценку "разборчиво
// или нет" делает человек, понимающий диалект — скрипт её не подменяет.
//
// Использование:
//   CHATTERFY_AUTH_TOKEN=<jwt из localStorage/sessionStorage страницы> \
//   PROXY_BASE_URL=https://chatterfy-translator-proxy.demonivan09.workers.dev \
//   EXTENSION_TOKEN=<токен из proxy/.env или wrangler secret> \
//   node scripts/stt-quality-check.js --chats <chatId1>,<chatId2> [--limit 15] [--dry-run] [--all-senders]
//
// --dry-run — только найти и вывести список голосовых (URL, длительность),
// ничего не транскрибировать и не тратить бюджет. Полезно сначала прикинуть,
// сколько сэмплов реально наберётся, прежде чем жать "по-настоящему".
//
// По умолчанию берутся только ВХОДЯЩИЕ голосовые (от собеседника, на
// диалекте) — именно их качество распознавания и нужно оценить на этапе 1.
// В реальных чатах попадаются ещё исходящие шаблонные голосовые оператора
// (заготовленная озвучка на русском) — они не про то, что мы проверяем,
// --all-senders включает их обратно, если понадобится зачем-то ещё.
//
// Токен CHATTERFY_AUTH_TOKEN достать так: F12 на странице v2.chatterfy.ai →
// Console → см. docs/chatterfy-api-reference.md §1 (поиск JWT-подобной
// строки в localStorage/sessionStorage).

const MESSAGES_SEARCH_URL = 'https://migration-api.chatterfy.ai/api/messages/v1/search';

function parseArgs(argv) {
  const args = { chats: [], limit: 15, dryRun: false, allSenders: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chats') args.chats = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]) || args.limit;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    // По умолчанию — только входящие (от собеседника, на диалекте). Этап 1
    // проверяет качество распознавания именно диалекта, а не заготовленных
    // шаблонных голосовых оператора (они попадаются в реальных чатах и
    // обычно на русском) — --all-senders включает их обратно, если нужно.
    else if (argv[i] === '--all-senders') args.allSenders = true;
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Отсутствует переменная окружения ${name}. См. комментарий в начале файла.`);
    process.exit(1);
  }
  return value;
}

async function fetchChatMessages(chatId, authToken) {
  const res = await fetch(MESSAGES_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: authToken },
    body: JSON.stringify({ chat_id: chatId, limit: 50 }),
  });
  if (!res.ok) {
    throw new Error(`messages/v1/search (${chatId}) вернул ${res.status}`);
  }
  const data = await res.json();
  return data?.data?.items || [];
}

function extractVoiceMessages(messages, chatId) {
  const voices = [];
  for (const m of messages) {
    for (const f of m.files || []) {
      if (f.type === 'voice' && f.url) {
        voices.push({
          chatId,
          messageId: m.id,
          senderType: m.sender_type,
          createdAt: m.created_at,
          url: f.url,
          durationSec: f.meta?.duration ?? null,
        });
      }
    }
  }
  return voices;
}

// Живьём выяснилось: OpenAI определяет формат аудио по РАСШИРЕНИЮ ИМЕНИ
// ФАЙЛА в multipart, не по Content-Type — имя без расширения ('voice') даёт
// 400 "Unsupported file format" даже для корректного .ogg/.mp3. Голосовые
// Chatterfy — не всегда .ogg (docs/chatterfy-api-reference.md §8: бывает
// .mp3), поэтому расширение берём из самого URL, а не хардкодим.
function guessFileName(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const base = pathname.split('/').pop();
    if (base && /\.\w+$/.test(base)) return base;
  } catch (_) {
    // падать тут не из-за чего критичного — просто используем фолбэк ниже
  }
  return 'voice.ogg';
}

async function transcribeViaProxy(voiceUrl, proxyBaseUrl, extensionToken, durationSeconds) {
  const audioRes = await fetch(voiceUrl);
  if (!audioRes.ok) throw new Error(`не удалось скачать файл: ${audioRes.status}`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const contentType = audioRes.headers.get('content-type') || 'application/octet-stream';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), guessFileName(voiceUrl));
  // Реальная длительность из Chatterfy API — прокси считает по ней бюджет
  // точно, не угадывает по размеру файла.
  if (typeof durationSeconds === 'number') {
    form.append('durationSeconds', String(durationSeconds));
  }

  const res = await fetch(`${proxyBaseUrl}/transcribe`, {
    method: 'POST',
    headers: { 'X-Extension-Token': extensionToken },
    body: form,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`прокси /transcribe вернул ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.chats.length === 0) {
    console.error('Укажите хотя бы один --chats <chatId1>,<chatId2>');
    process.exit(1);
  }

  const authToken = requireEnv('CHATTERFY_AUTH_TOKEN');
  const proxyBaseUrl = process.env.PROXY_BASE_URL || 'https://chatterfy-translator-proxy.demonivan09.workers.dev';
  const extensionToken = requireEnv('EXTENSION_TOKEN');

  console.log(`Ищу голосовые в ${args.chats.length} чате(ах), лимит ${args.limit}...`);

  let allVoices = [];
  for (const chatId of args.chats) {
    try {
      const messages = await fetchChatMessages(chatId, authToken);
      let voices = extractVoiceMessages(messages, chatId);
      if (!args.allSenders) voices = voices.filter((v) => v.senderType === 'incoming');
      console.log(`  ${chatId}: найдено ${voices.length} голосовых${args.allSenders ? '' : ' (только входящие)'}`);
      allVoices = allVoices.concat(voices);
    } catch (err) {
      console.error(`  ${chatId}: ошибка — ${err.message}`);
    }
  }

  // Свежие сначала (created_at по убыванию) — обычно интереснее для оценки
  // актуального качества, чем случайная выборка по всей истории.
  allVoices.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  allVoices = allVoices.slice(0, args.limit);

  console.log(`\nВсего к обработке: ${allVoices.length}\n`);

  if (args.dryRun) {
    allVoices.forEach((v, i) => {
      console.log(`${i + 1}. [${v.senderType}] ${v.createdAt} (${v.durationSec ?? '?'}с)\n   ${v.url}`);
    });
    console.log('\n--dry-run: ничего не транскрибировано, бюджет не потрачен.');
    return;
  }

  for (let i = 0; i < allVoices.length; i++) {
    const v = allVoices[i];
    console.log(`--- ${i + 1}/${allVoices.length} [${v.senderType}] ${v.createdAt} (${v.durationSec ?? '?'}с) ---`);
    console.log(`URL (открыть и прослушать): ${v.url}`);
    try {
      const result = await transcribeViaProxy(v.url, proxyBaseUrl, extensionToken, v.durationSec);
      console.log(`Язык (по мнению модели): ${result.language || '?'}`);
      console.log(`Транскрипт: ${result.transcript}`);
    } catch (err) {
      console.error(`Ошибка транскрипции: ${err.message}`);
    }
    console.log();
  }

  try {
    const health = await fetch(`${proxyBaseUrl}/health`).then((r) => r.json());
    console.log(`Бюджет за сегодня: потрачено $${health.budget.spentUsd} из $${health.budget.limitUsd}`);
  } catch (_) {
    // не критично, просто не покажем итог по бюджету
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
