/**
 * Punto de entrada del bot.
 *
 * Carga la configuración, arranca el bot (secuencia en src/app.js) e instala
 * el manejo de señales: Ctrl+C / SIGTERM y errores inesperados provocan un
 * apagado ordenado (src/bot.js). Un segundo Ctrl+C fuerza la salida.
 */
import { startBot } from './app.js';
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from './config/index.js';
import { installProcessHandlers } from './lifecycle.js';
import { createLogger } from './lib/logger.js';

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
  if (!envFileFound) logger.warn('No se encontró .env: se usan variables de entorno y valores por defecto.');
  logger.info({ config: describeConfig(config) }, 'Configuración cargada');
  logger.info(
    config.dryRun
      ? 'Modo DRY-RUN: las órdenes se simulan (con comisión y slippage), no se envía nada al exchange.'
      : `Modo EXCHANGE: las órdenes se envían a ${config.env} (fondos ficticios).`,
  );

  let bot;
  const handlers = installProcessHandlers({
    logger,
    getBot: () => bot,
    forceExitAfterMs: config.lifecycle.shutdownTimeoutMs + 30_000,
  });

  try {
    bot = await startBot({ config, logger });
  } catch (err) {
    // Rechazos esperados (config, entorno, riesgo…): mensaje claro sin stack trace.
    // Un error inesperado (un bug) sí se registra completo.
    const expected = ['SafetyError', 'PreflightError', 'StrategyError', 'RiskError', 'ConfigError', 'IpBannedError'];
    const cause = err.cause;
    logger.fatal(
      { detail: cause?.cause?.message, ...(expected.includes(cause?.name) ? {} : { err: cause ?? err }) },
      `El bot no arranca: ${err.message}`,
    );
    handlers.uninstall();
    process.exitCode = 1;
    return;
  }

  const { exitCode } = await bot.stopped;
  handlers.uninstall();
  process.exitCode = exitCode;
  // Si algo quedara abierto (p. ej. una conexión keep-alive), no se cuelga el proceso.
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

main();
