export function ok(res, data = {}, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function fail(res, message = 'Unexpected error', status = 400, code = 'BAD_REQUEST') {
  return res.status(status).json({ success: false, error: { message, code } });
}
