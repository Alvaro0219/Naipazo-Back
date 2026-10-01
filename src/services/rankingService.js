import { LedgerEntry } from '../models/LedgerEntry.js';
import { Match } from '../models/Match.js';
import { User } from '../models/User.js';

const PERIOD_DAYS = { week: 7, month: 30 };
const BET_TYPES = ['BET_LOCK', 'BET_PAYOUT', 'BET_REFUND'];

/** Excluye cuentas bloqueadas y trae el nombre de usuario actual. */
const withActiveUser = [
  { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
  { $unwind: '$user' },
  { $match: { 'user.isActive': true } }
];

async function paginate(model, pipeline, { skip, limit }) {
  const [result] = await model.aggregate([
    ...pipeline,
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'n' }] } }
  ]);
  return { rows: result.items, total: result.total[0]?.n ?? 0 };
}

/**
 * Ranking por partidas ganadas (`by: 'won'`) o por fichas ganadas (`by: 'chips'`).
 * `period: 'all'` usa las estadísticas acumuladas del usuario; `week`/`month` (últimos 7/30 días)
 * se calculan desde las partidas y el ledger. En período, "fichas" es el resultado neto de apuestas.
 */
export async function getRanking({ by = 'won', period = 'all' }, { skip, limit }) {
  let rows;
  let total;

  if (period === 'all') {
    const filter = { isActive: true, 'stats.played': { $gt: 0 } };
    if (by === 'chips') filter['stats.chipsWon'] = { $gt: 0 };
    const sort = by === 'chips'
      ? { 'stats.chipsWon': -1, 'stats.won': -1, _id: 1 }
      : { 'stats.won': -1, 'stats.played': 1, _id: 1 };
    const [users, count] = await Promise.all([
      User.find(filter).sort(sort).skip(skip).limit(limit).select('username stats').lean(),
      User.countDocuments(filter)
    ]);
    rows = users.map((u) => ({
      userId: String(u._id), username: u.username, won: u.stats.won, played: u.stats.played, chips: u.stats.chipsWon
    }));
    total = count;
  } else {
    const since = new Date(Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
    if (by === 'chips') {
      ({ rows, total } = await paginate(LedgerEntry, [
        { $match: { type: { $in: BET_TYPES }, createdAt: { $gte: since } } },
        { $group: { _id: '$userId', chips: { $sum: '$amount' } } },
        { $match: { chips: { $gt: 0 } } },
        ...withActiveUser,
        { $sort: { chips: -1, _id: 1 } }
      ], { skip, limit }));
    } else {
      ({ rows, total } = await paginate(Match, [
        { $match: { status: 'finished', endedAt: { $gte: since } } },
        { $unwind: '$players' },
        {
          $group: {
            _id: '$players.userId',
            played: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ['$players.team', '$winnerTeam'] }, 1, 0] } }
          }
        },
        ...withActiveUser,
        { $sort: { won: -1, played: 1, _id: 1 } }
      ], { skip, limit }));
    }
    rows = rows.map((r) => ({
      userId: String(r._id), username: r.user.username, won: r.won ?? null, played: r.played ?? null, chips: r.chips ?? null
    }));
  }

  return { items: rows.map((r, i) => ({ rank: skip + i + 1, ...r })), total };
}
