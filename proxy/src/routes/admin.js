const express = require('express');
const { requireAdminToken } = require('../middleware/auth');
const { getAdminUsageReport } = require('../lib/budget-store');

const router = express.Router();

// Для главы компании: расход за сегодня/месяц по компании в целом и по
// каждому сотруднику отдельно (кто сколько тратит), без доступа к самим
// операторским токенам или тексту переписки — только агрегированные суммы.
// Требует отдельный X-Admin-Token (ADMIN_TOKEN), не операторский токен.
router.get('/admin/usage', requireAdminToken, (req, res) => {
  res.json(getAdminUsageReport());
});

module.exports = router;
