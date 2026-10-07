# Reglas de truco de Naipazo

**Fuente única de las reglas** del motor (`src/game/truco/`). Cada regla tiene un identificador `R-…`; **cada test que
la verifica lleva el identificador en su nombre** y `npm run rules:trace` falla si algún identificador de este
documento no tiene al menos un test (trazabilidad, ver `EXACTITUD_DEL_JUEGO.md`).

- **Versión de reglas: 1** (`RULES_VERSION` en `src/game/truco/rules.js`). Cada partida la guarda en
  `Match.rulesVersion`; si una regla cambia a propósito, se sube la versión y se documenta acá.
- **[elegida]**: variante regional confirmada por el dueño. **[estándar]**: la regla más difundida.
- Sin flor **[elegida]**: `createMatchState` rechaza `withFlor: true` (`FLOR_NOT_SUPPORTED`). Con tres cartas del mismo
  palo se canta envido normal. Partidas a 15 o 30 puntos. Modos 1 vs 1 y 2 vs 2.

## Decisiones cerradas por el dueño

| # | Tema | Decisión |
|---|---|---|
| D-1 | Frontera malas/buenas (a 30) | Malas 0–15, buenas 16–30: **con 15 justos se sigue en malas**. |
| D-2 | Tiempo de turno | **20 s** por decisión (`TURN_TIMEOUT_SECONDS`). Sin banco de tiempo. |
| D-3 | Turno vencido al tener que jugar | **Pierde la mano**: el rival suma lo que valía la mano (1, o el truco querido), **sin** el punto extra del envido del mazo. |
| D-4 | Quién abre tras una parda | **El mano** (1 vs 1 y 2 vs 2). |
| D-5 | 2 vs 2 | Sentido 0→1→2→3 (antihorario en pantalla); el envido lo cantan **solo los pies**; el mazo es **de la pareja**; cada canto lo responde **un solo rival, el más mano**. |
| D-6 | Combinaciones de envido | Las de la tabla de `R-ENV-02` y ninguna otra: envido hasta dos veces, real envido una sola vez y nunca seguido de envido, falta envido cierra la secuencia. |
| D-7 | Momentos del envido | Solo en la primera baza y una vez por mano; en 1 vs 1 cada uno en su turno antes de tirar su carta; en 2 vs 2 solo los pies en su turno; "el envido está primero" ante un truco no querido (no ante retruco ni vale cuatro); **nunca** después de querido el truco. |
| D-8 | Puntaje que supera el objetivo | Se **topea** al objetivo (no se guarda el real). |
| D-9 | Abandono en 2 vs 2 | **Pierden los dos** de la pareja; cada rival cobra 2 apuestas. |
| D-10 | Resto de una división con comisión | **Queda en la casa** (se registra como comisión). Nunca se crean ni se pierden fichas. |

## Cartas y mazo

| Id | Regla | Tests |
|---|---|---|
| R-MAZO-01 | El mazo tiene 40 cartas distintas: espada, basto, oro y copa × 1–7, 10, 11, 12. Sin 8, 9 ni comodines. | cards, oracle |
| R-MAZO-02 | Se baraja una vez por mano con Fisher-Yates y `crypto.randomInt` (nunca `Math.random`); cada mano usa un barajado nuevo. | cards, shuffle |
| R-MAZO-03 | El orden del mazo y las cartas repartidas nunca salen del servidor. | views, properties |
| R-CARTA-01 | Jerarquía para el truco, de mayor a menor: 1♠ > 1 basto > 7♠ > 7 oro > los 3 > los 2 > 1 copa y 1 oro > los 12 > los 11 > los 10 > 7 copa y 7 basto > los 6 > los 5 > los 4. | oracle |
| R-CARTA-02 | Cartas de la misma posición empatan. | oracle |

## Reparto y mano

