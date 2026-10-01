import * as userService from '../services/userService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';

export const changePassword = asyncHandler(async (req, res) => {
  const session = await userService.changePassword(req.user.id, req.validated);
  return ok(res, session);
});
