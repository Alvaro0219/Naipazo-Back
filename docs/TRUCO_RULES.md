# Reglas de truco implementadas

Variante del motor `src/game/truco/` (Fase 1). Cada regla tiene su test en `src/game/truco/__tests__/`;
la columna **Test** indica la suite. Las decisiones marcadas como **[elegida]** son variantes regionales
que confirmó el dueño del producto; las marcadas como **[estándar]** siguen la regla más difundida y no
cambiaron por consulta.

## Alcance

- 1 vs 1 en la UI. El motor ya trabaja con **equipos** (asientos alternados 0/1/0/1), así que 2 vs 2
  requiere solo UI y pruebas, no cambios de modelo.
- **Sin flor [elegida]**: por ahora no se implementa. `createMatchState` rechaza `withFlor: true`
  (`FLOR_NOT_SUPPORTED`) y las acciones `CALL_FLOR`/`CALL_CONTRAFLOR*` responden `UNKNOWN_ACTION`.
  Con tres cartas del mismo palo se canta envido normal (20 + las dos más altas).
- Partidas a 15 o 30 puntos.

## Cartas y reparto

| Regla | Test |
|---|---|
| Baraja española de 40 cartas (sin 8, 9 ni comodines). | cards |
| Jerarquía: 1♠ > 1 basto > 7♠ > 7 oro > 3 > 2 > 1 copa/oro > 12 > 11 > 10 > 7 copa/basto > 6 > 5 > 4. | cards |
| Mezcla Fisher-Yates con `crypto.randomInt`; nunca `Math.random`. El mazo barajado queda en `hand.deck` para el `MatchHandLog`. | cards |
| Se reparten 3 cartas de a una, empezando por el mano. El repartidor rota cada mano; el mano es el siguiente al repartidor. El primer repartidor lo sortea quien crea la partida. | engine |

## Bazas

| Regla | Test |
|---|---|
| Gana la baza la carta más alta; con cartas de igual valor de equipos distintos es **parda**. | engine |
| Gana la mano quien gane dos bazas (si gana las dos primeras no se juega la tercera). | engine, scoring |
| Parda en la 1.ª: define la 2.ª. Parda en la 2.ª: gana quien ganó la 1.ª. | scoring |
| Dos pardas: define la 3.ª. 1 a 1 y parda en la 3.ª: gana quien ganó la 1.ª **[estándar]**. | scoring |
| Tres pardas: gana el mano. | engine, scoring |
| Quien gana una baza abre la siguiente; con parda abre el mano. | engine |

## Turnos y cantos

- Solo actúa **el jugador del turno**, o, si hay un canto pendiente, **el rival que tiene que responder**.
  Quien cantó no puede jugar ni hacer nada hasta que le respondan.
- Los cantos se hacen en el propio turno, antes de tirar la carta. Después de la respuesta, el turno
  vuelve a quien tenía que jugar.

## Truco

| Regla | Test |
|---|---|
| Truco (2) → Retruco (3) → Vale cuatro (4). Se responde quiero, no quiero o subiendo al siguiente nivel. | engine |
| No quiero: quien cantó suma el nivel anterior (1, 2 o 3) y la mano termina. | engine |
| Subir implica querer el nivel anterior. | engine |
| Solo puede subir quien tiene **el quiero**: el equipo que aceptó el último nivel. El truco inicial lo canta cualquiera en su turno. | engine |
| La mano vale el nivel de truco querido (1 si no se cantó). | engine |

## Envido

| Regla | Test |
|---|---|
| Tantos: con dos o más cartas del mismo palo, 20 + las dos más altas; si no, la carta más alta. Las figuras valen 0. | envido |
| Solo durante la **primera baza**, una vez por mano. Cada jugador puede cantarlo en su turno antes de tirar su carta (el pie, después de que el mano jugó). | engine |
| No se puede cantar una vez **querido** el truco **[estándar]**. | engine |
| **El envido está primero**: si se canta truco en la primera baza, el que responde puede cantar envido; se resuelve el envido y después el truco vuelve a quedar pendiente con la misma respuesta. No aplica al retruco ni al vale cuatro. | engine |
| Secuencias: envido hasta dos veces, real envido una vez (después no se vuelve a envido), falta envido cierra la secuencia. | envido |
| Querido: suma de lo cantado (envido 2, real envido 3). Con falta envido en la secuencia, vale la falta (reemplaza lo anterior) **[estándar]**. | envido |
| No querido: quien cantó suma 1 si hubo un solo canto, o lo que valía lo cantado antes de la última subida. Ej.: envido-envido-real envido no querido = 4. | envido |
| Se resuelve automáticamente en el servidor. Empate: gana el mano. | engine |
| **Canto de los tantos [elegida]**: canta primero el mano. El pie solo revela sus tantos si lo supera; si no, dice "son buenas" y **sus tantos nunca se muestran** al rival. (En 2 vs 2 sigue el orden de asiento: solo canta quien supera al equipo que va ganando.) | engine, views |
| **Sin ayudas**: la proyección no incluye el cálculo de los propios tantos; cada jugador los cuenta él mismo. | views |

### Falta envido

| Regla | Test |
|---|---|
| A 15 puntos: lo que le falta al líder del marcador para llegar a 15. | scoring, engine |
| A 30 puntos, líder con menos de 15 (malas): lo que le falta para 15. | scoring, engine |
| A 30 puntos, líder con 15 o más: lo que le falta para 30. Con el líder en exactamente 15 (último punto de las malas) vale 15: ya completó las malas, así que cuenta hasta 30. | scoring (14, 15 y 16 puntos), engine |

