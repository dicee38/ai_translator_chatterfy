// Общие хелперы для обращения к Chatterfy API — переиспользуются Feature 1
// (content.js) и Feature 2 (voice-translate.js). Вынесено в отдельный файл
// после того, как getChatId/fetchChatMessages потребовали три раунда правок
// на живых данных (авторизация, форма ответа, порядок сортировки — см.
// docs/TZ.md §0.1.1) — держать эту логику в одном месте, не дублировать по
// фичам, чтобы фикс в одном не разошёлся с копией в другом.
(function () {
  const CONFIG = {
    // TODO: проверено только на одном формате ссылки
    // (/bots/<botId>/chats?chat=<chatId>) — если у Chatterfy есть другие
    // разделы с иным форматом URL, потребуется уточнить.
    chatContainerSelector: '[data-testid="chat-messages"], .chat-messages, .messages-list, main',
    chatIdFromUrlPattern: /\/chats?\/([a-zA-Z0-9-]+)/,
  };

  const MESSAGES_SEARCH_URL = 'https://migration-api.chatterfy.ai/api/messages/v1/search';

  // TZ п.6.2: подтверждено реальной вёрсткой композера — Quill,
  // contenteditable-редактор с классом .ql-editor.
  const COMPOSE_EDITOR_SELECTOR = '.ql-editor[contenteditable="true"]';

  // Подтверждено docs/chatterfy-api-reference.md §1: заголовок
  // `authorization: <JWT>` без префикса "Bearer", токен — в localStorage/
  // sessionStorage по виду (точное имя ключа не зафиксировано, оказалось
  // "token", но искать надёжнее по форме, чем по конкретному ключу).
  const JWT_PATTERN = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

  function getChatContainer() {
    return document.querySelector(CONFIG.chatContainerSelector);
  }

  function getChatId() {
    // Подтверждено на реальном Chatterfy: id чата — в query-параметре
    // ?chat=..., не в пути.
    const fromQuery = new URLSearchParams(location.search).get('chat');
    if (fromQuery) return fromQuery;
    const urlMatch = location.pathname.match(CONFIG.chatIdFromUrlPattern);
    if (urlMatch) return urlMatch[1];
    const el = document.querySelector('[data-chat-id]');
    if (el) return el.getAttribute('data-chat-id');
    return null;
  }

  function findJwtInStorage(storage) {
    for (let i = 0; i < storage.length; i++) {
      const value = storage.getItem(storage.key(i));
      if (typeof value !== 'string') continue;
      const match = value.match(JWT_PATTERN);
      if (match) return match[0];
    }
    return null;
  }

  function getAuthToken() {
    try {
      return findJwtInStorage(window.localStorage) || findJwtInStorage(window.sessionStorage) || null;
    } catch (err) {
      // Доступ к storage может быть запрещён политикой страницы — не
      // фатально, просто не найдём токен и получим явный 401 при запросе.
      return null;
    }
  }

  async function fetchChatMessages(chatId, limit) {
    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.authorization = token;

    const res = await fetch(MESSAGES_SEARCH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chat_id: chatId, limit: limit || 50 }),
    });

    if (!res.ok) {
      throw new Error(`messages/v1/search вернул ${res.status}${token ? '' : ' (токен авторизации не найден в localStorage/sessionStorage)'}`);
    }

    const data = await res.json();
    // Подтверждённая форма — {"data":{"items":[...]}} (docs/TZ.md §0.1.1).
    // Остальные варианты — фолбэк на случай другого эндпоинта/версии API.
    return data?.data?.items || data?.items || data?.messages || (Array.isArray(data) ? data : []);
  }

  function buildDialectContext(messages, limitMessages) {
    // Сообщения приходят от новых к старым (подтверждено HAR-логом) — берём
    // первые N (самые свежие) и разворачиваем в хронологический порядок.
    return messages
      .filter((m) => m && m.sender_type === 'incoming' && typeof m.content === 'string' && m.content.trim())
      .slice(0, limitMessages || 10)
      .reverse()
      .map((m) => m.content);
  }

  function getComposeEditor() {
    return document.querySelector(COMPOSE_EDITOR_SELECTOR);
  }

  // Общая вставка текста в поле ввода Quill — используется и кнопкой
  // «Вставить» в плашке перевода (content.js/translate-bubble.js,
  // добавляет в конец, не трогая уже набранное), и кнопкой в самом поле
  // ввода (compose-translate.js, replaceAll: true — заменяет черновик).
  // TZ п.6.2: execCommand('insertText', ...) — Quill перехватывает это как
  // обычный пользовательский ввод и сам обновляет внутреннюю модель
  // (Delta), досинхронизировать ничего не нужно.
  function insertIntoCompose(text, options) {
    const replaceAll = Boolean(options && options.replaceAll);
    const editor = getComposeEditor();
    if (!editor) return false;

    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (!replaceAll) range.collapse(false); // в конец текущего содержимого, не заменяя его

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      // Фолбэк из TZ п.6.2 на случай, если execCommand не подхватится на
      // этой конкретной сборке Quill.
      editor.textContent = replaceAll ? text : (editor.textContent || '') + text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return true;
  }

  window.CftChatterfyApi = {
    getChatContainer,
    getChatId,
    getAuthToken,
    fetchChatMessages,
    buildDialectContext,
    getComposeEditor,
    insertIntoCompose,
  };
})();
