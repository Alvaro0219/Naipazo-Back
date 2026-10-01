export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const USERNAME_REGEX = /^[A-Za-z0-9_.]+$/;

// Nombres que podrían usarse para suplantar al staff. Se comparan en minúsculas.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrador', 'administrator', 'root', 'sistema', 'system',
  'soporte', 'support', 'ayuda', 'help', 'staff', 'moderador', 'moderator', 'mod',
  'truco', 'trucoonline', 'oficial', 'official', 'banca', 'casa', 'null', 'undefined'
]);

export function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

export function isReservedUsername(username) {
  const lower = normalizeUsername(username);
  return RESERVED_USERNAMES.has(lower) || lower.startsWith('admin') || lower.startsWith('soporte');
}

export function isValidUsernameFormat(username) {
  const value = String(username || '').trim();
  return value.length >= USERNAME_MIN && value.length <= USERNAME_MAX && USERNAME_REGEX.test(value);
}
