import * as tournamentService from '../services/tournamentService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildPaginatedResponse, getPagination } from '../utils/pagination.js';
import { ok } from '../utils/response.js';

export const listTournaments = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);
  const { items, total } = await tournamentService.listOpenTournaments(req.validated, { skip, limit });
  return ok(res, buildPaginatedResponse(items, total, { page, limit }));
});

export const getMyTournament = asyncHandler(async (req, res) => {
  const tournament = await tournamentService.getActiveTournament(req.user.id);
  return ok(res, { tournament });
});

export const getTournament = asyncHandler(async (req, res) => {
  const tournament = await tournamentService.getTournament(req.validated.id);
  return ok(res, { tournament });
});

export const createTournament = asyncHandler(async (req, res) => {
  const tournament = await tournamentService.createTournament(req.user, req.validated);
  return ok(res, { tournament }, 201);
});

export const joinTournament = asyncHandler(async (req, res) => {
  const tournament = await tournamentService.joinTournament(req.user, req.validated.id);
  return ok(res, { tournament });
});

export const leaveTournament = asyncHandler(async (req, res) => {
  const tournament = await tournamentService.leaveTournament(req.user, req.validated.id);
  return ok(res, { tournament });
});

export const cancelTournament = asyncHandler(async (req, res) => {
  const tournament = await tournamentService.cancelTournament(req.user, req.validated.id);
  return ok(res, { tournament });
});
