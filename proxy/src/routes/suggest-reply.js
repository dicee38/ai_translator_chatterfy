const express = require('express');
const { enforceBudget, enforceRateLimit } = require('../middleware/budget');
const { estimateSuggestReplyCostUsd } = require('../lib/pricing');
const { recordCost } = require('../lib/budget-store');
const openai = require('../lib/openai');

const router = express.Router();

function isValidConversationContext(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((m) => m && (m.role === 'operator' || m.role === 'interlocutor') && typeof m.text === 'string' && m.text.trim())
  );
}

// TZ п.3.1: POST /suggest-reply { conversationContext } -> { replyInDialect, backTranslationRu }
router.post(
  '/suggest-reply',
  enforceRateLimit,
  enforceBudget((req) => estimateSuggestReplyCostUsd(req.body || {})),
  async (req, res, next) => {
    try {
      const { conversationContext, operatorPersona } = req.body || {};

      if (!isValidConversationContext(conversationContext)) {
        return res.status(400).json({
          error: 'bad_request',
          message: 'Поле conversationContext обязательно: непустой массив { role: "operator"|"interlocutor", text: string }.',
        });
      }
      if (operatorPersona !== undefined && typeof operatorPersona !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'Поле operatorPersona, если задано, должно быть строкой.' });
      }

      const result = await openai.suggestReply({ conversationContext, operatorPersona });

      // TZ п.3.4: в лог/хранилище уходит только стоимость, не текст диалога.
      recordCost(req.employeeToken, req.employeeName, result.costUsd);

      res.json({ replyInDialect: result.replyInDialect, backTranslationRu: result.backTranslationRu });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