| Id | Regla | Tests |
|---|---|---|
| R-REP-01 | Cada jugador recibe 3 cartas, de a una, empezando por el mano: 6 en 1 vs 1 y 12 en 2 vs 2, sin repetir. | rules |
| R-REP-02 | Quien reparte rota cada mano; es **mano** el siguiente al que reparte en el sentido del juego. | rules |
| R-REP-03 | En la primera mano, quien reparte se elige al azar con `crypto.randomInt` (`matchService`). | rules |

## Turnos y bazas

| Id | Regla | Tests |
|---|---|---|
| R-TURNO-01 | En cada momento hay **exactamente un** jugador que puede actuar: el que debe jugar o el que debe responder un canto. Cualquier acción de otro se rechaza. | rules, properties |
| R-TURNO-02 | La primera baza la abre el mano; las siguientes, quien jugó la carta ganadora de la anterior; tras una parda, el mano (D-4). | rules |
| R-TURNO-03 | Con un canto pendiente nadie puede jugar cartas; quien cantó no puede hacer nada hasta que le respondan. Resuelto el canto, el turno vuelve a quien tenía que jugar. | rules, matrix |
| R-BAZA-01 | Gana la baza la carta más alta según `R-CARTA-01`. | oracle |
| R-BAZA-02 | Si las cartas más altas son de equipos distintos y empatan: **parda**. | oracle |
| R-BAZA-03 | (2 vs 2) Si las más altas empatadas son de compañeros, gana su equipo (no es parda) y abre la siguiente quien la jugó primero. | oracle, rules |

## Ganador de la mano

| Id | Regla | Tests |
|---|---|---|
| R-MANO-01 | Gana quien gana dos bazas. Parda en la 1.ª: define la 2.ª (si es parda, la 3.ª). Parda en la 2.ª o en la 3.ª: gana quien ganó la 1.ª. Tres pardas: gana el equipo del mano. | oracle |
| R-MANO-02 | La mano se resuelve **en cuanto el resultado queda determinado**: no se juegan bazas innecesarias. | oracle, rules |

| Baza 1 | Baza 2 | Baza 3 | Gana |
|---|---|---|---|
| A | A | — | A |
| A | B | A | A |
| A | B | B | B |
| A | B | P | A |
| A | P | — | A |
| P | A | — | A |
| P | P | A | A |
| P | P | P | equipo del mano |

## Truco

| Canto | Querido, la mano vale | No querido, suma quien cantó |
|---|---|---|
| Sin canto | 1 | — |
| Truco | 2 | 1 |
| Retruco | 3 | 2 |
| Vale cuatro | 4 | 3 |

| Id | Regla | Tests |
|---|---|---|
| R-TRUCO-01 | Los niveles suben de a uno: truco → retruco → vale cuatro. | oracle, matrix |
| R-TRUCO-02 | Solo sube el equipo que tiene "el quiero" (el que aceptó el último nivel). El truco inicial lo canta cualquiera. | rules, matrix |
| R-TRUCO-03 | Se canta en el propio turno antes de tirar la carta, o subiendo al responder. Subir implica querer el nivel anterior. | rules, matrix |
| R-TRUCO-04 | Lo responde **un solo rival, el más mano** de la baza en curso (en 1 vs 1, el único rival). Nadie más puede responder (D-5). | rules |
| R-TRUCO-05 | "No quiero" termina la mano en el acto con los puntos de la tabla. Querido, la mano vale el nivel de la tabla. | oracle |

## Envido

