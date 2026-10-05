import dotenv from 'dotenv';
import Joi from 'joi';
dotenv.config();

const isValidTimezone = (value, helpers) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return helpers.error('any.invalid');
  }
};

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(4000),
  // Joi.uri() rechaza las URIs multi-host de Mongo (host1,host2), por eso se valida por prefijo
  MONGO_URL: Joi.string().pattern(/^mongodb(\+srv)?:\/\//).required(),
  MONGO_URL_TEST: Joi.string().pattern(/^mongodb(\+srv)?:\/\//).allow('').default(''),
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('1d'),
  REFRESH_SECRET: Joi.string().min(16).required(),
  REFRESH_EXPIRES_IN: Joi.string().default('7d'),
  CORS_ORIGINS: Joi.string().allow('').default(''),

  // Fichas y juego
  DAILY_GRANT_AMOUNT: Joi.number().integer().min(0).default(1000),
  APP_TIMEZONE: Joi.string().custom(isValidTimezone).default('America/Argentina/Buenos_Aires'),
  MIN_BET: Joi.number().integer().min(1).default(10),
  MAX_BET: Joi.number().integer().min(1).default(10000),
  HOUSE_RATE: Joi.number().min(0).max(1).default(0),
  TURN_TIMEOUT_SECONDS: Joi.number().integer().min(5).default(20),
  RECONNECT_GRACE_SECONDS: Joi.number().integer().min(5).default(60),
  REMATCH_WINDOW_SECONDS: Joi.number().integer().min(5).default(60),
  TOURNAMENT_NEXT_MATCH_SECONDS: Joi.number().integer().min(0).default(10)
}).unknown(true);

const { error, value: parsed } = schema.validate(process.env, {
  allowUnknown: true,
  stripUnknown: false,
  abortEarly: false
});

if (error && process.env.NODE_ENV === 'production') {
  console.error('Invalid environment configuration:', error.message);
  process.exit(1);
} else if (error) {
  console.warn('Environment warning (non-production):', error.message);
}

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

export const env = {
  nodeEnv: parsed.NODE_ENV,
  port: toInt(parsed.PORT, 4000),
  corsOrigins: (parsed.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean),
  mongoUrl: parsed.MONGO_URL || 'mongodb://localhost:27017/truco_db?replicaSet=rs0',
  mongoUrlTest: parsed.MONGO_URL_TEST || '',
  jwtSecret: parsed.JWT_SECRET || 'change_me',
  jwtExpiresIn: parsed.JWT_EXPIRES_IN || '1d',
  refreshSecret: parsed.REFRESH_SECRET || 'change_me_refresh',
  refreshExpiresIn: parsed.REFRESH_EXPIRES_IN || '7d',

  dailyGrantAmount: toInt(parsed.DAILY_GRANT_AMOUNT, 1000),
  appTimezone: parsed.APP_TIMEZONE || 'America/Argentina/Buenos_Aires',
  minBet: toInt(parsed.MIN_BET, 10),
  maxBet: toInt(parsed.MAX_BET, 10000),
  houseRate: Number(parsed.HOUSE_RATE) || 0,
  turnTimeoutSeconds: toInt(parsed.TURN_TIMEOUT_SECONDS, 20),
  reconnectGraceSeconds: toInt(parsed.RECONNECT_GRACE_SECONDS, 60),
  rematchWindowSeconds: toInt(parsed.REMATCH_WINDOW_SECONDS, 60),
  tournamentNextMatchSeconds: toInt(parsed.TOURNAMENT_NEXT_MATCH_SECONDS, 10)
};
