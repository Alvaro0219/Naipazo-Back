import { Router } from 'express';
import { availability, login, logout, me, refresh, register } from '../controllers/authController.js';
import { authenticate } from '../middlewares/auth.js';
import { authLimiter, availabilityLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import {
  availabilitySchema, loginSchema, logoutSchema, refreshSchema, registerSchema
} from '../schemas/auth.schemas.js';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', validate(refreshSchema), refresh);
router.post('/logout', validate(logoutSchema), logout);
router.get('/me', authenticate, me);
router.get('/availability', availabilityLimiter, validate(availabilitySchema, 'query'), availability);

export default router;
