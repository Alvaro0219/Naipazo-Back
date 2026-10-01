import { Router } from 'express';
import { getWallet, listLedger } from '../controllers/walletController.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

router.get('/', authenticate, getWallet);
router.get('/ledger', authenticate, listLedger);

export default router;
