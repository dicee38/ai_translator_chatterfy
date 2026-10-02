// Товарная версия: Feature 1/2 всегда включены (нет переключателей —
// упрощённый попап для покупателя). Диалект вручную — полезная настройка
// для любого оператора. Адрес прокси/токен/бюджет видны всегда: по модели
// продажи каждая компания разворачивает свой прокси и свой ключ OpenAI
// (docs/TZ.md §3.6), так что это не "внутренняя" настройка владельца, а
// то, что обязан указать сам покупатель, чтобы расширение заработало.
(function () {
  const dialectInput = document.getElementById('manualDialectOverride');
  const clearDialectBtn = document.getElementById('clearDialect');

  async function loadDialectSettings() {
    const stored = await chrome.storage.local.get(['manualDialectOverride']);
    dialectInput.value = stored.manualDialectOverride || '';
  }

  let dialectSaveTimer = null;
  dialectInput.addEventListener('input', () => {
    clearTimeout(dialectSaveTimer);
    dialectSaveTimer = setTimeout(() => {
      chrome.storage.local.set({ manualDialectOverride: dialectInput.value.trim() });
    }, 300);
  });

  clearDialectBtn.addEventListener('click', () => {
    dialectInput.value = '';
    chrome.storage.local.set({ manualDialectOverride: '' });
  });

  loadDialectSettings();

  const proxyUrlInput = document.getElementById('proxyBaseUrl');
  const tokenInput = document.getElementById('extensionToken');
  const saveProxyBtn = document.getElementById('saveProxyConfig');
  const saveStatusEl = document.getElementById('saveStatus');
  const budgetStatusEl = document.getElementById('budgetStatus');
  const budgetBarFillEl = document.getElementById('budgetBarFill');
  const refreshBudgetBtn = document.getElementById('refreshBudget');

  async function loadProxySettings() {
    const stored = await chrome.storage.local.get(['proxyBaseUrl', 'extensionToken']);
    proxyUrlInput.value = stored.proxyBaseUrl || CFT_DEFAULT_PROXY_BASE_URL;
    tokenInput.value = stored.extensionToken || CFT_DEFAULT_EXTENSION_TOKEN;
  }

  saveProxyBtn.addEventListener('click', async () => {
    const proxyBaseUrl = proxyUrlInput.value.trim() || CFT_DEFAULT_PROXY_BASE_URL;
    const extensionToken = tokenInput.value.trim() || CFT_DEFAULT_EXTENSION_TOKEN;
    await chrome.storage.local.set({ proxyBaseUrl, extensionToken });
    saveStatusEl.textContent = 'Сохранено';
    setTimeout(() => { saveStatusEl.textContent = ''; }, 1500);
    refreshBudget();
  });

  function renderBudget(status) {
    if (status.error) {
      budgetStatusEl.textContent = status.error;
      budgetStatusEl.classList.add('cft-budget--error');
      budgetBarFillEl.style.width = '0%';
      return;
    }

    budgetStatusEl.classList.remove('cft-budget--error');
    const { limitUsd, spentUsd, remainingUsd, monthly, employee } = status.budget;
    let text = `Сегодня (компания): $${spentUsd.toFixed(4)} из $${limitUsd.toFixed(2)} (осталось $${remainingUsd.toFixed(4)})`;
    if (monthly) {
      text += `\nЗа месяц (компания): $${monthly.spentUsd.toFixed(4)} из $${monthly.limitUsd.toFixed(2)}`;
    }
    if (employee) {
      text += `\nВы (${employee.name || 'этот токен'}) сегодня: $${employee.spentUsd.toFixed(4)} из $${employee.limitUsd.toFixed(2)}`;
    }
    budgetStatusEl.textContent = text;
    budgetStatusEl.style.whiteSpace = 'pre-line';

    const ratio = limitUsd > 0 ? Math.min(1, spentUsd / limitUsd) : 1;
    budgetBarFillEl.style.width = `${Math.round(ratio * 100)}%`;
    budgetBarFillEl.classList.remove('cft-budget-bar__fill--warn', 'cft-budget-bar__fill--full');
    if (ratio >= 1) budgetBarFillEl.classList.add('cft-budget-bar__fill--full');
    else if (ratio >= 0.7) budgetBarFillEl.classList.add('cft-budget-bar__fill--warn');
  }

  async function refreshBudget() {
    budgetStatusEl.textContent = 'Проверяю...';
    budgetStatusEl.classList.remove('cft-budget--error');

    const stored = await chrome.storage.local.get(['proxyBaseUrl', 'extensionToken']);
    const proxyBaseUrl = stored.proxyBaseUrl || CFT_DEFAULT_PROXY_BASE_URL;
    const extensionToken = stored.extensionToken || CFT_DEFAULT_EXTENSION_TOKEN;

    try {
      // Токен необязателен для /health, но если он есть и валиден — прокси
      // добавит в ответ персональный суб-лимит именно этого сотрудника.
      const res = await fetch(`${proxyBaseUrl}/health`, { headers: { 'X-Extension-Token': extensionToken } });
      if (!res.ok) throw new Error(`прокси ответил ${res.status}`);
      const data = await res.json();
      if (!data.budget) throw new Error('прокси не вернул данные о бюджете');
      renderBudget({ budget: data.budget });
    } catch (err) {
      renderBudget({ error: `Прокси недоступен (${proxyUrlInput.value.trim() || CFT_DEFAULT_PROXY_BASE_URL}). Он запущен?` });
    }
  }

  refreshBudgetBtn.addEventListener('click', refreshBudget);

  loadProxySettings().then(refreshBudget);
})();
