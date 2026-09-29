/**
 * Configuración del panel: SOLO variables sin secretos.
 *
 * El panel no usa loadEnvFile() del bot, que copiaría TODO el .env (API keys
 * incluidas) a process.env. Lee el .env con dotenv.parse y se queda únicamente
 * con una lista blanca de variables: las API keys nunca entran en su config.
 *
 * Cada variable se valida con el MISMO esquema que usa el bot. Si una es
 * inválida, se usa su valor por defecto y se avisa: el panel sirve para
 * monitorear aunque la config tenga errores (igual que `npm run kill`).
 *
 * PANEL_PORT se valida aquí y no en el esquema del bot: un puerto inválido no
 * debe impedir que el bot arranque. El host NO es configurable: siempre 127.0.0.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { PROJECT_ROOT, publicEnvShape } from '../../src/config/index.js';

/** Única dirección en la que escucha el panel. Fija a propósito: no se lee del .env. */
export const PANEL_HOST = '127.0.0.1';
export const DEFAULT_PANEL_PORT = 8787;

/** Variables que el panel lee. Las API keys NO están (ni pueden estar: ver la prueba). */
export const PANEL_ENV_KEYS = Object.freeze([
  'BINANCE_ENV', 'DRY_RUN', 'SYMBOL', 'TIMEFRAME', 'STRATEGY', 'STRATEGY_PARAMS',
  'MAX_TRADE_USDT', 'MAX_DAILY_LOSS_USDT', 'MAX_OPEN_POSITIONS', 'FEE_RATE', 'SLIPPAGE_BPS',
  'DATA_STALE_AFTER_SECONDS', 'HEARTBEAT_SECONDS', 'KILL_SWITCH_FILE', 'LOG_FILE', 'DB_PATH',
]);

const portSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.coerce.number({ error: 'debe ser un número' }).int('debe ser un entero')
    .min(1024, 'debe ser ≥ 1024').max(65535, 'debe ser ≤ 65535').default(DEFAULT_PANEL_PORT),
);

/**
 * @param {object} [options]
 * @param {string} [options.envFile] ruta del .env (si no existe, solo variables de entorno)
 * @param {Record<string, string|undefined>} [options.env] variables del proceso (tienen prioridad, como en el bot)
 */
export function loadPanelConfig({ envFile = path.join(PROJECT_ROOT, '.env'), env = process.env } = {}) {
  const fromFile = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
  const warnings = [];

  // Cada variable de la lista blanca, validada con el esquema del bot.
  const values = {};
  for (const key of PANEL_ENV_KEYS) {
    const raw = env[key] ?? fromFile[key];
    const schema = publicEnvShape.shape[key];
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      values[key] = parsed.data;
    } else {
      const fallback = schema.safeParse(undefined);
      values[key] = fallback.success ? fallback.data : null;
      // STRATEGY vacía no es un error para el panel: la estrategia se lee del estado del bot.
      if (raw !== undefined && raw !== '') warnings.push(`${key}: ${parsed.error.issues[0].message} (se usa ${JSON.stringify(values[key])})`);
    }
  }
  const port = portSchema.safeParse(env.PANEL_PORT ?? fromFile.PANEL_PORT);
  if (!port.success) warnings.push(`PANEL_PORT: ${port.error.issues[0].message} (se usa ${DEFAULT_PANEL_PORT})`);

  const fromRoot = (p) => path.resolve(PROJECT_ROOT, p);
  return Object.freeze({
    host: PANEL_HOST,
    port: port.success ? port.data : DEFAULT_PANEL_PORT,
    dbPath: fromRoot(values.DB_PATH),
    logFile: fromRoot(values.LOG_FILE),
    killSwitchFile: fromRoot(values.KILL_SWITCH_FILE),
    defaultScope: Object.freeze({ env: values.BINANCE_ENV, mode: values.DRY_RUN ? 'dry-run' : 'exchange' }),
    symbol: values.SYMBOL,
    timeframe: values.TIMEFRAME,
    strategy: Object.freeze({ id: values.STRATEGY, params: values.STRATEGY_PARAMS }),
    limits: Object.freeze({
      maxTradeUsdt: values.MAX_TRADE_USDT,
      maxDailyLossUsdt: values.MAX_DAILY_LOSS_USDT,
      maxOpenPositions: values.MAX_OPEN_POSITIONS,
    }),
    feeRate: values.FEE_RATE,
    slippageBps: values.SLIPPAGE_BPS,
    heartbeatMs: values.HEARTBEAT_SECONDS * 1000,
    dataStaleAfterMs: values.DATA_STALE_AFTER_SECONDS * 1000,
    envFileFound: fs.existsSync(envFile),
    warnings: Object.freeze(warnings),
  });
}

/** Ruta legible para mostrar (relativa al proyecto si está dentro). */
export function displayPath(file) {
  const relative = path.relative(PROJECT_ROOT, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
}
