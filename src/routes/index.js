import { Router } from 'express';
import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import configRoutes from './config.routes.js';
import matchRoutes from './matches.routes.js';
import rankingRoutes from './ranking.routes.js';
import roomRoutes from './rooms.routes.js';
import userRoutes from './users.routes.js';
import walletRoutes from './wallet.routes.js';

const router = Router();

router.use('/config', configRoutes);
router.use('/auth', authRoutes);
router.use('/wallet', walletRoutes);
router.use('/rooms', roomRoutes);
router.use('/matches', matchRoutes);
router.use('/ranking', rankingRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);

export default router;
