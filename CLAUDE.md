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

## Hitos

M0–M2 hechos (scaffold, auth, billetera). Próximo: M3, motor de truco puro en `src/game/truco/`
(sin I/O, `crypto.randomInt` para barajar, nunca `Math.random`), con `docs/TRUCO_RULES.md` y un test por regla.
Las variantes de reglas que cambien el resultado de una partida se consultan al usuario.
