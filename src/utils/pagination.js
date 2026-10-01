export function getPagination(req, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || defaultLimit, maxLimit);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function buildPaginatedResponse(items, total, { page, limit }) {
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}
