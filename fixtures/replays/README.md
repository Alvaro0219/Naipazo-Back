# Repeticiones de referencia

Partidas guardadas que el motor tiene que reproducir **exactamente** (EXACTITUD_DEL_JUEGO.md, 9.4). Las corre
`src/game/truco/__tests__/replays.test.js` en la suite rápida.

Cada archivo es un guion de la sección 11:

| Campo | Qué es |
|---|---|
| `rulesVersion` | Versión de reglas con la que se escribió. Si una regla cambia a propósito, se sube `RULES_VERSION` y se actualizan. |
| `modo`, `objetivo`, `marcador` | `1v1` (jugadores `A`, `B`) o `2v2` (`A1`, `B1`, `A2`, `B2`); puntos a los que se juega; marcador al empezar la mano. |
| `manos` | Las 3 cartas de cada asiento. El asiento 0 es el mano. |
| `acciones` | `[jugador, tipo, carta?]` en orden. `TIMEOUT` = se le venció el tiempo a ese jugador. |
| `esperado` | Resultado de la mano, marcador, fase, eventos (en orden, pueden tener otros en el medio), turno, quién responde, tantos que no se revelan, malas y buenas. |
| `revisado` | Quién lo revisó y cuándo. **Lo completan los jugadores expertos** al jugar el guion (sección 11). |

Los resultados esperados se escribieron desde las reglas de `docs/TRUCO_RULES.md`, no copiando la salida del motor.

Para agregar uno (por ejemplo, cada bug encontrado): un JSON nuevo con el mismo formato. El test lo toma solo.

## Guiones que se prueban fuera del motor

Necesitan sockets, reloj o base de datos, así que están en los tests de integración:

| Guion | Dónde |
|---|---|
| 12 (reloj real) | `src/services/__tests__/realtime.test.js` (7.4) y `roomMatch.test.js` |
| 13. Reconexión con un canto pendiente | `realtime.test.js` (7.6) |
| 20. Abandono en 2 vs 2 | `twoVsTwo.test.js` (R-ECO-04) |
| 21. Señas | `twoVsTwo.test.js` (R-VIS-03) |
| 22. Reconexión en 2 vs 2 | `twoVsTwo.test.js` y `realtime.test.js` (7.5) |
