import { randomUUID } from 'node:crypto';
import { getAvailableActions } from '../../game/truco/index.js';
import { User } from '../../models/User.js';
import * as matchService from '../matchService.js';
import * as roomService from '../roomService.js';
import { claimDailyGrantIfDue } from '../walletService.js';

let seq = 0;

export async function createUser({ chips = false, prefix = 'mesa' } = {}) {
  seq += 1;
  const doc = await User.create({
    username: `${prefix}${seq}`, email: `${prefix}${seq}@test.com`, passwordHash: 'x', acceptedTermsAt: new Date(), emailVerified: true
  });
  if (chips) await claimDailyGrantIfDue(doc._id); // 1000 fichas
  return { id: String(doc._id), username: doc.username };
}

/** Socket falso: guarda lo que se le emite directamente. */
export function fakeSocket(id) {
  return { id, emitted: [], joined: [], emit(event, data) { this.emitted.push({ event, data }); }, join(room) { this.joined.push(room); } };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('Tiempo de espera agotado');
    await sleep(stepMs);
  }
}

/** Crea una sala, la completa y conecta a los dos jugadores. */
export async function startTable({ bet = 0, targetPoints = 15, chips = bet > 0, host, guest } = {}) {
  host ||= await createUser({ chips });
  guest ||= await createUser({ chips });
  const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints, bet });
  const { matchId } = await roomService.joinRoom(guest, room.id);
  const sockets = { [host.id]: fakeSocket(`s-${host.id}`), [guest.id]: fakeSocket(`s-${guest.id}`) };
  await matchService.attachSocket(matchId, host.id, sockets[host.id]);
  await matchService.attachSocket(matchId, guest.id, sockets[guest.id]);
  return { host, guest, room, matchId, sockets };
}

/** Juega con decisiones pseudoaleatorias hasta que la partida termina. */
export async function playToEnd(matchId, seed = 12345) {
  let rng = seed;
  const pick = (n) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % n; };
  for (let i = 0; i < 3000; i++) {
    const rt = matchService.getRuntime(matchId);
    if (rt.finished) return rt;
    if (rt.finishing || rt.state.phase !== 'playing') { await sleep(5); continue; }
    const actor = rt.state.players.find((p) => getAvailableActions(rt.state, p.id).length > 0);
    const types = getAvailableActions(rt.state, actor.id).filter((t) => t !== 'GO_TO_DECK' || pick(8) === 0);
    const type = types[pick(types.length)] || 'GO_TO_DECK';
    const payload = type === 'PLAY_CARD' ? { cardId: rt.state.hand.cards[actor.id][0] } : {};
    await matchService.handleAction(actor.id, { matchId, actionId: randomUUID(), type, payload });
  }
  throw new Error('La partida no terminó');
}
