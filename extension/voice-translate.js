// Feature 2 (TZ п.5): расшифровка + перевод голосовых. Список голосовых —
// из messages/v1/search (files[].type === 'voice'), не из DOM (TZ,
// "Архитектура"). DOM используется только чтобы найти существующий
// <audio>-элемент с тем же src и повесить рядом кнопку/панель —
// сопоставление по точному URL файла, а не по угаданным CSS-классам,
// поэтому не хрупкое к вёрстке конкретной версии Chatterfy.
(function () {
  const RESCAN_INTERVAL_MS = 2000;
  const DIALECT_CONTEXT_MESSAGES = 10;

  const settings = { feature2Enabled: true };

  function applyStoredSettings(stored) {
    if (stored.feature2Enabled !== undefined) settings.feature2Enabled = stored.feature2Enabled !== false;
  }

  chrome.storage.local.get(['feature2Enabled'], applyStoredSettings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.feature2Enabled) applyStoredSettings({ feature2Enabled: changes.feature2Enabled.newValue });
  });

  function cacheKey(chatId, messageId) {
    return `cft-voice:${chatId}:${messageId}`;
  }

  async function getCached(chatId, messageId) {
    const key = cacheKey(chatId, messageId);
    const stored = await chrome.storage.local.get([key]);
    return stored[key] || null;
  }

  async function setCached(chatId, messageId, value) {
    await chrome.storage.local.set({ [cacheKey(chatId, messageId)]: value });
  }

  // durationSeconds — реальная длительность из files[].meta.duration
  // (Chatterfy API), передаём в прокси, чтобы бюджет считался по факту, а
  // не по угаданной из размера файла длительности (см. proxy/*/lib/pricing.js).
  function transcribeRequest(url, durationSeconds) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'transcribe', payload: { url, durationSeconds } },
        (response) => resolve(response || { ok: false, kind: 'network_error' })
      );
    });
  }

  function translateRequest(text, dialectContext) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        // Голосовые всегда переводятся ЧИТАТЬ (собеседник → русский), в
        // отличие от Feature 1 — там направление определяется по тексту,
        // здесь оно всегда одно и то же (TZ п.5.1: "расшифровка → перевод
        // на русский"), не нужно auto-detect.
        { type: 'translate', payload: { text, dialectContext, direction: 'to_operator_language' } },
        (response) => resolve(response || { ok: false, kind: 'network_error' })
      );
    });
  }

  // --- UI ---

  function clearPanel(panel) {
    panel.innerHTML = '';
    panel.classList.remove('cft-voice-panel--open', 'cft-voice-panel--warn', 'cft-voice-panel--error');
  }

  function renderIdle(panel, onClick) {
    clearPanel(panel);
    const btn = document.createElement('button');
    btn.className = 'cft-voice-btn';
    btn.type = 'button';
    btn.textContent = 'Перевести';
    btn.addEventListener('click', onClick);
    panel.appendChild(btn);
  }

  function renderLoading(panel, label) {
    clearPanel(panel);
    panel.classList.add('cft-voice-panel--open');
    const row = document.createElement('div');
    row.className = 'cft-voice-row';
    const spinner = document.createElement('div');
    spinner.className = 'cft-voice-spinner';
    const text = document.createElement('div');
    text.textContent = label;
    row.appendChild(spinner);
    row.appendChild(text);
    panel.appendChild(row);
  }

  function renderResult(panel, transcript, translation, onClose) {
    clearPanel(panel);
    panel.classList.add('cft-voice-panel--open');

    const original = document.createElement('div');
    original.className = 'cft-voice-block';
    original.innerHTML = '<div class="cft-voice-label">Оригинал (на диалекте):</div>';
    const originalText = document.createElement('div');
    originalText.className = 'cft-voice-text';
    originalText.textContent = transcript;
    original.appendChild(originalText);

    const translated = document.createElement('div');
    translated.className = 'cft-voice-block';
    translated.innerHTML = '<div class="cft-voice-label">Перевод:</div>';
    const translatedText = document.createElement('div');
    translatedText.className = 'cft-voice-text';
    translatedText.textContent = translation;
    translated.appendChild(translatedText);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cft-voice-btn cft-voice-btn--ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Скрыть';
    closeBtn.addEventListener('click', onClose);

    panel.appendChild(original);
    panel.appendChild(translated);
    panel.appendChild(closeBtn);
  }

  function renderUnintelligible(panel, onClose) {
    clearPanel(panel);
    panel.classList.add('cft-voice-panel--open', 'cft-voice-panel--warn');
    const text = document.createElement('div');
    text.className = 'cft-voice-text';
    text.textContent = 'Распознавание не дало разборчивого текста.';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cft-voice-btn cft-voice-btn--ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Закрыть';
    closeBtn.addEventListener('click', onClose);
    panel.appendChild(text);
    panel.appendChild(closeBtn);
  }

  function renderBudgetExceeded(panel, message, onClose) {
    clearPanel(panel);
    panel.classList.add('cft-voice-panel--open', 'cft-voice-panel--warn');
    const text = document.createElement('div');
    text.className = 'cft-voice-text';
    text.textContent = message || 'Дневной лимит бюджета исчерпан.';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cft-voice-btn cft-voice-btn--ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Закрыть';
    closeBtn.addEventListener('click', onClose);
    panel.appendChild(text);
    panel.appendChild(closeBtn);
  }

  function renderError(panel, message, onRetry, onClose) {
    clearPanel(panel);
    panel.classList.add('cft-voice-panel--open', 'cft-voice-panel--error');
    const text = document.createElement('div');
    text.className = 'cft-voice-text';
    text.textContent = message;
    const row = document.createElement('div');
    row.className = 'cft-voice-row';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'cft-voice-btn';
    retryBtn.type = 'button';
    retryBtn.textContent = 'Повторить';
    retryBtn.addEventListener('click', onRetry);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cft-voice-btn cft-voice-btn--ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Закрыть';
    closeBtn.addEventListener('click', onClose);
    row.appendChild(retryBtn);
    row.appendChild(closeBtn);
    panel.appendChild(text);
    panel.appendChild(row);
  }

  // --- Логика ---

  async function dialectContextFor(chatId) {
    if (!chatId) return [];
    try {
      const messages = await window.CftChatterfyApi.fetchChatMessages(chatId);
      return window.CftChatterfyApi.buildDialectContext(messages, DIALECT_CONTEXT_MESSAGES);
    } catch (err) {
      console.warn('[Chatterfy Translator] не удалось получить контекст диалекта:', err);
      return [];
    }
  }

  function resetToIdle(panel, voice) {
    renderIdle(panel, () => runVoiceTranslation(voice, panel));
  }

  function handleFailure(response, panel, voice) {
    if (response.kind === 'budget_exceeded') {
      renderBudgetExceeded(panel, response.message, () => resetToIdle(panel, voice));
    } else {
      renderError(
        panel,
        'Не удалось выполнить запрос, попробуйте ещё раз',
        () => runVoiceTranslation(voice, panel),
        () => resetToIdle(panel, voice)
      );
    }
  }

  // Реентерабельная: повторный вызов (например, по кнопке "Повторить")
  // подхватывает состояние из кэша, а не начинает с нуля — если
  // транскрипт уже получен, а перевод упал, повторный запуск платит
  // только за перевод, не за расшифровку заново.
  async function runVoiceTranslation(voice, panel) {
    let cached = await getCached(voice.chatId, voice.messageId);

    if (!cached) {
      renderLoading(panel, 'Распознаю...');
      const transcribeResponse = await transcribeRequest(voice.url, voice.durationSeconds);
      if (!transcribeResponse.ok) {
        handleFailure(transcribeResponse, panel, voice);
        return;
      }
      cached = {
        transcript: transcribeResponse.transcript || '',
        translation: null,
        language: transcribeResponse.language || null,
        cachedAt: Date.now(),
      };
      await setCached(voice.chatId, voice.messageId, cached);
    }

    if (!cached.transcript || !cached.transcript.trim()) {
      renderUnintelligible(panel, () => resetToIdle(panel, voice));
      return;
    }

    if (cached.translation) {
      renderResult(panel, cached.transcript, cached.translation, () => resetToIdle(panel, voice));
      return;
    }

    renderLoading(panel, 'Перевожу...');
    const dialectContext = await dialectContextFor(voice.chatId);
    const translateResponse = await translateRequest(cached.transcript, dialectContext);
    if (!translateResponse.ok) {
      handleFailure(translateResponse, panel, voice);
      return;
    }

    cached.translation = translateResponse.translation;
    await setCached(voice.chatId, voice.messageId, cached);
    renderResult(panel, cached.transcript, cached.translation, () => resetToIdle(panel, voice));
  }

  // --- Поиск голосовых сообщений в DOM ---
  //
  // Живьём выяснилось: у Chatterfy нет нативного <audio> — кастомный
  // React-плеер (waveform + кнопка play), прямой ссылки на файл или id
  // сообщения в DOM-разметке виджета нет вообще. Сопоставляем по паре
  // сигналов, которые ЕСТЬ и в DOM, и в ответе API:
  //   - текст вида "00:00/00:27" — общая длительность (после "/"),
  //     совпадает с files[].meta.duration;
  //   - span[data-message-timestamp="true"] с временем "ЧЧ:ММ" рядом —
  //     совпадает с created_at, отформатированным в ЧАСОВОМ ПОЯСЕ БРАУЗЕРА
  //     (тот же браузер рендерит и то, и то — таймзону угадывать не нужно,
  //     Date() в content script и в коде страницы даёт один результат).
  // Не идеально (два входящих голосовых в одну минуту одной длины дадут
  // коллизию), но рабочий вариант без завязки на CSS-классы конкретной
  // сборки. Сообщения без meta.duration пропускаются — сопоставлять
  // только по времени слишком ненадёжно.

  const DURATION_TEXT_PATTERN = /^\d{1,2}:\d{2}\/(\d{1,2}:\d{2})$/;

  function formatDurationMMSS(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatTimeHHMM(iso) {
    // getHours()/getMinutes() — локальное время браузера, не UTC. Если
    // совпадений с виджетами не будет вообще (ни одного) — вероятно,
    // Chatterfy рендерит время как-то иначе (например, через getUTCHours),
    // тогда заменить на getUTCHours()/getUTCMinutes() здесь.
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Виджет голосового — самый маленький div, чей текст целиком выглядит
  // как "00:00/00:27" (текущая позиция / общая длительность плеера).
  function findVoiceWidgets() {
    const widgets = [];
    document.querySelectorAll('div').forEach((el) => {
      if (el.children.length === 0 && DURATION_TEXT_PATTERN.test(el.textContent.trim())) {
        widgets.push(el);
      }
    });
    return widgets;
  }

  // От виджета длительности поднимаемся вверх до ближайшего предка,
  // внутри которого есть таймстамп сообщения — это и есть контейнер всей
  // "карточки" голосового, к которому цепляем кнопку/панель.
  function findBubbleContainer(durationEl) {
    let node = durationEl;
    // 20 — с запасом: на реальной вёрстке общий предок оказался на 9-м
    // шаге вверх, глубина вложенности Tailwind-разметки может отличаться
    // на других сборках/типах сообщений.
    for (let i = 0; i < 20 && node; i += 1) {
      if (node.querySelector && node.querySelector('[data-message-timestamp]')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function attachPanel(bubbleEl, voice) {
    const panel = document.createElement('div');
    panel.className = 'cft-voice-panel';
    bubbleEl.appendChild(panel);
    bubbleEl.dataset.cftVoiceUrl = voice.url;
    resetToIdle(panel, voice);
  }

  // Живьём выяснилось: список сообщений у Chatterfy виртуализирован — при
  // скролле и особенно при переключении чата React переиспользует одни и
  // те же DOM-узлы под другие сообщения. Первая версия помечала узел
  // "обработан" постоянным атрибутом и больше никогда не перепроверяла —
  // из-за этого кнопка то пропадала на некоторых сообщениях (узел
  // переиспользован под них, но помечен как чужой), то не появлялась
  // вообще при смене чата без перезагрузки страницы (все узлы нового чата
  // — вторично использованные из старого, все с "чужой" меткой).
  // Лечится тем, что каждый скан сверяет: то ли сейчас голосовое навешано
  // на узел, что и должно быть, — если нет (узел пуст или там чужой url),
  // перевешивает; если узел для голосового больше не годится (переиспользован
  // под что-то другое) — снимает панель.
  async function scanForVoices() {
    if (!settings.feature2Enabled) return;

    const chatId = window.CftChatterfyApi.getChatId();
    if (!chatId) return;

    // Одна страница (see docs/TZ.md §0.1.1 — API отдаёт фиксированные 50
    // сообщений, курсорная пагинация за пределы первой страницы сознательно
    // не реализована). Для контекста диалекта Feature 1 этого с запасом
    // хватало (нужно 5-10 последних); для голосовых Feature 2 это значит,
    // что кнопка появится только у голосовых из последних ~50 сообщений
    // чата — более старые не подхватятся без прокрутки истории и повторного
    // скана. Приемлемо для MVP, но если понадобится вся история — сюда же
    // добавлять курсорный проход.
    let messages;
    try {
      messages = await window.CftChatterfyApi.fetchChatMessages(chatId);
    } catch (err) {
      console.warn('[Chatterfy Translator] не удалось получить список сообщений для голосовых:', err);
      return;
    }

    // TZ п.5.1 говорит "у каждого голосового сообщения" без уточнения
    // направления, но живая проверка этапа 1 показала: исходящие голосовые
    // в реальных чатах часто оказываются заготовленными шаблонами оператора
    // (уже на русском) — "перевести на русский" для них бессмысленно, тот
    // же класс проблемы, что был с Feature 1 до фикса направления. Пока
    // ограничиваемся входящими; при необходимости расширить — тривиально.
    // Ключ "время|длительность" — коллизия возможна (два входящих голосовых
    // одной длины в одну минуту), известное и принятое ограничение.
    const candidatesByKey = new Map();
    for (const m of messages) {
      if (m.sender_type !== 'incoming') continue;
      for (const f of m.files || []) {
        if (f.type !== 'voice' || !f.url) continue;
        const duration = f.meta && typeof f.meta.duration === 'number' ? f.meta.duration : null;
        const timeText = formatTimeHHMM(m.created_at);
        // Без длительности сопоставление по одному времени слишком
        // ненадёжно (коллизии) — такие голосовые пропускаем.
        if (duration === null || !timeText) continue;
        candidatesByKey.set(`${timeText}|${formatDurationMMSS(duration)}`, {
          chatId,
          messageId: m.id,
          url: f.url,
          durationSeconds: duration,
        });
      }
    }

    const matchedBubbles = new Set();

    for (const widget of findVoiceWidgets()) {
      const match = DURATION_TEXT_PATTERN.exec(widget.textContent.trim());
      if (!match) continue;

      const bubble = findBubbleContainer(widget);
      if (!bubble) continue;
      const timestampEl = bubble.querySelector('[data-message-timestamp]');
      const widgetTimeText = timestampEl ? timestampEl.textContent.trim() : null;
      if (!widgetTimeText) continue;

      const candidate = candidatesByKey.get(`${widgetTimeText}|${match[1]}`);
      if (!candidate) continue; // не входящее голосовое либо нет данных — не наш случай

      matchedBubbles.add(bubble);

      if (bubble.dataset.cftVoiceUrl === candidate.url) continue; // уже верно навешано, не трогаем (не сбрасываем открытую панель)

      // Узел либо новый, либо переиспользован под другое сообщение —
      // убираем чужую панель, если была, и вешаем актуальную.
      const stalePanel = bubble.querySelector(':scope > .cft-voice-panel');
      if (stalePanel) stalePanel.remove();
      attachPanel(bubble, candidate);
    }

    // Узлы, которые раньше были голосовыми с нашей панелью, но в этом
    // скане больше не сматчились ни с одним голосовым (переиспользованы
    // под текстовое сообщение и т.п.) — снимаем осиротевшую панель.
    document.querySelectorAll('.cft-voice-panel').forEach((panel) => {
      const bubble = panel.parentElement;
      if (bubble && !matchedBubbles.has(bubble)) {
        panel.remove();
        delete bubble.dataset.cftVoiceUrl;
      }
    });
  }

  setInterval(scanForVoices, RESCAN_INTERVAL_MS);
  scanForVoices();
})();
