import * as adminService from '../services/adminService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildPaginatedResponse, getPagination } from '../utils/pagination.js';
import { ok } from '../utils/response.js';

// `req.params.id` inválido termina en CastError → 400 INVALID_ID desde el error handler global.

export const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);
  const { items, total } = await adminService.listUsers(req.validated, { skip, limit });
  return ok(res, buildPaginatedResponse(items, total, { page, limit }));
});

export const chipFlows = asyncHandler(async (req, res) => {
  const items = await adminService.chipFlows(req.validated);
  return ok(res, { items });
});

export const setUserStatus = asyncHandler(async (req, res) => {
  const user = await adminService.setUserActive(req.user.id, req.params.id, req.validated.isActive);
  return ok(res, { user });
});

export const adjustChips = asyncHandler(async (req, res) => {
  const result = await adminService.adjustChips(req.user.id, req.params.id, req.validated);
  return ok(res, result);
});
