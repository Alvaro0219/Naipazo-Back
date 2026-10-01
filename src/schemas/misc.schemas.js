import Joi from 'joi';
import { objectId } from './room.schemas.js';

export const idParamsSchema = Joi.object({
  id: objectId.required().label('El identificador')
});

export const rankingQuerySchema = Joi.object({
  by: Joi.string().valid('won', 'chips').default('won'),
  period: Joi.string().valid('all', 'month', 'week').default('all'),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100)
});

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().max(72).required().label('La contraseña actual'),
  newPassword: Joi.string().min(8).max(72).required().label('La contraseña nueva')
});

export const adminUsersQuerySchema = Joi.object({
  search: Joi.string().trim().max(100).allow(''),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100)
});

export const setUserStatusSchema = Joi.object({
  isActive: Joi.boolean().required().label('El estado')
});

export const adjustChipsSchema = Joi.object({
  amount: Joi.number().integer().invalid(0).min(-1000000).max(1000000).required().label('El monto')
    .messages({ 'any.invalid': 'El monto no puede ser cero' }),
  reason: Joi.string().trim().min(3).max(200).required().label('El motivo'),
  operationId: Joi.string().guid().required().label('El identificador de la operación')
});
