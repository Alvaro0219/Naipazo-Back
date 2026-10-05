# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backend de **Truco Online** (Fase 1: fichas virtuales). El frontend vive en un repo hermano: `../truco-front`.
La especificación funcional completa está en `../PROYECTO_TRUCO_ONLINE.md` (modelo de datos, reglas de truco,
eventos de Socket.IO, torneos, hitos M0–M8). La arquitectura base sale de la skill `fullstack-scaffold`
(`~/.claude/skills/fullstack-scaffold/backend-architecture.md`); no se aparta de ella salvo en las extensiones
que el documento del proyecto lista en su sección 3.2 (`socket.io`, `vitest`, `src/game/`, `src/sockets/`).

## Comandos

```bash
npm run dev                                      # API en :4000 con node --watch
npm run make-admin -- <usuario> [--revoke]       # dar/quitar rol admin (vuelve a iniciar sesión)
npm test                                         # vitest run (todos)
npx vitest run src/utils/__tests__/dates.test.js # un archivo
npx vitest run -t "no duplica el crédito"        # un test por nombre
```

No hay linter configurado. Healthcheck: `GET /health` → `{"ok":true}`.

Los tests de `src/services/__tests__/` son de integración y se **saltean** si `MONGO_URL_TEST` no está en
`.env`. Esa base se **borra** (`dropDatabase`) antes de cada test: nunca apuntarla a `truco_db`.
Corren en serie (`fileParallelism: false`) contra Atlas (~3 min). `connectTestDb` aborta si la base no termina en
`_test` o coincide con `MONGO_URL` (`utils/testDbGuard.js`). Nunca correr dos suites a la vez: comparten la base.

## Reglas que no se deducen leyendo un solo archivo

- **Guardarraíles legales:** las fichas no tienen valor monetario. No implementar depósitos, retiros, pagos,
  canje ni nada que convierta fichas en dinero o premios.
- **Saldo:** solo `services/walletService.js` modifica `User.balance`. Cada movimiento es una transacción con
  `$inc` condicionado + un `LedgerEntry` cuya `idempotencyKey` es única (`daily:{userId}:{fecha}`,
  `betlock:{matchId}:{userId}`, etc.). Repetir una operación devuelve `{ duplicated: true }` sin efectos.
  `lockBet/payoutBet/refundBet` aceptan `{ session }` para componerse en una transacción mayor (ej. bloquear
  la apuesta de ambos jugadores al unirse a una sala).
- **`LedgerEntry` es inmutable:** hooks de Mongoose rechazan cualquier update/delete, incluso `deleteMany`.
  En tests se limpia con `dropDatabase`.
- **Transacciones requieren replica set** (Atlas lo es). Usar `utils/transaction.js#runInTransaction`;
  `withTransaction` puede reintentar el callback, así que debe ser idempotente.
- **Crédito diario perezoso:** `claimDailyGrantIfDue` se llama en login, refresh, `GET /wallet` y (M4) al
  conectar el socket. No hay cron. Día calendario en `APP_TIMEZONE` vía `utils/dates.js` (sin librerías).
  Las respuestas de sesión incluyen `dailyGrant: { granted, amount, nextGrantAt }`.
- **Auth:** el access token se verifica sin DB (`utils/tokens.js#verifyAccessToken`, reutilizable por
  Socket.IO). El refresh token lleva `ver` = `User.tokenVersion`; logout lo incrementa e invalida todas las
  sesiones del usuario.
- **Unicidad de usuario:** índice único en `email` y en `usernameLower` (se setea en un hook `pre('validate')`).
  `authService.register` valida antes y además traduce el error 11000 a `EMAIL_TAKEN`/`USERNAME_TAKEN`.
- **`process.env` solo se lee en `config/env.js`** (schema Joi; en producción el proceso termina si falta
  algo obligatorio). Variables nuevas se agregan ahí y en `.env.example`.
- **Errores y validación:** los controllers no llevan try/catch; lanzan `AppError(message, status, code)`.
  Los mensajes al usuario van en español rioplatense con voseo. `middlewares/validate.js` aplica los
  mensajes Joi en español de `schemas/messages.js`; los schemas usan `.label()`.
