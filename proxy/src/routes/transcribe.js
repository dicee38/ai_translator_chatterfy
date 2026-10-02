const express = require('express');
const multer = require('multer');
const { enforceBudget, enforceRateLimit } = require('../middleware/budget');
const { estimateTranscribeCostUsdFromFileSize, estimateTranscribeCostUsdFromDuration } = require('../lib/pricing');
const { recordCost } = require('../lib/budget-store');
const openai = require('../lib/openai');

// Multer кладёт обычные (не-файловые) текстовые поля multipart в req.body —
// durationSeconds летит как текстовое поле рядом с file.
function parseDurationSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const router = express.Router();

// В памяти, не на диск: TZ п.3.4 — не хранить аудио дольше, чем нужно
// для получения расшифровки. Ограничение размера — грубая защита от
// случайного/злонамеренного огромного файла в мок-режиме без ключей.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// TZ п.3.1: POST /transcribe multipart/form-data, поле file -> { transcript, language? }
router.post(
  '/transcribe',
  upload.single('file'),
  (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({ error: 'bad_request', message: 'Поле file (multipart) обязательно.' });
    }
    next();
  },
  enforceRateLimit,
  enforceBudget((req) => {
    const durationSeconds = parseDurationSeconds(req.body && req.body.durationSeconds);
    return durationSeconds !== undefined
      ? estimateTranscribeCostUsdFromDuration(durationSeconds)
      : estimateTranscribeCostUsdFromFileSize(req.file.size);
  }),
  async (req, res, next) => {
    try {
      const result = await openai.transcribe({
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        durationSeconds: parseDurationSeconds(req.body && req.body.durationSeconds),
      });

      recordCost(req.employeeToken, req.employeeName, result.costUsd);

      res.json({ transcript: result.transcript, language: result.language });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
