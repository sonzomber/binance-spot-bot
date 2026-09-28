/**
 * Punto de entrada del bot.
 *
 * Orden de arranque: .env → config validada → logger → estrategia →
 * cliente con guardia → preflight. Si cualquier paso falla, el bot no arranca.
 */
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from './config/index.js';
import { PreflightError, runPreflight } from './config/preflight.js';
import { SafetyError } from './config/safety.js';
import { createTradingExchange } from './lib/exchange.js';
import { createLogger } from './lib/logger.js';
import { StrategyError } from './strategy/base-strategy.js';
import { createStrategy } from './strategy/registry.js';

/** Errores de "me niego a arrancar": se muestran sin stack trace. */
const REFUSALS = [SafetyError, PreflightError, StrategyError];

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
  try {
    // Primero lo que no usa red: si la estrategia no existe, ni siquiera se conecta.
    const strategy = await createStrategy(config.strategy.id, config.strategy.params);
    logger.info(
      { strategy: strategy.id, params: strategy.params, warmup: strategy.warmup },
      'Estrategia cargada',
    );

    exchange = createTradingExchange(config);
    await runPreflight(exchange, config, logger);
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
    await exchange?.close();
  }
}

main();
