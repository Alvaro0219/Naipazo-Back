import { Router } from 'express';
import authRoutes from './auth.routes.js';
import roomRoutes from './rooms.routes.js';
import walletRoutes from './wallet.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/wallet', walletRoutes);
router.use('/rooms', roomRoutes);

export default router;
