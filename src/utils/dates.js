// Helpers de fecha en una zona horaria IANA, sin dependencias externas.
// Las "claves de día" son strings YYYY-MM-DD, comparables lexicográficamente.

/** Día calendario (YYYY-MM-DD) de `date` en la zona `timeZone`. */
export function dateKeyInTz(date, timeZone) {
  // en-CA formatea como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/** Diferencia (ms) entre la hora local de `timeZone` y UTC en el instante `date`. */
function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const get = (type) => Number(parts.find(p => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/** Suma `days` días a una clave YYYY-MM-DD. */
export function addDaysToKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Instante UTC en que empieza el día `dateKey` (00:00) en la zona `timeZone`. */
export function startOfDayInTz(dateKey, timeZone) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  // Segunda pasada por si el offset cambia en ese día (horario de verano)
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Instante en que empieza el día siguiente a `date` en la zona `timeZone`. */
export function nextDayStartInTz(date, timeZone) {
  return startOfDayInTz(addDaysToKey(dateKeyInTz(date, timeZone), 1), timeZone);
}
