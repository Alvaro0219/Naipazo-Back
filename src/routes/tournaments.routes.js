import { Router } from 'express';
import {
  cancelTournament, createTournament, getMyTournament, getTournament, joinTournament, leaveTournament, listTournaments
} from '../controllers/tournamentController.js';
import { authenticate } from '../middlewares/auth.js';
import { roomLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import {
  createTournamentSchema, listTournamentsQuerySchema, tournamentIdParamsSchema
} from '../schemas/tournament.schemas.js';

const router = Router();

router.get('/', authenticate, validate(listTournamentsQuerySchema, 'query'), listTournaments);
router.get('/mine', authenticate, getMyTournament);
router.get('/:id', authenticate, validate(tournamentIdParamsSchema, 'params'), getTournament);
router.post('/', roomLimiter, authenticate, validate(createTournamentSchema), createTournament);
router.post('/:id/join', roomLimiter, authenticate, validate(tournamentIdParamsSchema, 'params'), joinTournament);
router.post('/:id/leave', roomLimiter, authenticate, validate(tournamentIdParamsSchema, 'params'), leaveTournament);
router.delete('/:id', authenticate, validate(tournamentIdParamsSchema, 'params'), cancelTournament);

export default router;
