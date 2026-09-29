/**
 * Monitor de datos de mercado (SOLO LECTURA: no envía órdenes).
 * Muestra las velas cerradas, el precio y si los datos están al día.
 *
 *   npm run feed                      (usa DATA_FEED y TIMEFRAME del .env)
 *   TIMEFRAME=1m npm run feed         (para ver cerrarse una vela por minuto)
 *
 * Ctrl+C para salir.
 */
import { ConfigError, loadConfig, loadEnvFile } from '../src/config/index.js';
import { runPreflight } from '../src/config/preflight.js';
import { createCandleFeed } from '../src/data/candle-feed.js';
import { DataHealth } from '../src/data/data-health.js';
import { WeightLimiter } from '../src/data/rate-limiter.js';
import { TimeSync } from '../src/data/time-sync.js';
import { createTradingExchange } from '../src/lib/exchange.js';
import { createLogger } from '../src/lib/logger.js';
import { openDatabase } from '../src/storage/db.js';

loadEnvFile();
let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger(config.log);
const db = openDatabase(config.storage.dbPath, { logger });
let timeSync;
const limiter = new WeightLimiter({ logger, now: () => (timeSync ? timeSync.now() : Date.now()) });
const exchange = createTradingExchange(config, { limiter });
timeSync = new TimeSync({ exchange, logger });
const now = () => timeSync.now();

let feed;
let health;
let summary;
async function shutdown(code = 0) {
  clearInterval(summary);
  health?.stop();
  timeSync.stop();
  await feed?.stop();
  await exchange.close();
  db.close();
  process.exitCode = code;
}

try {
  const { market } = await runPreflight(exchange, config, logger);
  await timeSync.sync();
  timeSync.start();

  health = new DataHealth({ timeframe: config.timeframe, staleAfterMs: config.dataStaleAfterMs, now, logger });
  health.start();
  feed = createCandleFeed({ config, exchange, market, db, health, now, logger, warmupCandles: 50 });

  let lastPrice = null;
  feed.on('price', ({ price }) => { lastPrice = price; });
  feed.on('candle', ({ candle, source, added }) => {
    logger.info(
      { source, added, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume },
      `Vela cerrada ${config.symbol} ${config.timeframe} ${new Date(candle.time).toISOString()} (${source})`,
    );
  });
  feed.on('fatal', () => shutdown(1));

  await feed.start();
  logger.info(`Monitor activo (${config.dataFeed}, ${config.timeframe}). Ctrl+C para salir.`);
  summary = setInterval(() => {
    const status = health.status();
    logger.info(
      { price: lastPrice, usedWeight: limiter.currentWeight(), clockOffsetMs: timeSync.offsetMs },
      status.stale ? `Datos DESACTUALIZADOS: ${status.reason}` : 'Datos al día',
    );
  }, 30_000);
  process.once('SIGINT', () => shutdown(0));
} catch (err) {
  logger.fatal({ err: err.message }, 'El monitor no pudo arrancar');
  await shutdown(1);
}
