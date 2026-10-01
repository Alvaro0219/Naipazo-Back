import { Router } from 'express';
import { getMatchDetail, listMyMatches } from '../controllers/matchController.js';
import { authenticate } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import { idParamsSchema } from '../schemas/misc.schemas.js';

const router = Router();

router.get('/', authenticate, listMyMatches);
router.get('/:id', authenticate, validate(idParamsSchema, 'params'), getMatchDetail);

export default router;
