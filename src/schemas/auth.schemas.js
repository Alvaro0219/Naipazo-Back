import Joi from 'joi';
import { USERNAME_MAX, USERNAME_MIN, USERNAME_REGEX, isReservedUsername } from '../utils/username.js';

const username = Joi.string().trim().min(USERNAME_MIN).max(USERNAME_MAX)
  .pattern(USERNAME_REGEX)
  .custom((value, helpers) => (isReservedUsername(value) ? helpers.error('username.reserved') : value))
  .label('El nombre de usuario')
  .messages({
    'string.pattern.base': 'El nombre de usuario solo puede tener letras, números, "_" y "."',
    'username.reserved': 'Ese nombre de usuario está reservado'
  });

const email = Joi.string().trim().lowercase().max(254)
  .email({ tlds: { allow: false } })
  .label('El email');

// bcrypt solo usa los primeros 72 bytes
const password = Joi.string().min(8).max(72).label('La contraseña');

const mustAccept = (message) => Joi.boolean().valid(true).required().messages({
  'any.only': message,
  'any.required': message
});

export const registerSchema = Joi.object({
  username: username.required(),
  email: email.required(),
  password: password.required(),
  acceptTerms: mustAccept('Tenés que aceptar los términos y condiciones'),
  confirmAdult: mustAccept('Tenés que declarar que sos mayor de 18 años')
});

// Tokens de un solo uso que llegan por email (64 caracteres hexadecimales)
const emailToken = Joi.string().trim().max(128).required().label('El enlace')
  .messages({ 'any.required': 'El enlace está incompleto' });

export const verifyEmailSchema = Joi.object({ token: emailToken });
export const forgotPasswordSchema = Joi.object({ email: email.required() });
export const resetPasswordSchema = Joi.object({ token: emailToken, password: password.required() });

export const loginSchema = Joi.object({
  identifier: Joi.string().trim().min(3).max(254).required().label('El email o nombre de usuario'),
  password: Joi.string().max(72).required().label('La contraseña')
});

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().required().label('El refresh token')
});

export const logoutSchema = Joi.object({
  refreshToken: Joi.string().allow('', null).label('El refresh token')
});

// No se valida el formato acá: el service responde { available: false, reason: 'INVALID' }
export const availabilitySchema = Joi.object({
  username: Joi.string().trim().max(254).label('El nombre de usuario'),
  email: Joi.string().trim().max(254).label('El email')
}).or('username', 'email');
