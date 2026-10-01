import * as historyService from '../services/historyService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildPaginatedResponse, getPagination } from '../utils/pagination.js';
import { ok } from '../utils/response.js';

export const listMyMatches = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);
  const { items, total } = await historyService.listMyMatches(req.user.id, { skip, limit });
  return ok(res, buildPaginatedResponse(items, total, { page, limit }));
});

export const getMatchDetail = asyncHandler(async (req, res) => {
  const match = await historyService.getMatchDetail(req.user.id, req.validated.id);
  return ok(res, { match });
});
