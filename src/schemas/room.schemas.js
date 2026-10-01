import Joi from 'joi';
import { env } from '../config/env.js';

export const objectId = Joi.string().hex().length(24);

export const createRoomSchema = Joi.object({
  uuid: Joi.string().guid({ version: ['uuidv4'] }).required().label('El identificador de la sala'),
  targetPoints: Joi.number().valid(15, 30).required().label('Los puntos de la partida')
    .messages({ 'any.only': 'La partida tiene que ser a 15 o 30 puntos' }),
  bet: Joi.number().integer().min(0).max(env.maxBet).default(0).label('La apuesta')
    .custom((value, helpers) => (value > 0 && value < env.minBet ? helpers.error('bet.min') : value))
    .messages({ 'bet.min': `La apuesta mínima es de ${env.minBet} fichas` })
});

export const roomIdParamsSchema = Joi.object({
  id: objectId.required().label('La sala')
});

export const listRoomsQuerySchema = Joi.object({
  targetPoints: Joi.number().valid(15, 30),
  minBet: Joi.number().integer().min(0),
  maxBet: Joi.number().integer().min(0),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100)
});
