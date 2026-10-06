import Joi from 'joi';
import { ACTION_TYPES } from '../game/truco/index.js';
import { SIGNS } from '../services/matchService.js';
import { AppError } from '../utils/AppError.js';
import { esMessages } from './messages.js';
import { objectId } from './room.schemas.js';

export const roomRefSchema = Joi.object({
  roomId: objectId.required().label('La sala')
});

export const tournamentRefSchema = Joi.object({
  tournamentId: objectId.required().label('El torneo')
});

export const matchRefSchema = Joi.object({
  matchId: objectId.required().label('La partida')
});

export const gameActionSchema = Joi.object({
  matchId: objectId.required().label('La partida'),
  actionId: Joi.string().guid().required().label('El identificador de la acción'),
  type: Joi.string().valid(...ACTION_TYPES).required().label('La acción'),
  payload: Joi.object({
    cardId: Joi.string().max(20).label('La carta')
  }).default({})
});

export const gameSignSchema = Joi.object({
  matchId: objectId.required().label('La partida'),
  sign: Joi.string().valid(...SIGNS).required().label('La seña')
});

/** Valida un payload entrante de Socket.IO; lanza AppError VALIDATION_ERROR si no cumple. */
export function validateSocketPayload(schema, payload) {
  const { error, value } = schema.validate(payload ?? {}, {
    abortEarly: false,
    stripUnknown: true,
    messages: esMessages,
    errors: { wrap: { label: false } }
  });
  if (error) throw new AppError(error.details.map((d) => d.message).join('. '), 400, 'VALIDATION_ERROR');
  return value;
}