| Id | Regla | Tests |
|---|---|---|
| R-ENV-01 | Tantos: cada carta vale su número (1 a 7); 10, 11 y 12 valen 0. Con dos o más del mismo palo: las dos de mayor valor + 20; si no, la de mayor valor. Rango 0 a 33. | oracle (las 9.880 manos) |
| R-ENV-02 | Combinaciones permitidas y sus puntos: la tabla de abajo, y ninguna otra (D-6). | oracle, matrix |
| R-ENV-03 | Momentos: solo en la primera baza y una vez por mano; 1 vs 1 cada uno en su turno antes de tirar su carta; 2 vs 2 solo los pies en su turno; nunca después de querido el truco (D-7). | rules, matrix |
| R-ENV-04 | Falta envido: lo que le falta al líder para 15 (a 15); a 30, hasta 15 si está en malas por debajo de 15, y hasta 30 con 15 justos o en buenas. Una sola función (`faltaEnvidoPoints`). | oracle (todos los marcadores) |
| R-ENV-05 | Canto de tantos (1 vs 1): canta primero el mano; el otro solo revela si tiene **estrictamente más**; si no, "son buenas" y sus tantos no se envían a nadie. Empate: gana el mano. | rules, oracle |
| R-ENV-06 | Canto de tantos (2 vs 2): desde el mano en el sentido del juego; cada uno revela solo si supera estrictamente al mejor revelado del otro equipo; los demás "son buenas" o pasan. Los no revelados no se envían a nadie, tampoco al compañero. | rules, oracle |
| R-ENV-07 | Los puntos del envido se suman en cuanto se resuelve, antes de seguir con la mano (y pueden terminar la partida). | rules |
| R-ENV-08 | "El envido está primero": quien responde un truco no querido puede cantar envido; resuelto el envido, el truco vuelve a quedar pendiente para el mismo que respondía. | rules, matrix |
| R-ENV-09 | El envido lo responde un solo rival, el más mano (puede subirlo). | rules |
| R-ENV-10 | Sin ayudas: la proyección no incluye el cálculo de los tantos propios. | rules |

| Secuencia | Querido | No querido |
|---|---|---|
| Envido | 2 | 1 |
| Envido, envido | 4 | 2 |
| Real envido | 3 | 1 |
| Envido, real envido | 5 | 2 |
| Envido, envido, real envido | 7 | 4 |
| Falta envido | Falta | 1 |
| Envido, falta envido | Falta | 2 |
| Envido, envido, falta envido | Falta | 4 |
| Real envido, falta envido | Falta | 3 |
| Envido, real envido, falta envido | Falta | 5 |
| Envido, envido, real envido, falta envido | Falta | 7 |

## Mazo, tiempo y abandono

| Id | Regla | Tests |
|---|---|---|
| R-MAZO-IR-01 | Irse al mazo: el rival suma lo que valía la mano (1, o el truco querido) y, en la primera baza con el envido todavía posible, 1 punto más **[elegida]**. | oracle, rules |
| R-MAZO-IR-02 | Se puede ir al mazo en el propio turno o al tener que responder un canto. Con un envido pendiente equivale a no quererlo: primero cobra el envido quien lo cantó. | rules, matrix |
| R-MAZO-IR-03 | (2 vs 2) El mazo es de la pareja: si uno se va, su equipo pierde la mano. | rules |
| R-TIEMPO-01 | Turno vencido al tener que jugar: pierde la mano, sin el punto extra del envido (D-3). | rules |
| R-TIEMPO-02 | Canto pendiente vencido: "no quiero" del que debía responder. | rules |
| R-TIEMPO-03 | El reloj es del servidor y es de la decisión: entrar o volver a la mesa no lo reinicia; si quien debe actuar está desconectado, se pausa y retoma con lo que quedaba. | realtime |
| R-ABAND-01 | Gracia de reconexión de 60 s; vencida (o si nunca entra a la mesa), abandona. | realtime |
| R-ABAND-02 | (2 vs 2) Tope de 120 s de pausa acumulada por desconexión por jugador; superado, abandona. | realtime |
| R-ABAND-03 | Abandono: gana el otro equipo y el marcador no cambia (`endReason: 'abandon'`). | rules |

## Puntos y fin de partida

