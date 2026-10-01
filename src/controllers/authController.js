import * as authService from '../services/authService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';

export const register = asyncHandler(async (req, res) => {
  const session = await authService.register(req.validated);
  return ok(res, session, 201);
});

export const login = asyncHandler(async (req, res) => {
  const session = await authService.login(req.validated);
  return ok(res, session);
});

export const refresh = asyncHandler(async (req, res) => {
  const session = await authService.refresh(req.validated.refreshToken);
  return ok(res, session);
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.validated.refreshToken);
  return ok(res, { loggedOut: true });
});

export const me = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id);
  return ok(res, { user });
});

export const availability = asyncHandler(async (req, res) => {
  const result = await authService.checkAvailability(req.validated);
  return ok(res, result);
});
