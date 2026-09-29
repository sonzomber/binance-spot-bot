/**
 * Punto de entrada del bot.
 *
 * Orden de arranque: .env → config validada → logger → (advertencia si el dry-run
 * está desactivado) → estrategia → estado de riesgo guardado → cliente con
 * guardia → preflight → reconciliación con el exchange → límites de riesgo.
 * Si cualquier paso falla, el bot no arranca.
 */
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from './config/index.js';
import { PreflightError, runPreflight } from './config/preflight.js';
import { SafetyError } from './config/safety.js';
import { WeightLimiter } from './data/rate-limiter.js';
import { createExecution } from './execution/index.js';
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
  if (config.dryRun) {
    logger.info('Modo DRY-RUN: las órdenes se simulan (con comisión y slippage), no se envía nada al exchange.');
  } else {
    await warnOrdersEnabled(config, logger);
  }

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
    // Ejecución (dry-run o exchange) y reconciliación: sin diferencias, no se opera.
    // (el módulo 7 conectará getPrice al feed de datos en vivo)
    const { executor, reconciler } = createExecution({
      config, db, exchange, market, risk, logger, getPrice: () => price,
    });
    const report = await reconciler.run();
    if (!report.ok) {
      logger.fatal('El bot no opera: hay diferencias con el exchange. Revísalas con "npm run reconcile".');
      process.exitCode = 1;
      return;
    }

    const limits = await risk.enforceLimits({
      markPrices: { [config.symbol]: price },
      cancelOpenOrders: () => executor.cancelAll(),
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

/**
 * Dry-run desactivado: advertencia imposible de pasar por alto y 5 s para
 * cancelar con Ctrl+C antes de que el bot pueda enviar órdenes.
 */
async function warnOrdersEnabled(config, logger) {
  const line = '='.repeat(72);
  logger.warn(
    [
      line,
      `  DRY-RUN DESACTIVADO: el bot ENVIARÁ ÓRDENES a ${config.env.toUpperCase()} (${config.env === 'testnet' ? 'testnet.binance.vision' : 'demo.binance.com'}).`,
      '  Los fondos son ficticios, pero las órdenes son reales en ese entorno.',
      `  Máximo por operación: ${config.risk.maxTradeUsdt} USDT · pérdida diaria máxima: ${config.risk.maxDailyLossUsdt} USDT.`,
      '  Para volver a simular: DRY_RUN=true en el .env.',
      line,
    ].join('\n'),
  );
  for (let seconds = 5; seconds > 0; seconds--) {
    logger.warn(`Arrancando en ${seconds} s… (Ctrl+C para cancelar)`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main();