- **CORS:** la política está en `config/cors.js` para reutilizarla en Socket.IO.
- **Una sola instancia** en producción (Railway): desde M4 las partidas activas viven en memoria.

## Motor de truco (`src/game/truco/`)

- **Puro**: `applyAction(state, playerId, action) → { state, events }` o lanza `RuleError { code }`. Nunca muta
  el estado recibido (usa `structuredClone`). Sin DB, sockets ni reloj: la aleatoriedad entra solo por el mazo
  que se pasa a `dealNextHand(state, shuffleDeck())`, y los timers viven en el servicio que lo orquesta
  (`applyTimeout`, `forfeitMatch`).
- Ciclo: `createMatchState` → `dealNextHand` → `applyAction`... hasta `phase === 'hand_over'` → `dealNextHand` …
  → `phase === 'finished'`.
- `check()` en `engine.js` es la **única** fuente de verdad de legalidad; `getAvailableActions` la reutiliza
  probando cada tipo de acción. Una regla nueva va en `check()` y en el `apply`, nunca en el front.
- `views.js#projectStateFor` es lo único que se envía a un cliente. `state.hand.deck` y `state.hand.dealt`
  nunca salen de ahí; el test `views` lo verifica sobre partidas simuladas completas.
- Equipos por asiento (`team = seat % 2`): 1 vs 1 hoy, 2 vs 2 sin cambiar el modelo.
- **Sin flor** por decisión del usuario: `withFlor: true` lanza `FLOR_NOT_SUPPORTED`.
- `docs/TRUCO_RULES.md` documenta la variante (incluido "mazo en primera paga el envido") y qué suite testea
  cada regla. Las variantes que cambian el resultado de una partida se consultan al usuario antes de tocarlas.
- `__tests__/simulation.js` juega partidas entre bots aleatorios con PRNG sembrado (`helpers.js#seededRng`);
  sirve para verificar invariantes nuevos con `onStep`.

## Tiempo real (salas y partidas)

- `routes/rooms.routes.js` (REST) crea/une/cancela salas; `sockets/` cumple el rol de controllers del tiempo
  real (validan con Joi vía `validateSocketPayload` y delegan). Todo error de socket sale por
  `safeHandler` como `game:error { code, message }` solo a ese socket.
- `roomService.joinRoom` ocupa el asiento, crea el `Match` y hace los `lockBet` de ambos en **una
  transacción**, y recién después llama a `matchService.startMatch`.
- Pagos y reembolsos de apuestas: solo `services/betService.js` (`settleMatchBets`, idempotente; marca
  `Match.betsSettled`). `matchService.recoverOnStartup` cancela partidas `playing` y liquida pendientes.
- Timers en `matchService` (`settings.turnTimeoutMs`, `reconnectGraceMs`, `nextHandDelayMs`, ajustables
  en tests): el de turno es el reloj de la **decisión**: `publish` lo reinicia solo con eventos nuevos del motor;
  entrar a la mesa o desconectarse (`publish(rt, [], { keepClock: true })`) no lo reinicia. Se pausa si quien
  actúa está desconectado y retoma con `rt.turnRemainingMs` (por defecto 20 s);
  la gracia arranca en `detachSocket` (y al crear la partida) y termina en `endByAbandon`.
- `matchService` guarda las partidas activas en un `Map` en memoria (una sola instancia). El motor es
  síncrono: el estado se actualiza antes de cualquier `await`, así que no hay carreras entre acciones.
  Persiste un `MatchHandLog` por mano y al terminar actualiza `Match`, `Room` y `User.stats`.
  Al arrancar el server, `cancelInterruptedMatches` cancela las partidas que quedaron `playing`.
- **Nunca** emitir el estado completo: `publish` manda `game:event` (públicos) a la room `match:{id}` y
  `game:state` proyectado a cada socket por separado. Los services emiten solo vía `sockets/emitter.js`
  (`setTestSink` captura emisiones en tests; `roomMatch.test.js` revisa que ninguna filtre cartas).
