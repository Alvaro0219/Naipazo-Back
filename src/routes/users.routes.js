import { Router } from 'express';
import { changePassword } from '../controllers/userController.js';
import { authenticate } from '../middlewares/auth.js';
import { authLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import { changePasswordSchema } from '../schemas/misc.schemas.js';

const router = Router();

// El nombre de usuario no se puede cambiar en el MVP: solo la contraseña
router.patch('/me/password', authLimiter, authenticate, validate(changePasswordSchema), changePassword);

export default router;
