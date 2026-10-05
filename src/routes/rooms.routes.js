import { Router } from 'express';
import {
  cancelRoom, createRoom, getMyRoom, getRoomByCode, joinRoom, joinRoomByCode, listRooms
} from '../controllers/roomController.js';
import { authenticate } from '../middlewares/auth.js';
import { roomLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import {
  createRoomSchema, joinByCodeSchema, listRoomsQuerySchema, roomCodeParamsSchema, roomIdParamsSchema
} from '../schemas/room.schemas.js';

const router = Router();

router.get('/', authenticate, validate(listRoomsQuerySchema, 'query'), listRooms);
router.get('/mine', authenticate, getMyRoom);
router.get('/code/:code', roomLimiter, authenticate, validate(roomCodeParamsSchema, 'params'), getRoomByCode);
router.post('/join-by-code', roomLimiter, authenticate, validate(joinByCodeSchema), joinRoomByCode);
router.post('/', roomLimiter, authenticate, validate(createRoomSchema), createRoom);
router.post('/:id/join', roomLimiter, authenticate, validate(roomIdParamsSchema, 'params'), joinRoom);
router.delete('/:id', authenticate, validate(roomIdParamsSchema, 'params'), cancelRoom);

export default router;