- Una conexión de juego por jugador (`rt.sockets`): la nueva reemplaza a la anterior (`SESSION_REPLACED`).
- `matchService.settings.nextHandDelayMs` es la pausa entre manos (0 en tests).
- Para probar con dos jugadores en una máquina: segundo navegador en `http://p2.localhost:5173`
  (ya está en `CORS_ORIGINS` del `.env` de desarrollo). Credenciales de prueba en `test-users.local.md`.

## Revancha y torneos (M7)

- **Una sola cosa a la vez:** `roomService.assertUserIsFree` rechaza crear/unirse a salas o torneos si el usuario
  tiene una sala en espera o en juego, o sigue vivo en un torneo (`entrants.eliminated: false`).
- `roomService.createMatchForRoom` es el único lugar que crea un `Match` y bloquea apuestas; lo usan
  `joinRoom`, `createRematchRoom` (revancha: sala nueva con `rematchOf`) y `createTournamentRoom` (sala de
  torneo, arranca en `playing`, `bet: 0`, `uuid = tournament:{id}:{ronda}:{llave}` → idempotente).
- **Revancha** (`services/rematchService.js`): el estado vive en memoria con la partida terminada (TTL de
  `matchService`). `game:rematch` pide o acepta; `game:rematch:decline` la cierra; vence a los
  `REMATCH_WINDOW_SECONDS`. No hay revancha en partidas de torneo.
- **Torneos** (`services/tournamentService.js`, modelo `Tournament`, cuadro puro en `utils/bracket.js`):
  la inscripción se cobra al anotarse (`TOURNAMENT_ENTRY`, clave por `entryId` para permitir salir y volver);
  al completarse el cupo, `startTournament` sortea (Fisher-Yates con `crypto.randomInt`) y arranca la primera
  ronda. `matchService.onMatchFinished` (registro de listeners, evita el ciclo de imports) avisa el fin de cada
  partida; el ganador avanza y la llave siguiente arranca tras `TOURNAMENT_NEXT_MATCH_SECONDS`
  (`tournamentService.settings.nextMatchDelayMs`, 0 en tests). Premio = `buyIn × size` menos comisión
  (`TOURNAMENT_PRIZE`, una vez por torneo). `settleTournament` es idempotente; al reiniciar, los torneos en juego
  se cancelan y se devuelven todas las inscripciones (`tournamentService.recoverOnStartup`, en `app.js`).
- Eventos nuevos: `lobby:tournaments`, `tournament:update` (room `tournament:{id}` y canal de cada inscripto),
  `tournament:match` (al usuario: su partida está lista), `game:rematch`.

## Salas privadas

- `Room.config.isPrivate`: la sala no sale en `lobby:rooms` ni en `GET /api/rooms` (filtro `config.isPrivate: { $ne: true }` en `roomService`) y no dispara `notifyLobby`.
- Se entra solo con el código de 6 caracteres: `GET /api/rooms/code/:code` y `POST /api/rooms/join-by-code`. `joinRoom(user, id)` rechaza las privadas con 404 salvo `{ viaCode: true }`: conocer el id no alcanza.

## Hitos

M0–M7 hechos (scaffold, auth, billetera, motor, salas + mesa, apuestas + timers + abandono, historial +
ranking + perfil + admin, revancha + PWA + torneos). Próximo: M8 — despliegue (Railway + Cloudflare Pages +
Atlas, `deployment-guide.md` de la skill; una sola instancia del back).

## Historial y privacidad

- `MatchHandLog.publicEvents` guarda los eventos del motor que ya se emitieron a ambos jugadores; el
  detalle de partida (`historyService.getMatchDetail`) arma la vista SOLO con eso + las cartas propias +
  las jugadas. Las cartas no jugadas del rival nunca se exponen, ni con la partida terminada (revelarían
  sus tantos: regla del usuario). `profileAdmin.test.js` lo verifica.
- Errores que no son de sesión (ej. contraseña actual incorrecta) responden 400, nunca 401: el front
  trata todo 401 como sesión vencida y refresca.
- Los tests de integración comparten helpers en `src/services/__tests__/tableHelpers.js`
  (`createUser`, `startTable`, `playToEnd`, `fakeSocket`, `waitFor`). Torneos: `tournament.test.js`; revancha:
  `rematch.test.js`.
