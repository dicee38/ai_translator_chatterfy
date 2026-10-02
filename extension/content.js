// Feature 1 (TZ п.4): перевод по выделению. Данные диалекта — из
// messages/v1/search (TZ п.0.1), не из DOM. DOM используется только для
// зоны слушателя выделения и позиционирования плашки (TZ, "Архитектура").
// Общая логика работы с Chatterfy API — в chatterfy-api.js (window.CftChatterfyApi).
(function () {
  const DIALECT_CONTEXT_MESSAGES = 10;

  // TZ п.4.2: кэш в памяти вкладки, ключ hash(text + chatId). Для Map
  // обычная строка-ключ так же надёжна, как явный хэш — отдельная функция
  // хеширования тут не нужна.
  const translationCache = new Map();

  // Feature 1 всегда включена (товарная версия — без переключателя в
  // попапе). Ручной override диалекта остаётся настраиваемым — это
  // полезно любому оператору, не внутренний dev-рычаг.
  const settings = { manualDialectOverride: '' };

  function applyStoredSettings(stored) {
    if (stored.manualDialectOverride !== undefined) settings.manualDialectOverride = stored.manualDialectOverride || '';
  }

  chrome.storage.local.get(['manualDialectOverride'], applyStoredSettings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.manualDialectOverride) applyStoredSettings({ manualDialectOverride: changes.manualDialectOverride.newValue });
  });

  // Живьём выяснилось (проверка на реальном Chatterfy) — направление
  // перевода нельзя определять по sender_type выделенного сообщения:
  // "исходящее → в диалект" ломается, как только оператор отправляет
  // ГОТОВЫЙ перевод на диалекте (обычный рабочий цикл — перевёл, вставил,
  // отправил) — такое сообщение лежит в истории как "outcoming", но
  // ФАКТИЧЕСКИ уже на диалекте, и повторный "перевод в диалект" — то же
  // самое "с дариджи на дариджу", что и было с входящими до этой правки.
  // Надёжнее смотреть не на то, КТО писал, а на то, НА КАКОМ АЛФАВИТЕ
  // написан сам выделенный текст: TZ подразумевает, что оператор пишет
  // по-русски (кириллица), а диалект собеседника — латиница/арабица/иное.
  function detectDirection(selectedText) {
    const cyrillic = (selectedText.match(/[Ѐ-ӿ]/g) || []).length;
    const letters = (selectedText.match(/\p{L}/gu) || []).length;
    if (letters === 0) return 'to_dialect';
    // Заметная доля кириллицы — считаем текст русским (оператора) → в диалект.
    // Иначе — латиница/арабица и т.п., уже похоже на диалект → на русский.
    return cyrillic / letters > 0.3 ? 'to_dialect' : 'to_operator_language';
  }

  function sendTranslateRequest(text, dialectContext, targetLang, direction) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'translate', payload: { text, dialectContext, targetLang, direction } },
        (response) => resolve(response || { ok: false, kind: 'network_error' })
      );
    });
  }

  async function runTranslation(text, chatId, cacheKey) {
    window.CftTranslateBubble.showLoading();

    const direction = detectDirection(text);

    let dialectContext = [];
    if (chatId) {
      try {
        const messages = await window.CftChatterfyApi.fetchChatMessages(chatId);
        dialectContext = window.CftChatterfyApi.buildDialectContext(messages, DIALECT_CONTEXT_MESSAGES);
      } catch (err) {
        // Контекст диалекта — это улучшение качества перевода, а не
        // обязательное условие; при сбое просто переводим без него.
        console.warn('[Chatterfy Translator] не удалось получить контекст диалекта:', err);
      }
    }

    // Ручной override диалекта из попапа (TZ п.5 — "на случай, если
    // авто-контекст ошибся") применим только к направлению "в диалект" —
    // для чтения входящих целевой язык всегда русский, override тут не при чём.
    const targetLang = direction === 'to_dialect' ? settings.manualDialectOverride || undefined : undefined;
    const response = await sendTranslateRequest(text, dialectContext, targetLang, direction);

    if (response.ok) {
      translationCache.set(cacheKey, response.translation);
      window.CftTranslateBubble.showSuccess(response.translation);
    } else if (response.kind === 'budget_exceeded' || response.kind === 'rate_limited') {
      window.CftTranslateBubble.showBudgetExceeded(response.message);
    } else {
      window.CftTranslateBubble.showNetworkError(() => runTranslation(text, chatId, cacheKey));
    }
  }

  function handleSelection(rect, text) {
    const chatId = window.CftChatterfyApi.getChatId();
    const cacheKey = `${chatId || 'no-chat-id'}::${text}`;

    if (translationCache.has(cacheKey)) {
      // Кэш уже содержит перевод для этого текста в этом чате — не
      // заставляем оператора лишний раз жать "Перевести".
      window.CftTranslateBubble.showIdle(rect, () => {});
      window.CftTranslateBubble.showSuccess(translationCache.get(cacheKey));
      return;
    }

    window.CftTranslateBubble.showIdle(rect, () => runTranslation(text, chatId, cacheKey));
  }

  document.addEventListener('mouseup', (e) => {
    const container = window.CftChatterfyApi.getChatContainer();
    if (!container || !container.contains(e.target)) {
      return;
    }

    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text) {
      window.CftTranslateBubble.hide();
      return;
    }

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    handleSelection(rect, text);
  });
})();
