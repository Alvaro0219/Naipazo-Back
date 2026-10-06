import * as roomService from '../services/roomService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildPaginatedResponse, getPagination } from '../utils/pagination.js';
import { ok } from '../utils/response.js';

export const listRooms = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);
  const { items, total } = await roomService.listOpenRooms(req.validated, { skip, limit });
  return ok(res, buildPaginatedResponse(items, total, { page, limit }));
});

export const getMyRoom = asyncHandler(async (req, res) => {
  const room = await roomService.getActiveRoom(req.user.id);
  return ok(res, { room });
});

export const createRoom = asyncHandler(async (req, res) => {
  const room = await roomService.createRoom(req.user, req.validated);
  return ok(res, { room }, 201);
});

export const getRoomByCode = asyncHandler(async (req, res) => {
  const room = await roomService.getRoomByCode(req.validated.code);
  return ok(res, { room });
});

export const joinRoomByCode = asyncHandler(async (req, res) => {
  const room = await roomService.joinRoomByCode(req.user, req.validated.code, { seat: req.validated.seat ?? null });
  return ok(res, { room });
});

export const changeSeat = asyncHandler(async (req, res) => {
  const room = await roomService.changeSeat(req.user, req.params.id, req.validated.seat);
  return ok(res, { room });
});

export const leaveRoom = asyncHandler(async (req, res) => {
  const room = await roomService.leaveRoom(req.user, req.params.id);
  return ok(res, { room });
});

// Las rutas con id y cuerpo validan los dos: el id ya validado se lee de req.params
export const joinRoom = asyncHandler(async (req, res) => {
  const room = await roomService.joinRoom(req.user, req.params.id, { seat: req.validated.seat ?? null });
  return ok(res, { room });
});

export const cancelRoom = asyncHandler(async (req, res) => {
  const room = await roomService.cancelRoom(req.user, req.validated.id);
  return ok(res, { room });
});
