import Joi from 'joi';
import { env } from '../config/env.js';
import { objectId } from './room.schemas.js';

export const createTournamentSchema = Joi.object({
  uuid: Joi.string().guid({ version: ['uuidv4'] }).required().label('El identificador del torneo'),
  size: Joi.number().valid(4, 8).required().label('La cantidad de jugadores')
    .messages({ 'any.only': 'El torneo tiene que ser de 4 u 8 jugadores' }),
  buyIn: Joi.number().integer().min(0).max(env.maxBet).default(0).label('La inscripción')
    .custom((value, helpers) => (value > 0 && value < env.minBet ? helpers.error('buyIn.min') : value))
    .messages({ 'buyIn.min': `La inscripción mínima es de ${env.minBet} fichas` }),
  targetPoints: Joi.number().valid(15, 30).required().label('Los puntos de cada partida')
    .messages({ 'any.only': 'Las partidas tienen que ser a 15 o 30 puntos' })
});

export const tournamentIdParamsSchema = Joi.object({
  id: objectId.required().label('El torneo')
});

export const listTournamentsQuerySchema = Joi.object({
  size: Joi.number().valid(4, 8),
  minBuyIn: Joi.number().integer().min(0),
  maxBuyIn: Joi.number().integer().min(0),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100)
});
