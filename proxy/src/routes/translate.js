const express = require('express');
const { enforceBudget, enforceRateLimit } = require('../middleware/budget');
const { estimateTranslateCostUsd } = require('../lib/pricing');
const { recordCost } = require('../lib/budget-store');
const openai = require('../lib/openai');

const router = express.Router();

// TZ п.3.1: POST /translate { text, dialectContext, targetLang? } -> { translation }
router.post(
  '/translate',
  enforceRateLimit,
  enforceBudget((req) => estimateTranslateCostUsd(req.body || {})),
  async (req, res, next) => {
    try {
      const { text, dialectContext, targetLang, direction: rawDirection } = req.body || {};

      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'bad_request', message: 'Поле text обязательно и должно быть непустой строкой.' });
      }
      if (dialectContext !== undefined && !Array.isArray(dialectContext)) {
        return res.status(400).json({ error: 'bad_request', message: 'Поле dialectContext должно быть массивом строк.' });
      }
      // 'to_dialect' — перевод в диалект собеседника (написание ответа),
      // 'to_operator_language' — обратное (чтение входящего). Любое
      // другое/отсутствующее значение — безопасный дефолт 'to_dialect'.
      const direction = rawDirection === 'to_operator_language' ? 'to_operator_language' : 'to_dialect';

      const result = await openai.translate({ text, dialectContext: dialectContext || [], targetLang, direction });

      // TZ п.3.4: в лог/хранилище уходит только стоимость, не текст.
      recordCost(req.employeeToken, req.employeeName, result.costUsd);

      res.json({ translation: result.translation });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
