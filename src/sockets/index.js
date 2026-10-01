import { Server } from 'socket.io';
import { isOriginAllowed } from '../config/cors.js';
import * as matchService from '../services/matchService.js';
import { claimDailyGrantIfDue, getBalance } from '../services/walletService.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { rooms, setIo } from './emitter.js';
import { registerGameHandlers } from './gameHandlers.js';
import { registerLobbyHandlers } from './lobbyHandlers.js';

export function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: (origin, callback) => callback(null, isOriginAllowed(origin)) },
    transports: ['websocket', 'polling']
  });
  setIo(io);

  // Misma verificación que el middleware `authenticate`, con el access token del handshake
  io.use((socket, next) => {
    try {
      socket.user = verifyAccessToken(socket.handshake.auth?.token);
      next();
    } catch {
      const err = new Error('UNAUTHORIZED');
      err.data = { code: 'UNAUTHORIZED' };
      next(err);
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket;
    socket.join(rooms.user(user.id));

    claimDailyGrantIfDue(user.id)
      .then(async (dailyGrant) => {
        if (dailyGrant.granted) socket.emit('wallet:update', { balance: await getBalance(user.id), dailyGrant });
      })
      .catch((err) => console.error('Crédito diario al conectar el socket:', err));

    registerLobbyHandlers(socket);
    registerGameHandlers(socket);

    socket.on('disconnect', () => matchService.detachSocket(user.id, socket.id));
  });

  return io;
}
