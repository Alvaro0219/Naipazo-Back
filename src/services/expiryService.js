import { expireWaitingRooms } from './roomService.js';
import { expireWaitingTournaments } from './tournamentService.js';

// P6: vencimiento de salas y torneos en espera. Corre al arrancar (cubre lo que venció con el server caído)
// y después cada minuto. No hace falta más precisión que eso.
export const settings = { intervalMs: 60 * 1000 };
let timer = null;

export async function runExpiry(now = new Date()) {
  try {
    const rooms = await expireWaitingRooms(now);
    const tournaments = await expireWaitingTournaments(now);
    if (rooms || tournaments) console.info(`Vencimientos: ${rooms} sala(s) y ${tournaments} torneo(s) cancelados por falta de rivales`);
  } catch (err) {
    console.error('No se pudieron procesar los vencimientos:', err);
  }
}

export function startExpiryScheduler() {
  if (timer) return;
  runExpiry();
  timer = setInterval(runExpiry, settings.intervalMs);
  timer.unref?.();
}
