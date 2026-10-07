/**
 * Comisión de la casa en ENTEROS (R-ECO-06, P4 de EXACTITUD_DEL_JUEGO.md). HOUSE_RATE se convierte a puntos básicos
 * (1 % = 100) y la comisión se redondea hacia abajo; así no hay errores de coma flotante (100 × 0,29 = 28,999…).
 */
export function houseFee(pot, houseRate) {
  const bps = Math.round(houseRate * 10000);
  return Math.floor((pot * bps) / 10000);
}
