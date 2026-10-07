import { Router } from 'express';
import {
  cancelRoom, changeSeat, confirmReady, createRoom, getMyRoom, getRoomByCode, joinRoom, joinRoomByCode, leaveRoom, listRooms
} from '../controllers/roomController.js';
import { authenticate } from '../middlewares/auth.js';
import { roomLimiter, roomCodeIpLimiter, roomCodeUserLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import {
  changeSeatSchema, createRoomSchema, joinByCodeSchema, joinRoomSchema, listRoomsQuerySchema, roomCodeParamsSchema,
  roomIdParamsSchema
} from '../schemas/room.schemas.js';

const router = Router();

router.get('/', authenticate, validate(listRoomsQuerySchema, 'query'), listRooms);
router.get('/mine', authenticate, getMyRoom);
router.get('/code/:code', roomCodeIpLimiter, authenticate, roomCodeUserLimiter, validate(roomCodeParamsSchema, 'params'), getRoomByCode);
router.post('/join-by-code', roomCodeIpLimiter, authenticate, roomCodeUserLimiter, validate(joinByCodeSchema), joinRoomByCode);
router.post('/', roomLimiter, authenticate, validate(createRoomSchema), createRoom);
router.post('/:id/join', roomLimiter, authenticate, validate(roomIdParamsSchema, 'params'), validate(joinRoomSchema), joinRoom);
router.post('/:id/seat', roomLimiter, authenticate, validate(roomIdParamsSchema, 'params'), validate(changeSeatSchema), changeSeat);
router.post('/:id/ready', roomLimiter, authenticate, validate(roomIdParamsSchema, 'params'), confirmReady);
router.post('/:id/leave', roomLimiter, authenticate, validate(roomIdParamsSchema, 'params'), leaveRoom);
router.delete('/:id', authenticate, validate(roomIdParamsSchema, 'params'), cancelRoom);

export default router;
