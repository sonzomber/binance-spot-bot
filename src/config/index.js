/**
 * Configuración del bot.
 *
 * Lee variables de entorno (desde .env vía dotenv), las valida con zod y
 * devuelve un objeto inmutable. Si algo está mal, falla al arrancar con un
 * mensaje claro, en lugar de fallar a mitad de una operación.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { TIMEFRAMES } from '../lib/timeframes.js';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Entornos soportados. Mainnet no existe aquí a propósito. */
export const ENVIRONMENTS = Object.freeze(['testnet', 'demo']);

export { TIMEFRAMES };

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const TRUE_VALUES = ['true', '1', 'yes'];
const FALSE_VALUES = ['false', '0', 'no'];

export class ConfigError extends Error {
  constructor(issues) {
    super(`Configuración inválida:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// --- Helpers de esquema -----------------------------------------------------
// Las variables de entorno siempre llegan como string. Una línea vacía en el
// .env ("KEY=") se trata como "no definida" para que aplique el valor por defecto.
const blankToUndefined = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const envValue = (schema) => z.preprocess(blankToUndefined, schema);

const normalized = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const booleanVar = (defaultValue) =>
  envValue(
    z
      .preprocess(
        normalized,
        z.enum([...TRUE_VALUES, ...FALSE_VALUES], { error: 'debe ser true o false' }),
      )
      .transform((value) => TRUE_VALUES.includes(value))
      .default(defaultValue),
  );

const numberVar = (defaultValue, refine) =>
  envValue(refine(z.coerce.number({ error: 'debe ser un número' })).default(defaultValue));

const jsonObjectVar = envValue(
  z
    .string()
    .transform((raw, ctx) => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // cae al issue de abajo
      }
      ctx.addIssue({ code: 'custom', message: 'debe ser un objeto JSON, p. ej. {"fast":9,"slow":21}' });
      return z.NEVER;
    })
    .default({}),
);

// --- Esquema ----------------------------------------------------------------
const envShape = z.object({
  BINANCE_ENV: envValue(
    z
      .preprocess(
        normalized,
        z.enum(ENVIRONMENTS, {
          error: `debe ser "testnet" o "demo". Este bot no soporta mainnet (dinero real).`,
        }),
      )
      .default('testnet'),
  ),
  BINANCE_API_KEY: envValue(z.string().trim().optional()),
  BINANCE_API_SECRET: envValue(z.string().trim().optional()),

  // Desactivar el dry-run exige escribir exactamente DRY_RUN=false: valores como 0, no u
  // off (o un error de tipeo) no desactivan la simulación, dan error.
  DRY_RUN: envValue(
    z
      .preprocess(normalized, z.enum(['true', 'false'], { error: 'debe ser exactamente "true" o "false"' }))
      .transform((value) => value === 'true')
      .default(true),
  ),

  SYMBOL: envValue(
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(
        /^[A-Z0-9]+\/USDT$/,
        'debe tener formato BASE/USDT, p. ej. BTC/USDT (montos y pérdidas se miden en USDT)',
      )
      .default('BTC/USDT'),
  ),
  TIMEFRAME: envValue(
    z.enum(TIMEFRAMES, { error: `debe ser uno de: ${TIMEFRAMES.join(', ')}` }).default('15m'),
  ),
  DATA_FEED: envValue(
    z.preprocess(normalized, z.enum(['rest', 'ws'], { error: 'debe ser "rest" o "ws"' })).default('rest'),
  ),
  // Si no llegan datos nuevos en este tiempo, se marcan como desactualizados y se bloquean órdenes.
  DATA_STALE_AFTER_SECONDS: numberVar(60, (n) => n.min(5, 'debe ser ≥ 5').max(3600, 'debe ser ≤ 3600')),

  // Sin valor por defecto a propósito: la estrategia activa se elige explícitamente.
  // Que el nombre exista lo verifica el registro de estrategias al arrancar.
  STRATEGY: envValue(
    z
      .string({ error: 'es obligatoria: elige la estrategia activa, p. ej. STRATEGY=sma-cross' })
      .trim(),
  ),
  STRATEGY_PARAMS: jsonObjectVar,

  MAX_TRADE_USDT: numberVar(50, (n) => n.positive('debe ser mayor que 0')),
  MAX_DAILY_LOSS_USDT: numberVar(20, (n) => n.positive('debe ser mayor que 0')),
  MAX_OPEN_POSITIONS: numberVar(1, (n) => n.int('debe ser un entero').min(1, 'debe ser ≥ 1')),
  KILL_SWITCH_FILE: envValue(z.string().trim().default('./STOP')),

  FEE_RATE: numberVar(0.001, (n) =>
    n.min(0, 'no puede ser negativo').max(0.01, 'parece demasiado alto (máx. 0.01 = 1%)'),
  ),
  SLIPPAGE_BPS: numberVar(5, (n) =>
    n.min(0, 'no puede ser negativo').max(500, 'parece demasiado alto (máx. 500 bps = 5%)'),
  ),

  LOG_LEVEL: envValue(
    z.preprocess(normalized, z.enum(LOG_LEVELS, { error: `debe ser uno de: ${LOG_LEVELS.join(', ')}` })).default('info'),
  ),
  LOG_FILE: envValue(z.string().trim().default('./data/logs/bot.log')),
  DB_PATH: envValue(z.string().trim().default('./data/bot.db')),
});

const envSchema = envShape.superRefine((env, ctx) => {
  // Para enviar órdenes (aunque sea al testnet) hacen falta credenciales.
  if (!env.DRY_RUN) {
    for (const key of ['BINANCE_API_KEY', 'BINANCE_API_SECRET']) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'es obligatoria cuando DRY_RUN=false' });
      }
    }
  }
});

// --- API pública ------------------------------------------------------------

/**
 * Carga el archivo .env en process.env (sin sobrescribir variables ya definidas).
 * @returns {boolean} true si se encontró el archivo.
 */
export function loadEnvFile(file = path.join(PROJECT_ROOT, '.env')) {
  const result = dotenv.config({ path: file, quiet: true });
  return !result.error;
}

/**
 * Lee SOLO las rutas de archivos (kill switch, base de datos, log), sin validar
 * el resto. Lo usan las herramientas de emergencia (npm run kill): deben
 * funcionar aunque la config esté incompleta o tenga errores.
 */
export function loadPaths(env = process.env) {
  const shape = envShape.pick({ KILL_SWITCH_FILE: true, DB_PATH: true, LOG_FILE: true });
  const result = shape.safeParse(env);
  const e = result.success ? result.data : shape.parse({});
  const fromRoot = (p) => path.resolve(PROJECT_ROOT, p);
  return Object.freeze({
    killSwitchFile: fromRoot(e.KILL_SWITCH_FILE),
    dbPath: fromRoot(e.DB_PATH),
    logFile: fromRoot(e.LOG_FILE),
  });
}

/**
 * Valida el entorno y construye la configuración.
 * @param {Record<string, string | undefined>} env normalmente process.env
 * @throws {ConfigError} con todos los problemas encontrados a la vez
 */
export function loadConfig(env = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(config)'}: ${issue.message}`),
    );
  }
  const e = result.data;
  const fromRoot = (p) => path.resolve(PROJECT_ROOT, p);

  return deepFreeze({
    env: e.BINANCE_ENV,
    apiKey: e.BINANCE_API_KEY,
    apiSecret: e.BINANCE_API_SECRET,
    dryRun: e.DRY_RUN,
    // Modo: 'dry-run' (simulado) o 'exchange' (enviado al exchange de env). Junto con
    // env forma el ámbito de los datos guardados: ver src/storage/scope.js.
    mode: e.DRY_RUN ? 'dry-run' : 'exchange',
    symbol: e.SYMBOL,
    timeframe: e.TIMEFRAME,
    dataFeed: e.DATA_FEED,
    dataStaleAfterMs: e.DATA_STALE_AFTER_SECONDS * 1000,
    strategy: { id: e.STRATEGY, params: e.STRATEGY_PARAMS },
    risk: {
      maxTradeUsdt: e.MAX_TRADE_USDT,
      maxDailyLossUsdt: e.MAX_DAILY_LOSS_USDT,
      maxOpenPositions: e.MAX_OPEN_POSITIONS,
      killSwitchFile: fromRoot(e.KILL_SWITCH_FILE),
    },
    execution: { feeRate: e.FEE_RATE, slippageBps: e.SLIPPAGE_BPS },
    log: { level: e.LOG_LEVEL, file: fromRoot(e.LOG_FILE) },
    storage: { dbPath: fromRoot(e.DB_PATH) },
  });
}

/** Versión de la config apta para logs: indica si hay credenciales, sin mostrarlas. */
export function describeConfig(config) {
  const { apiKey, apiSecret, ...rest } = config;
  return { ...rest, credentials: apiKey && apiSecret ? 'configuradas' : 'no configuradas' };
}

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(object);
}
