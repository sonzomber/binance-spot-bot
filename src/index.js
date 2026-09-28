/**
 * Punto de entrada del bot.
 *
 * Orden de arranque: .env → config validada → logger → cliente con guardia → preflight.
 * Si cualquier paso falla, el bot se niega a arrancar.
 */
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from './config/index.js';
import { PreflightError, runPreflight } from './config/preflight.js';
import { SafetyError } from './config/safety.js';
import { createTradingExchange } from './lib/exchange.js';
import { createLogger } from './lib/logger.js';

async function main() {
  const envFileFound = loadEnvFile();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const logger = createLogger();
    if (err instanceof ConfigError) logger.fatal(`El bot no arranca. ${err.message}`);
    else logger.fatal({ err }, 'El bot no arranca');
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.log);
  if (!envFileFound) {
    logger.warn('No se encontró .env: se usan valores por defecto (testnet, dry-run, sin keys).');
  }
  logger.info({ config: describeConfig(config) }, 'Configuración cargada');
  logger.info(
    config.dryRun
      ? 'Modo DRY-RUN: las órdenes se simulan, no se envía nada al exchange.'
      : `Modo TESTNET real: las órdenes se envían a ${config.env} (fondos ficticios).`,
  );

  let exchange;
  try {
    exchange = createTradingExchange(config);
    await runPreflight(exchange, config, logger);
    logger.info('Verificación de arranque completa.');
    // El ciclo de trading se conecta aquí en el módulo 7.
    logger.warn('Ciclo de trading aún no implementado: saliendo.');
  } catch (err) {
    if (err instanceof SafetyError || err instanceof PreflightError) {
      // Rechazo esperado: mensaje claro, sin stack trace.
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