| Id | Regla | Tests |
|---|---|---|
| R-PUNT-01 | Los puntos de un equipo nunca bajan y son enteros. | properties |
| R-PUNT-02 | Solo suman puntos el envido, la mano (truco o sin cantos), el mazo y los vencimientos. | properties |
| R-PUNT-03 | Malas y buenas (a 30): una sola función, `scoreSection` (D-1); el front recibe `scoreSections` y no recalcula. | oracle |
| R-FIN-01 | La partida termina en el instante en que un equipo llega al objetivo, aunque sea a mitad de mano; después no se acepta ninguna acción. | rules, properties |
| R-FIN-02 | Hay exactamente un ganador. | properties |
| R-FIN-03 | El puntaje se topea al objetivo (D-8). | rules |

## Visibilidad

| Id | Regla | Tests |
|---|---|---|
| R-VIS-01 | Ningún mensaje a un cliente contiene una carta no jugada de otro jugador (incluido el compañero en 2 vs 2), ni con la partida terminada. | properties, realtime |
| R-VIS-02 | Ningún mensaje contiene tantos no revelados. | properties |
| R-VIS-03 | Ninguna seña llega a un rival. | realtime |
| R-VIS-04 | Los mensajes de una partida nunca llegan a jugadores de otra. | realtime |

## Fichas

| Id | Regla | Tests |
|---|---|---|
| R-ECO-01 | Crédito diario: una sola vez por día calendario en `America/Argentina/Buenos_Aires`, aunque se pida en paralelo; requiere email verificado si así se configura. | economy |
| R-ECO-02 | Inicio con apuesta: todas las apuestas se bloquean en una sola transacción; si a uno no le alcanza, no se bloquea ninguna. | economy |
| R-ECO-03 | Fin normal: 1 vs 1, el ganador cobra el pozo; 2 vs 2, cada ganador cobra 2 apuestas. | economy |
| R-ECO-04 | Abandono: 1 vs 1, el rival cobra el pozo; 2 vs 2, pierden los dos de la pareja (D-9). | economy |
| R-ECO-05 | Cancelación (reinicio del servidor, partida congelada por una verificación): devolución total a todos. | economy |
| R-ECO-06 | Comisión: se redondea hacia abajo y el resto de dividir entre ganadores queda en la casa (D-10). Lo bloqueado = lo pagado + lo devuelto + la comisión. | economy |
| R-ECO-07 | Torneos: inscripción al anotarse, devolución si sale antes del sorteo o si vence, premio único al campeón. | economy |
| R-ECO-08 | Revancha: apuestas nuevas bloqueadas como una partida nueva; si a alguno no le alcanza, no arranca. | economy |
| R-ECO-09 | Saldo entero y nunca negativo; saldo = suma del ledger; cada clave de idempotencia una sola vez; cada partida se liquida una sola vez. | economy |

## Matriz de cantos

La matriz completa "estado de la mano × acción → permitida o no" se genera desde
`src/game/truco/__tests__/matrix.js` con `npm run rules:matrix` y se testea celda por celda (`matrix.test.js`).

<!-- MATRIZ:INICIO -->

Generada automáticamente: no editar a mano. En cada estado, **solo** el jugador indicado puede actuar y solo con esas
acciones; cualquier otra acción de cualquier jugador se rechaza (lo verifica `matrix.test.js`, celda por celda).

