import { Router } from 'express';
import {
  adjustChips, chipFlows, integritySummary, listUsers, resolveIncident, runReconciliation, setUserStatus
} from '../controllers/adminController.js';
import { authenticate, requireRole } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import {
  adjustChipsSchema, adminUsersQuerySchema, chipFlowsQuerySchema, idParamsSchema, setUserStatusSchema
} from '../schemas/misc.schemas.js';

const router = Router();

router.use(authenticate, requireRole(['admin']));

router.get('/users', validate(adminUsersQuerySchema, 'query'), listUsers);
// Integridad (EXACTITUD_DEL_JUEGO.md, 10.4)
router.get('/integrity', integritySummary);
router.post('/integrity/reconcile', runReconciliation);
router.post('/incidents/:id/resolve', validate(idParamsSchema, 'params'), resolveIncident);
router.get('/chip-flows', validate(chipFlowsQuerySchema, 'query'), chipFlows);
router.patch('/users/:id/status', validate(setUserStatusSchema), setUserStatus);
router.post('/users/:id/adjust', validate(adjustChipsSchema), adjustChips);

export default router;
