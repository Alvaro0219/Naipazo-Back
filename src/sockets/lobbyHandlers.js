import { roomRefSchema, tournamentRefSchema, validateSocketPayload } from '../schemas/socket.schemas.js';
import * as matchService from '../services/matchService.js';
import * as roomService from '../services/roomService.js';
import * as tournamentService from '../services/tournamentService.js';
import { AppError } from '../utils/AppError.js';
import { rooms } from './emitter.js';
import { safeHandler } from './safeHandler.js';

export function registerLobbyHandlers(socket) {
  const { user } = socket;

  socket.on('lobby:subscribe', safeHandler(socket, async () => {
    socket.join(rooms.lobby);
    socket.emit('lobby:rooms', await roomService.listLobbyRooms());
    socket.emit('lobby:tournaments', await tournamentService.listLobbyTournaments());
  }));

  socket.on('lobby:unsubscribe', () => socket.leave(rooms.lobby));

  // Entrar a la mesa (o volver a ella tras una reconexión)
  socket.on('room:join', safeHandler(socket, async (payload) => {
    const { roomId } = validateSocketPayload(roomRefSchema, payload);
    const room = await roomService.getRoomForPlayer(user.id, roomId);
    socket.emit('room:update', room);
    if (room.matchId && room.status !== 'cancelled') {
      await matchService.attachSocket(room.matchId, user.id, socket);
    }
  }));

  // Salir de una sala en espera: si sos el anfitrión, se cancela
  socket.on('room:leave', safeHandler(socket, async (payload) => {
    const { roomId } = validateSocketPayload(roomRefSchema, payload);
    const room = await roomService.getRoomForPlayer(user.id, roomId);
    if (room.status !== 'waiting') {
      throw new AppError('No podés salir de una partida en curso', 409, 'MATCH_IN_PROGRESS');
    }
    await roomService.cancelRoom(user, roomId);
  }));

  // Seguir en vivo el cuadro de un torneo (cualquiera puede mirarlo)
  socket.on('tournament:subscribe', safeHandler(socket, async (payload) => {
    const { tournamentId } = validateSocketPayload(tournamentRefSchema, payload);
    const tournament = await tournamentService.getTournament(tournamentId);
    socket.join(rooms.tournament(tournamentId));
    socket.emit('tournament:update', tournament);
  }));

  socket.on('tournament:unsubscribe', safeHandler(socket, async (payload) => {
    const { tournamentId } = validateSocketPayload(tournamentRefSchema, payload);
    socket.leave(rooms.tournament(tournamentId));
  }));
}
