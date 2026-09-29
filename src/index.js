/**
 * Punto de entrada del bot.
 *
 * Orden de arranque: .env → config validada → logger → estrategia → estado de
 * riesgo guardado → cliente con guardia → preflight → límites de riesgo.
 * Si cualquier paso falla, el bot no arranca.
 */
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from './config/index.js';
import { PreflightError, runPreflight } from './config/preflight.js';
import { SafetyError } from './config/safety.js';
import { WeightLimiter } from './data/rate-limiter.js';
import { TimeSync } from './data/time-sync.js';
import { createTradingExchange } from './lib/exchange.js';
import { createLogger } from './lib/logger.js';
import { RiskError, createRiskManager } from './risk/risk-manager.js';
import { openDatabase } from './storage/db.js';
import { StrategyError } from './strategy/base-strategy.js';
import { createStrategy } from './strategy/registry.js';

/** Errores de "me niego a arrancar": se muestran sin stack trace. */
const REFUSALS = [SafetyError, PreflightError, StrategyError, RiskError];

async function main() {
  const envFileFound = loadEnvFile();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const logger = createLogger();
    if (err instanceof ConfigError) {
      const hint = envFileFound ? '' : '\n  (No se encontró .env: copia .env.example como .env y complétalo.)';
      logger.fatal(`El bot no arranca. ${err.message}${hint}`);
    } else {
      logger.fatal({ err }, 'El bot no arranca');
    }
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.log);
  if (!envFileFound) {
    logger.warn('No se encontró .env: se usan variables de entorno y valores por defecto.');
  }
  logger.info({ config: describeConfig(config) }, 'Configuración cargada');
  logger.info(
    config.dryRun
      ? 'Modo DRY-RUN: las órdenes se simulan, no se envía nada al exchange.'
      : `Modo TESTNET real: las órdenes se envían a ${config.env} (fondos ficticios).`,
  );

  let exchange;
  let db;
  let timeSync;
  try {
    // Primero lo que no usa red: si la estrategia no existe, ni siquiera se conecta.
    const strategy = await createStrategy(config.strategy.id, config.strategy.params);
    logger.info(
      { strategy: strategy.id, params: strategy.params, warmup: strategy.warmup },
      'Estrategia cargada',
    );

    // Estado de riesgo guardado en SQLite: si el bot quedó detenido, no arranca.
    db = openDatabase(config.storage.dbPath);
    const risk = createRiskManager(config, db, logger);
    risk.assertCanStart();

    // Limitador de peso (cabeceras de Binance, 429/418) y hora del servidor.
    const limiter = new WeightLimiter({ logger, now: () => (timeSync ? timeSync.now() : Date.now()) });
    exchange = createTradingExchange(config, { limiter });
    timeSync = new TimeSync({ exchange, logger });
    const { market } = await runPreflight(exchange, config, logger);
    await timeSync.sync();
    timeSync.start();

    // Con el precio actual: ¿alcanza MAX_TRADE_USDT para una orden válida? ¿se superó la pérdida diaria?
    const { last: price } = await exchange.fetchTicker(config.symbol);
    risk.assertTradable(market, price);
    const size = risk.sizeBuy({ market, price });
    logger.info(
      { price, amount: size.amount, estimatedCost: Number(size.estimatedCost.toFixed(4)) },
      `Tamaño de compra con MAX_TRADE_USDT=${config.risk.maxTradeUsdt}`,
    );
    const limits = await risk.enforceLimits({
      markPrices: { [config.symbol]: price },
      cancelOpenOrders: async () => [], // el módulo de ejecución (6) cancelará las órdenes reales
    });
    if (limits.halted) {
      process.exitCode = 1;
      return;
    }
    logger.info({ daily: limits.daily }, 'Límites de riesgo OK');
    logger.info('Verificación de arranque completa.');
    // El ciclo de trading se conecta aquí en el módulo 7.
    logger.warn('Ciclo de trading aún no implementado: saliendo.');
  } catch (err) {
    if (REFUSALS.some((ErrorClass) => err instanceof ErrorClass)) {
      logger.fatal({ detail: err.cause?.message }, `El bot no arranca: ${err.message}`);
    } else {
      logger.fatal({ err }, 'El bot no arranca');
    }
    process.exitCode = 1;
  } finally {
    timeSync?.stop();
    await exchange?.close();
    db?.close();
  }
}

main();
