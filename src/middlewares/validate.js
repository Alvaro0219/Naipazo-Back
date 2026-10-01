import { esMessages } from '../schemas/messages.js';

export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      messages: esMessages,
      errors: { wrap: { label: false } }
    });
    if (error) {
      const message = error.details.map(d => d.message).join('. ');
      return res.status(400).json({ success: false, error: { message, code: 'VALIDATION_ERROR' } });
    }
    req.validated = value; // el controller lee de req.validated, no de req.body directamente
    next();
  };
}
