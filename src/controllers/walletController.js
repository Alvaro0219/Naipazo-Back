import * as walletService from '../services/walletService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildPaginatedResponse, getPagination } from '../utils/pagination.js';
import { ok } from '../utils/response.js';

export const getWallet = asyncHandler(async (req, res) => {
  const dailyGrant = await walletService.claimDailyGrantIfDue(req.user.id);
  const balance = await walletService.getBalance(req.user.id);
  return ok(res, { balance, dailyGrant });
});

export const listLedger = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);
  const { items, total } = await walletService.listLedger(req.user.id, { skip, limit });
  return ok(res, buildPaginatedResponse(items, total, { page, limit }));
});
