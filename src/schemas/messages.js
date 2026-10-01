// Mensajes de Joi en español (voseo), usados por middlewares/validate.js.
// Los schemas usan .label('...') para que el campo se lea natural en el mensaje.
export const esMessages = {
  'any.required': '{{#label}} es obligatorio',
  'any.only': '{{#label}} no tiene un valor permitido',
  'any.invalid': '{{#label}} no es válido',
  'string.base': '{{#label}} debe ser un texto',
  'string.empty': '{{#label}} es obligatorio',
  'string.min': '{{#label}} debe tener al menos {{#limit}} caracteres',
  'string.max': '{{#label}} puede tener como máximo {{#limit}} caracteres',
  'string.email': '{{#label}} no es un email válido',
  'string.pattern.base': '{{#label}} tiene un formato inválido',
  'string.guid': '{{#label}} no es un identificador válido',
  'string.hex': '{{#label}} no es un identificador válido',
  'string.length': '{{#label}} no es un identificador válido',
  'number.base': '{{#label}} debe ser un número',
  'number.integer': '{{#label}} debe ser un número entero',
  'number.min': '{{#label}} debe ser como mínimo {{#limit}}',
  'number.max': '{{#label}} debe ser como máximo {{#limit}}',
  'boolean.base': '{{#label}} debe ser verdadero o falso',
  'object.unknown': '{{#label}} no está permitido',
  'object.missing': 'Completá al menos uno de los campos: {{#peersWithLabels}}'
};
