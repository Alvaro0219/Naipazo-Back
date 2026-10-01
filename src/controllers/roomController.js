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

export const joinRoom = asyncHandler(async (req, res) => {
  const room = await roomService.joinRoom(req.user, req.validated.id);
  return ok(res, { room });
});

export const cancelRoom = asyncHandler(async (req, res) => {
  const room = await roomService.cancelRoom(req.user, req.validated.id);
  return ok(res, { room });
});
