// Feature 3 (TZ п.6, "перспектива" — сделана после того, как Feature 1 и 2
// подтвердили, что вся цепочка прокси/бюджет/качество перевода работает
// нормально на реальном диалекте). Кнопка "Предложить ответ" рядом с полем
// ввода: контекст диалога (обе стороны, не только собеседник — в отличие
// от Feature 1) → сгенерированный ответ на диалекте + обратный перевод на
// русский для проверки. Вставка в поле ввода — ТОЛЬКО по явному клику
// "Вставить" (CLAUDE.md, архитектура: "автоотправки нет и не будет — это
// не ограничение MVP, а постоянное решение"), кнопка "Отмена" не вставляет
// ничего.
(function () {
  const RESCAN_INTERVAL_MS = 1500;
  const CONVERSATION_CONTEXT_MESSAGES = 12;

  // Товарная версия: Feature 1/2 всегда включены, без переключателя. Feature
  // 3 — наоборот, по умолчанию ВЫКЛЮЧЕНА и не имеет переключателя в обычном
  // попапе (не часть того, что продаётся) — но код не удалён, включается
  // через скрытую ссылку popup.html?advanced=1 (см. popup.js), которую знает
  // только владелец. Дефолт сознательно false (раньше был true).
  const settings = { feature3Enabled: false, operatorPersona: '' };

  function applyStoredSettings(stored) {
    if (stored.feature3Enabled !== undefined) settings.feature3Enabled = stored.feature3Enabled === true;
    if (stored.operatorPersona !== undefined) settings.operatorPersona = stored.operatorPersona || '';
  }

  chrome.storage.local.get(['feature3Enabled', 'operatorPersona'], applyStoredSettings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    if (changes.feature3Enabled) patch.feature3Enabled = changes.feature3Enabled.newValue;
    if (changes.operatorPersona) patch.operatorPersona = changes.operatorPersona.newValue;
    applyStoredSettings(patch);
  });

  function suggestReplyRequest(conversationContext) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'suggestReply', payload: { conversationContext, operatorPersona: settings.operatorPersona || undefined } },
        (response) => resolve(response || { ok: false, kind: 'network_error' })
      );
    });
  }

  // --- Панель с результатом (над полем ввода) ---

  function removePanel(wrapper) {
    const existing = wrapper.querySelector(':scope > .cft-reply-panel');
    if (existing) existing.remove();
  }

  function createPanel(wrapper) {
    removePanel(wrapper);
    const panel = document.createElement('div');
    panel.className = 'cft-reply-panel';
    wrapper.appendChild(panel);
    return panel;
  }

  function renderLoading(panel) {
    panel.innerHTML = '';
    panel.classList.remove('cft-reply-panel--error');
    const row = document.createElement('div');
    row.className = 'cft-reply-row';
    const spinner = document.createElement('div');
    spinner.className = 'cft-reply-spinner';
    const text = document.createElement('div');
    text.textContent = 'Придумываю ответ...';
    row.appendChild(spinner);
    row.appendChild(text);
    panel.appendChild(row);
  }

  function renderResult(panel, replyInDialect, backTranslationRu, onInsert, onCancel) {
    panel.innerHTML = '';
    panel.classList.remove('cft-reply-panel--error');

    const replyBlock = document.createElement('div');
    replyBlock.className = 'cft-reply-block';
    const replyLabel = document.createElement('div');
    replyLabel.className = 'cft-reply-label';
    replyLabel.textContent = 'Ответ (на диалекте):';
    const replyText = document.createElement('div');
    replyText.className = 'cft-reply-text';
    replyText.textContent = replyInDialect;
    replyBlock.appendChild(replyLabel);
    replyBlock.appendChild(replyText);

    const backBlock = document.createElement('div');
    backBlock.className = 'cft-reply-block';
    const backLabel = document.createElement('div');
    backLabel.className = 'cft-reply-label';
    backLabel.textContent = 'Обратный перевод (для проверки):';
    const backText = document.createElement('div');
    backText.className = 'cft-reply-text';
    backText.textContent = backTranslationRu;
    backBlock.appendChild(backLabel);
    backBlock.appendChild(backText);

    const actions = document.createElement('div');
    actions.className = 'cft-reply-row';

    // TZ п.6.1: только по явному клику "Вставить" — никогда автоматически.
    const insertBtn = document.createElement('button');
    insertBtn.className = 'cft-reply-btn';
    insertBtn.type = 'button';
    insertBtn.textContent = 'Вставить';
    insertBtn.addEventListener('click', onInsert);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cft-reply-btn cft-reply-btn--ghost';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.addEventListener('click', onCancel);

    actions.appendChild(insertBtn);
    actions.appendChild(cancelBtn);

    panel.appendChild(replyBlock);
    panel.appendChild(backBlock);
    panel.appendChild(actions);
  }

  function renderError(panel, message, onClose) {
    panel.innerHTML = '';
    panel.classList.add('cft-reply-panel--error');
    const text = document.createElement('div');
    text.className = 'cft-reply-text';
    text.textContent = message;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cft-reply-btn cft-reply-btn--ghost';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Закрыть';
    closeBtn.addEventListener('click', onClose);
    panel.appendChild(text);
    panel.appendChild(closeBtn);
  }

  // --- Логика ---

  async function handleSuggestClick(wrapper) {
    const panel = createPanel(wrapper);
    renderLoading(panel);

    const chatId = window.CftChatterfyApi.getChatId();
    let conversationContext = [];
    if (chatId) {
      try {
        const messages = await window.CftChatterfyApi.fetchChatMessages(chatId);
        conversationContext = window.CftChatterfyApi.buildConversationContext(messages, CONVERSATION_CONTEXT_MESSAGES);
      } catch (err) {
        console.warn('[Chatterfy Translator] не удалось получить контекст диалога:', err);
      }
    }

    if (conversationContext.length === 0) {
      renderError(panel, 'Не удалось получить историю диалога — нечего анализировать.', () => panel.remove());
      return;
    }

    const response = await suggestReplyRequest(conversationContext);

    if (!response.ok) {
      const message = (response.kind === 'budget_exceeded' || response.kind === 'rate_limited')
        ? (response.message || 'Дневной лимит бюджета исчерпан.')
        : 'Не удалось получить предложение, попробуйте ещё раз.';
      renderError(panel, message, () => panel.remove());
      return;
    }

    renderResult(
      panel,
      response.replyInDialect,
      response.backTranslationRu,
      () => {
        window.CftChatterfyApi.insertIntoCompose(response.replyInDialect, { replaceAll: true });
        panel.remove();
      },
      () => panel.remove() // "Отмена" — ничего никуда не вставляется (TZ п.6.1)
    );
  }

  function ensureButton(editor) {
    const wrapper = editor.parentElement;
    if (!wrapper) return;

    if (wrapper.querySelector(':scope > .cft-reply-trigger')) return; // уже есть

    if (getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cft-reply-trigger';
    btn.textContent = '💬';
    btn.title = 'Предложить ответ';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSuggestClick(wrapper);
    });
    wrapper.appendChild(btn);
  }

  function scan() {
    if (!settings.feature3Enabled) return;
    const editor = window.CftChatterfyApi.getComposeEditor();
    if (!editor) return;
    ensureButton(editor);
  }

  setInterval(scan, RESCAN_INTERVAL_MS);
  scan();
})();
