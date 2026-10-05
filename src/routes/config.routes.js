import { Router } from 'express';
import { env } from '../config/env.js';
import { ok } from '../utils/response.js';

const router = Router();

// Parámetros públicos del juego, para que el front no los duplique
router.get('/', (req, res) => ok(res, {
  minBet: env.minBet,
  maxBet: env.maxBet,
  houseRate: env.houseRate,
  dailyGrantAmount: env.dailyGrantAmount,
  turnTimeoutSeconds: env.turnTimeoutSeconds,
  reconnectGraceSeconds: env.reconnectGraceSeconds,
  rematchWindowSeconds: env.rematchWindowSeconds,
  tournamentSizes: [4, 8],
  privateMaxBet: Math.min(env.privateMaxBet, env.maxBet),
  requireEmailVerification: env.requireEmailVerification
}));

export default router;