## Ir al mazo

| Regla | Test |
|---|---|
| Se puede ir al mazo en el propio turno o al tener que responder un canto. | engine |
| El rival suma el valor del truco querido (1 si no se cantó o no se quiso). | engine |
| **[elegida]** En la primera baza, si el envido todavía se podía cantar (no se cantó y no se quiso truco), el rival suma **1 punto extra por el envido**. | engine |
| Irse al mazo con un envido pendiente equivale a no quererlo: primero cobra el envido quien lo cantó y después se cierra la mano. | engine |

## Fin de partida

| Regla | Test |
|---|---|
| Gana el primero en llegar a 15/30, **incluso a mitad de una mano** (por ejemplo, con un envido). El marcador no pasa del objetivo. | engine, simulation |
| A 30 puntos el marcador se muestra en malas (0–15) y buenas (16–30). **Con 15 justos se sigue en malas** **[elegida]**. Lo decide una sola función, `scoring.js#scoreSection` (constante `MALAS_LAST_POINT`); el front recibe `scoreSections` en el estado proyectado y no recalcula la frontera. | scoring (14, 15 y 16 puntos) |

## Tiempo y abandono (los dispara `matchService`)

| Regla | Test |
|---|---|
| Vence el tiempo con un canto pendiente: se toma como **no quiero**. | engine |
| Vence el tiempo cuando había que jugar: pierde la mano, el rival suma el valor del truco (sin el punto extra del envido, porque no es un mazo voluntario). | engine |
| Abandono: la partida termina a favor del otro equipo; el marcador no cambia (`endReason: 'abandon'`). | engine |

## Proyección por jugador

`projectStateFor(state, playerId)` es lo único que se envía a los clientes: incluye mis cartas, las
cartas jugadas, el marcador, los cantos, de quién es el turno y `availableActions`. Nunca incluye las
cartas no jugadas del rival, el mazo, las cartas repartidas originales ni el cálculo de tantos. De los
tantos solo se ven los que se cantaron en un envido querido. Verificado sobre partidas completas
simuladas (`views`).

## Pendiente / a decidir

- **Flor** (cuando se habilite): puntaje con dos flores (achicarse, contraflor, contraflor al resto) y
  si la flor no cantada se pierde al jugar la segunda carta.
- 2 vs 2: reglas confirmadas abajo (M8.1).

## 2 vs 2 (M8) — reglas confirmadas por el dueño (05/10/2026)

Todo lo que no se menciona acá funciona igual que en 1 vs 1, por equipo. El 1 vs 1 no cambia.

| Tema | Regla | Test |
|---|---|---|
| Equipos | Asientos 0 y 2 (equipo A) contra 1 y 3 (equipo B): compañeros enfrentados. | engine2v2 |
| Sentido | 0 → 1 → 2 → 3. En pantalla, cada jugador se ve abajo y el siguiente queda a su derecha (antihorario). | engine2v2 |
| Reparto y mano | Reparte un asiento que rota cada mano; es mano el siguiente al que reparte. 3 cartas a cada uno. | engine2v2 |
| Orden de la baza | Empieza el mano; en las siguientes, quien jugó la carta ganadora de la baza anterior. | engine2v2 |
| Ganador de la baza | Carta más alta. Empate entre equipos distintos: parda. Empate entre compañeros: gana ese equipo (y abre quien la jugó primero). | engine2v2 |
| Tras una parda | Empieza el mano y sigue la ronda antihoraria. | engine2v2 |
| Ganador de la mano | Mismas reglas de bazas y pardas que 1 vs 1, por equipo; tres pardas: gana el equipo del mano. | engine2v2 |
| **Quién responde un canto** | **Uno solo de los rivales: el más mano**, es decir, el rival que juega antes en el orden de la baza en curso. Ej.: orden A1, B1, A2, B2; si canta A2, responde B1. Vale para truco, retruco, vale cuatro y envido. Solo él ve "Quiero" y "No quiero" (y puede subir o irse al mazo). | engine2v2 |
| Truco | Lo canta cualquiera en su turno. "El quiero" es del equipo que aceptó: cualquiera de sus dos jugadores puede subir en su turno, y el que responde puede subir al responder. | engine2v2 |
| **Envido** | **Solo lo cantan los pies** (el último de cada pareja en la primera baza: el compañero del mano y el que reparte), en su turno de la primera baza, antes de jugar su carta. Lo responde el rival más mano, que puede subirlo. | engine2v2 |
| El envido está primero | Si en la primera baza cantan truco, **quien lo responde puede anteponer el envido aunque no sea pie**. | engine2v2 |
| Canto de tantos | Desde el mano en el sentido del juego: el primero canta; los siguientes pasan si su equipo ya gana, cantan si superan estrictamente al mejor revelado, o dicen "son buenas". Gana el equipo que va ganando al final (el empate lo gana quien cantó antes). Los tantos no revelados no se envían a nadie, **ni al compañero**. | engine2v2, views |
| Ir al mazo | El mazo es del equipo: si uno se va, su equipo pierde la mano (mismas sumas que en 1 vs 1). Puede irse quien está en turno o quien debe responder un canto. | engine2v2 |
| Tiempo | Turno por jugador (20 s). Canto pendiente: el reloj corre para el rival que debe responder; si vence, "no quiero". | engine2v2 |
| Flor | No existe. | — |
