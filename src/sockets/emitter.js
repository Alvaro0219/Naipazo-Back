// Punto único para emitir eventos de Socket.IO desde los services.
// Si no hay servidor de sockets (tests, scripts) las emisiones se ignoran o van al `sink` de prueba.

let io = null;
let testSink = null;

export function setIo(instance) {
  io = instance;
}

/** Solo tests: captura todas las emisiones como { target, event, data }. */
export function setTestSink(fn) {
  testSink = fn;
}

function emit(target, event, data) {
  if (testSink) testSink({ target, event, data });
  if (io) io.to(target).emit(event, data);
}

export const rooms = {
  user: (userId) => `user:${userId}`,
  match: (matchId) => `match:${matchId}`,
  tournament: (tournamentId) => `tournament:${tournamentId}`,
  lobby: 'lobby'
};

export const toUser = (userId, event, data) => emit(rooms.user(userId), event, data);
export const toMatch = (matchId, event, data) => emit(rooms.match(matchId), event, data);
export const toLobby = (event, data) => emit(rooms.lobby, event, data);
export const toTournament = (tournamentId, event, data) => emit(rooms.tournament(tournamentId), event, data);
export const toSocket = (socketId, event, data) => emit(socketId, event, data);

/** Saca a un socket (por id) de una room de Socket.IO. */
export function removeSocketFromRoom(socketId, room) {
  if (io) io.in(socketId).socketsLeave(room);
}
