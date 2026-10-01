# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backend de **Truco Online** (Fase 1: fichas virtuales). El frontend vive en un repo hermano: `../truco-front`.
La especificación funcional completa está en `../PROYECTO_TRUCO_ONLINE.md` (modelo de datos, reglas de truco,
eventos de Socket.IO, hitos M0–M7). La arquitectura base sale de la skill `fullstack-scaffold`
(`~/.claude/skills/fullstack-scaffold/backend-architecture.md`); no se aparta de ella salvo en las extensiones
que el documento del proyecto lista en su sección 3.2 (`socket.io`, `vitest`, `src/game/`, `src/sockets/`).

## Comandos

```bash
npm run dev                                      # API en :4000 con node --watch
npm test                                         # vitest run (todos)
npx vitest run src/utils/__tests__/dates.test.js # un archivo
npx vitest run -t "no duplica el crédito"        # un test por nombre
```

No hay linter configurado. Healthcheck: `GET /health` → `{"ok":true}`.

Los tests de `src/services/__tests__/` son de integración y se **saltean** si `MONGO_URL_TEST` no está en
`.env`. Esa base se **borra** (`dropDatabase`) antes de cada test: nunca apuntarla a `truco_db`.
Corren en serie (`fileParallelism: false`) contra Atlas, por eso tardan ~30 s.

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

## Hitos

M0–M3 hechos (scaffold, auth, billetera, motor). Próximo: M4, sockets + lobby + salas + mesa mínima.