| Celda | Modo | Estado | Quién puede actuar y con qué |
|---|---|---|---|
| M1 | 1 vs 1 | 1.ª baza, nadie jugó (turno del mano) | **mano**: jugar carta, truco, envido, real envido, falta envido, mazo |
| M2 | 1 vs 1 | 1.ª baza, ya jugó el mano (turno del pie) | **pie**: jugar carta, truco, envido, real envido, falta envido, mazo |
| M3 | 1 vs 1 | Truco cantado, pendiente, envido todavía posible | **pie**: quiero, no quiero, retruco, envido, real envido, falta envido, mazo |
| M4 | 1 vs 1 | Truco querido (el quiero es del pie); turno del mano | **mano**: jugar carta, mazo |
| M5 | 1 vs 1 | Truco querido (el quiero es del pie); turno del pie | **pie**: jugar carta, retruco, mazo |
| M6 | 1 vs 1 | Retruco pendiente | **mano**: quiero, no quiero, vale cuatro, mazo |
| M7 | 1 vs 1 | Retruco querido (el quiero es del mano); turno del mano | **mano**: jugar carta, vale cuatro, mazo |
| M8 | 1 vs 1 | Vale cuatro pendiente | **pie**: quiero, no quiero, mazo |
| M9 | 1 vs 1 | Vale cuatro querido; turno del mano | **mano**: jugar carta, mazo |
| M10 | 1 vs 1 | Envido pendiente | **pie**: quiero, no quiero, envido, real envido, falta envido, mazo |
| M11 | 1 vs 1 | Envido, envido pendiente | **mano**: quiero, no quiero, real envido, falta envido, mazo |
| M12 | 1 vs 1 | Real envido pendiente | **pie**: quiero, no quiero, falta envido, mazo |
| M13 | 1 vs 1 | Envido, envido, real envido pendiente | **pie**: quiero, no quiero, falta envido, mazo |
| M14 | 1 vs 1 | Falta envido pendiente | **pie**: quiero, no quiero, mazo |
| M15 | 1 vs 1 | Envido resuelto; turno del mano en la 1.ª baza | **mano**: jugar carta, truco, mazo |
| M16 | 1 vs 1 | "El envido está primero": el pie respondió el truco con envido | **mano**: quiero, no quiero, envido, real envido, falta envido, mazo |
| M17 | 1 vs 1 | Resuelto ese envido, el truco vuelve a estar pendiente para el pie | **pie**: quiero, no quiero, retruco, mazo |
| M18 | 1 vs 1 | Truco querido en la 1.ª baza: ya no hay envido | **pie**: jugar carta, mazo |
| M19 | 1 vs 1 | 2.ª baza, turno del que ganó la 1.ª | **mano**: jugar carta, truco, mazo |
| M20 | 1 vs 1 | 2.ª baza, truco cantado: no se puede anteponer el envido | **pie**: quiero, no quiero, retruco, mazo |
| M21 | 2 vs 2 | 1.ª baza, nadie jugó (turno del mano, que no es pie) | **A1 (mano)**: jugar carta, truco, mazo |
| M22 | 2 vs 2 | 1.ª baza, jugó el mano (turno del rival, que no es pie) | **B1**: jugar carta, truco, mazo |
| M23 | 2 vs 2 | 1.ª baza, turno del pie del equipo mano | **A2 (pie de A)**: jugar carta, truco, envido, real envido, falta envido, mazo |
| M24 | 2 vs 2 | 1.ª baza, jugaron todos menos uno (turno del otro pie) | **B2 (pie de B, reparte)**: jugar carta, truco, envido, real envido, falta envido, mazo |
| M25 | 2 vs 2 | Truco del pie A2: responde solo el rival más mano (B1); su compañero no | **B1**: quiero, no quiero, retruco, envido, real envido, falta envido, mazo |
| M26 | 2 vs 2 | Envido del pie A2: responde solo B1 | **B1**: quiero, no quiero, envido, real envido, falta envido, mazo |
| M27 | 2 vs 2 | Truco del mano A1 antes de jugar: responde B1, que no es pie pero puede anteponer el envido | **B1**: quiero, no quiero, retruco, envido, real envido, falta envido, mazo |
| M28 | 2 vs 2 | Truco querido por B; turno de A1: puede jugar o irse, no subir (el quiero es de B) | **A1 (mano)**: jugar carta, mazo |

<!-- MATRIZ:FIN -->

## Pendiente (fuera del alcance actual)

- **Flor** (cuando se habilite): puntaje con dos flores y si la flor no cantada se pierde al jugar la segunda carta.
