import { Router } from 'express';
import {
  availability, forgotPassword, login, logout, me, refresh, register, resendVerification, resetPassword, verifyEmail
} from '../controllers/authController.js';
import { authenticate } from '../middlewares/auth.js';
import { authLimiter, availabilityLimiter, emailLimiter, registerLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import {
  availabilitySchema, forgotPasswordSchema, loginSchema, logoutSchema, refreshSchema, registerSchema,
  resetPasswordSchema, verifyEmailSchema
} from '../schemas/auth.schemas.js';

const router = Router();

router.post('/register', registerLimiter, authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', validate(refreshSchema), refresh);
router.post('/logout', validate(logoutSchema), logout);
router.get('/me', authenticate, me);
router.post('/verify-email', emailLimiter, validate(verifyEmailSchema), verifyEmail);
router.post('/resend-verification', emailLimiter, authenticate, resendVerification);
router.post('/forgot-password', emailLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', emailLimiter, validate(resetPasswordSchema), resetPassword);
router.get('/availability', availabilityLimiter, validate(availabilitySchema, 'query'), availability);

export default router;
