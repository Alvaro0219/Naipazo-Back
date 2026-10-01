import * as rankingService from '../services/rankingService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildPaginatedResponse, getPagination } from '../utils/pagination.js';
import { ok } from '../utils/response.js';

export const getRanking = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);
  const { items, total } = await rankingService.getRanking(req.validated, { skip, limit });
  return ok(res, buildPaginatedResponse(items, total, { page, limit }));
});
