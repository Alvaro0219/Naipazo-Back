import { Router } from 'express';
import { cancelRoom, createRoom, getMyRoom, joinRoom, listRooms } from '../controllers/roomController.js';
import { authenticate } from '../middlewares/auth.js';
import { roomLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';
import { createRoomSchema, listRoomsQuerySchema, roomIdParamsSchema } from '../schemas/room.schemas.js';

const router = Router();

router.get('/', authenticate, validate(listRoomsQuerySchema, 'query'), listRooms);
router.get('/mine', authenticate, getMyRoom);
router.post('/', roomLimiter, authenticate, validate(createRoomSchema), createRoom);
router.post('/:id/join', roomLimiter, authenticate, validate(roomIdParamsSchema, 'params'), joinRoom);
router.delete('/:id', authenticate, validate(roomIdParamsSchema, 'params'), cancelRoom);

export default router;
