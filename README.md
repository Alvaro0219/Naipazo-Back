# truco-back

Backend de **Truco Online** (Fase 1, fichas virtuales). Node.js ESM + Express 4 + Mongoose 8 + JWT.
Sigue la arquitectura de la skill `fullstack-scaffold` (`routes → controllers → services → models`,
respuestas `ok()/fail()`, `asyncHandler`, `AppError`, validación Joi con `validate(schema)`).

> Las fichas son virtuales, no tienen valor monetario y no son canjeables. No hay depósitos, retiros
> ni pagos de ningún tipo.

## Requisitos

- Node.js 20 o superior.
- MongoDB **con replica set** (las operaciones de fichas usan transacciones). Un cluster gratuito
  M0 de MongoDB Atlas sirve tanto para desarrollo como para producción.

## Puesta en marcha

```bash
npm install
cp .env.example .env    # completar MONGO_URL, JWT_SECRET y REFRESH_SECRET
npm run dev             # http://localhost:4000 (se reinicia al guardar)
```

Verificación rápida: `GET http://localhost:4000/health` → `{"ok":true}`.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Arranca la API con `node --watch`. |
| `npm start` | Arranque de producción (`NODE_ENV=production`). |
| `npm test` | Corre los tests con Vitest. |

### Tests

- Los tests unitarios (fechas, schemas) corren siempre.
- Los tests de integración de `walletService` y `authService` (concurrencia del crédito diario,
  registros simultáneos, saldo = suma del ledger) necesitan un MongoDB con replica set. Se activan
  definiendo `MONGO_URL_TEST` en `.env`. **Esa base se borra en cada test**: usá una base distinta
  a la de desarrollo (por ejemplo `.../truco_test` en el mismo cluster de Atlas).

## Variables de entorno

Ver `.env.example`. Todas se leen y validan en `src/config/env.js`; en producción el proceso
termina si falta alguna obligatoria. `CORS_ORIGINS` aplica a Express y (desde M4) a Socket.IO.

## API (hasta M2)

| Método y ruta | Descripción |
|---|---|
| `POST /api/auth/register` | `username`, `email`, `password`, `acceptTerms`, `confirmAdult`. 409 `EMAIL_TAKEN` / `USERNAME_TAKEN`. |
| `POST /api/auth/login` | `identifier` (email o usuario) + `password`. Error genérico `INVALID_CREDENTIALS`. |
| `POST /api/auth/refresh` | `refreshToken` → nuevo par de tokens (rotación). |
| `POST /api/auth/logout` | `refreshToken` → invalida todos los refresh tokens del usuario. |
| `GET /api/auth/me` | Usuario actual. |
| `GET /api/auth/availability` | `?username=&email=` → disponibilidad en vivo para el registro. |
| `GET /api/wallet` | Saldo + `dailyGrant { granted, amount, nextGrantAt }`. Dispara el crédito diario. |
| `GET /api/wallet/ledger` | Movimientos paginados (`?page=1&limit=20`). |

Login, registro y refresh devuelven `{ user, accessToken, refreshToken, dailyGrant }`.

### Salas (M4)

| Método y ruta | Descripción |
|---|---|
| `GET /api/rooms` | Salas en espera, paginadas. Filtros `targetPoints`, `minBet`, `maxBet`. |
| `GET /api/rooms/mine` | Sala en espera o en juego del usuario (o `null`). |
| `POST /api/rooms` | `{ uuid, targetPoints: 15\|30, bet }`. Idempotente por `uuid`. Por ahora solo `bet: 0` (`BETS_NOT_AVAILABLE`). |
| `POST /api/rooms/:id/join` | Ocupa el asiento y arranca la partida (transacción). |
| `DELETE /api/rooms/:id` | Cancela una sala propia en espera. |

Un usuario puede estar en una sola sala activa a la vez (`ALREADY_IN_ROOM`).

### Socket.IO

El cliente se conecta con `auth: { token: <accessToken> }` (mismo `CORS_ORIGINS` que Express).

| Cliente → servidor | Servidor → cliente |
|---|---|
| `lobby:subscribe` / `lobby:unsubscribe` | `lobby:rooms` (lista completa de salas en espera) |
| `room:join { roomId }` — entrar o volver a la mesa | `room:update`, `game:state` (proyectado por jugador) |
| `room:leave { roomId }` — cancelar la propia sala en espera | `game:event` (cartas jugadas, cantos, resultados) |
| `game:action { matchId, actionId, type, payload }` | `game:error { code, message }`, `game:finished` |
| | `player:disconnected` / `player:reconnected`, `wallet:update` |

Una sola conexión de juego por jugador: si abre la mesa en otra pestaña, la anterior recibe
`game:error SESSION_REPLACED`.

**Reinicio del servidor:** las partidas en juego viven en memoria; al arrancar, las que quedaron
`playing` se **cancelan** (y desde M5 se reembolsan sus apuestas).

## Fichas: decisiones de diseño

- **`walletService` es el único punto que modifica `User.balance`.** Cada movimiento corre en una
  transacción: `$inc` atómico condicionado + `LedgerEntry` con `idempotencyKey` única.
- **El ledger es inmutable** (hooks de Mongoose rechazan updates y deletes). El saldo del usuario es
  una proyección que siempre coincide con la suma de sus asientos.
- **Crédito diario perezoso**: se acredita al hacer login, refresh, `GET /wallet` y (desde M4) al
  conectar el socket. Día calendario en `APP_TIMEZONE`; no se acumulan días sin entrar.
- **Logout** incrementa `tokenVersion` y con eso invalida todos los refresh tokens del usuario
  (en todos sus dispositivos). Los access tokens siguen siendo válidos hasta que expiran.

## Motor de truco

`src/game/truco/` es un motor puro (sin base de datos, sockets ni reloj) que recibe estado + acción y
devuelve el nuevo estado + eventos, o lanza un `RuleError`. Las reglas y variantes implementadas están en
[docs/TRUCO_RULES.md](docs/TRUCO_RULES.md). En esta fase se juega **sin flor**.

## Despliegue y escalado

Se despliega en Railway según `deployment-guide.md` de la skill. **Tiene que correr una sola
instancia**: a partir de M4 las partidas activas viven en memoria. Escalar a varias instancias
requeriría `@socket.io/redis-adapter` y mover el estado de las partidas a Redis (fuera de alcance
en la Fase 1).
