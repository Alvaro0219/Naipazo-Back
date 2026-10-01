/** Acción ilegal según las reglas. El motor nunca modifica el estado cuando lanza. */
export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}
