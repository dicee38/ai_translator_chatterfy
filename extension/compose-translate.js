// Feature 1, альтернативный триггер (по просьбе оператора, в духе DeepL):
// вместо выделения текста и плашки — кнопка прямо в поле ввода, по клику
// переводит то, что оператор уже написал, и заменяет текст на месте.
// Направление всегда 'to_dialect' — это заведомо черновик оператора, а не
// произвольное выделение, определять направление по алфавиту тут не нужно.
// Та же авторизация/бюджет/прокси, что и у обычного Feature 1 — просто
// другой способ вызвать тот же /translate.
(function () {
  const RESCAN_INTERVAL_MS = 1500;
  const DIALECT_CONTEXT_MESSAGES = 10;

  const settings = { manualDialectOverride: '' };

  function applyStoredSettings(stored) {
    if (stored.manualDialectOverride !== undefined) settings.manualDialectOverride = stored.manualDialectOverride || '';
  }

  chrome.storage.local.get(['manualDialectOverride'], applyStoredSettings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.manualDialectOverride) applyStoredSettings({ manualDialectOverride: changes.manualDialectOverride.newValue });
  });

  function getEditorText(editor) {
    return (editor.innerText || editor.textContent || '').trim();
  }

  function sendTranslateRequest(text, dialectContext, targetLang) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'translate', payload: { text, dialectContext, targetLang, direction: 'to_dialect' } },
        (response) => resolve(response || { ok: false, kind: 'network_error' })
      );
    });
  }

  async function handleTranslateClick(editor, btn) {
    const text = getEditorText(editor);
    if (!text || btn.disabled) return;

    btn.disabled = true;
    btn.classList.add('cft-compose-btn--busy');

    const chatId = window.CftChatterfyApi.getChatId();
    let dialectContext = [];
    if (chatId) {
      try {
        const messages = await window.CftChatterfyApi.fetchChatMessages(chatId);
        dialectContext = window.CftChatterfyApi.buildDialectContext(messages, DIALECT_CONTEXT_MESSAGES);
      } catch (err) {
        console.warn('[Chatterfy Translator] не удалось получить контекст диалекта:', err);
      }
    }

    const response = await sendTranslateRequest(text, dialectContext, settings.manualDialectOverride || undefined);

    btn.disabled = false;
    btn.classList.remove('cft-compose-btn--busy');

    if (response.ok) {
      window.CftChatterfyApi.insertIntoCompose(response.translation, { replaceAll: true });
      return;
    }

    // Кратко подсвечиваем кнопку и кладём причину в title — не городим
    // модалки и плашки поверх поля ввода, оно и так занято текстом.
    const isLimited = response.kind === 'budget_exceeded' || response.kind === 'rate_limited';
    btn.title = response.message || (isLimited ? 'Дневной лимит бюджета исчерпан' : 'Не удалось перевести, попробуйте ещё раз');
    btn.classList.add(isLimited ? 'cft-compose-btn--warn' : 'cft-compose-btn--error');
    setTimeout(() => {
      btn.classList.remove('cft-compose-btn--warn', 'cft-compose-btn--error');
      btn.title = 'Перевести в диалект собеседника';
    }, 2500);
  }

  function ensureButton(editor) {
    const wrapper = editor.parentElement;
    if (!wrapper) return;

    if (wrapper.querySelector(':scope > .cft-compose-btn')) return; // уже есть

    if (getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cft-compose-btn';
    btn.textContent = '🌐';
    btn.title = 'Перевести в диалект собеседника';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleTranslateClick(editor, btn);
    });
    wrapper.appendChild(btn);
  }

  function scan() {
    const editor = window.CftChatterfyApi.getComposeEditor();
    if (!editor) return;
    ensureButton(editor);
  }

  setInterval(scan, RESCAN_INTERVAL_MS);
  scan();
})();
