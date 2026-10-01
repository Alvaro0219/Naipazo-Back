import { Router } from 'express';
import { adjustChips, listUsers, setUserStatus } from '../controllers/adminController.js';
import { authenticate, requireRole } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import { adjustChipsSchema, adminUsersQuerySchema, setUserStatusSchema } from '../schemas/misc.schemas.js';

const router = Router();

router.use(authenticate, requireRole(['admin']));

router.get('/users', validate(adminUsersQuerySchema, 'query'), listUsers);
router.patch('/users/:id/status', validate(setUserStatusSchema), setUserStatus);
router.post('/users/:id/adjust', validate(adjustChipsSchema), adjustChips);

export default router;
