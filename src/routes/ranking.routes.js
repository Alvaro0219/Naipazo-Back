import { Router } from 'express';
import { getRanking } from '../controllers/rankingController.js';
import { authenticate } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import { rankingQuerySchema } from '../schemas/misc.schemas.js';

const router = Router();

router.get('/', authenticate, validate(rankingQuerySchema, 'query'), getRanking);

export default router;
