import { describe, expect, it } from 'vitest';
import { availabilitySchema, loginSchema, registerSchema } from '../auth.schemas.js';
import { esMessages } from '../messages.js';

const opts = { abortEarly: false, stripUnknown: true, messages: esMessages, errors: { wrap: { label: false } } };

const validRegister = {
  username: 'Juan_Perez.10',
  email: '  Juan@Example.COM ',
  password: 'secreta123',
  acceptTerms: true,
  confirmAdult: true
};

describe('registerSchema', () => {
  it('acepta un registro válido y normaliza el email', () => {
    const { error, value } = registerSchema.validate(validRegister, opts);
    expect(error).toBeUndefined();
    expect(value.email).toBe('juan@example.com');
    expect(value.username).toBe('Juan_Perez.10'); // se conserva tal cual
  });

  it.each([
    ['muy corto', 'ab'],
    ['muy largo', 'a'.repeat(21)],
    ['con espacios', 'juan perez'],
    ['con guion', 'juan-perez'],
    ['con acentos', 'joaquín']
  ])('rechaza nombre de usuario %s', (_, username) => {
    const { error } = registerSchema.validate({ ...validRegister, username }, opts);
    expect(error).toBeDefined();
  });

  it.each(['admin', 'Admin', 'ADMIN_2', 'soporte', 'Soporte.ar', 'moderador'])(
    'rechaza el nombre reservado %s',
    (username) => {
      const { error } = registerSchema.validate({ ...validRegister, username }, opts);
      expect(error?.message).toMatch(/reservado/);
    }
  );

  it('exige contraseña de al menos 8 caracteres', () => {
    const { error } = registerSchema.validate({ ...validRegister, password: '1234567' }, opts);
    expect(error?.message).toMatch(/al menos 8/);
  });

  it('exige aceptar términos y declarar mayoría de edad', () => {
    const { error } = registerSchema.validate({ ...validRegister, acceptTerms: false, confirmAdult: undefined }, opts);
    expect(error?.message).toMatch(/términos/);
    expect(error?.message).toMatch(/mayor de 18/);
  });

  it('rechaza emails inválidos', () => {
    const { error } = registerSchema.validate({ ...validRegister, email: 'no-es-email' }, opts);
    expect(error?.message).toMatch(/email/);
  });
});

describe('loginSchema', () => {
  it('acepta email o nombre de usuario', () => {
    expect(loginSchema.validate({ identifier: 'juan', password: 'x' }, opts).error).toBeUndefined();
    expect(loginSchema.validate({ identifier: 'a@b.com', password: 'x' }, opts).error).toBeUndefined();
  });
});

describe('availabilitySchema', () => {
  it('requiere al menos un campo', () => {
    expect(availabilitySchema.validate({}, opts).error).toBeDefined();
    expect(availabilitySchema.validate({ username: 'x' }, opts).error).toBeUndefined();
  });
});
