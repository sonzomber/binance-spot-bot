/**
 * Punto de entrada del bot.
 *
 * Carga la configuración, arranca el bot (secuencia en src/app.js) e instala
 * el manejo de señales: Ctrl+C / SIGTERM y errores inesperados provocan un
 * apagado ordenado (src/bot.js). Un segundo Ctrl+C fuerza la salida.
 *
 * Código de salida: 3 si el arranque se rechaza por un motivo esperado (config,
 * entorno, riesgo…) y 1 si falla por un error inesperado (ver src/lib/exit-codes.js).
 */
import { startBot } from './app.js';
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from './config/index.js';
import { installProcessHandlers } from './lifecycle.js';
import { EXIT_CODES, isExpectedStartupError, needsAttentionMessage, startupExitCode } from './lib/exit-codes.js';
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
      logger.warn(needsAttentionMessage('configuración inválida en el .env', { startup: true }));
      process.exitCode = EXIT_CODES.NEEDS_ATTENTION;
    } else {
      logger.fatal({ err }, 'El bot no arranca');
      process.exitCode = EXIT_CODES.ERROR;
    }
    return;
  }

  const logger = createLogger({ ...config.log, scope: { env: config.env, mode: config.mode } });
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
    // Rechazos esperados (config, entorno, riesgo…): mensaje claro sin stack trace y
    // código 3 (no se reintenta solo). Un error inesperado (un bug, la red) se
    // registra completo y sale con código 1.
    const cause = err.cause;
    const expected = isExpectedStartupError(err);
    logger.fatal(
      { detail: cause?.cause?.message, ...(expected ? {} : { err: cause ?? err }) },
      `El bot no arranca: ${err.message}`,
    );
    if (expected) logger.warn(needsAttentionMessage(err.message, { startup: true }));
    handlers.uninstall();
    process.exitCode = startupExitCode(err);
    return;
  }

  const { exitCode } = await bot.stopped;
  handlers.uninstall();
  process.exitCode = exitCode;
  // Si algo quedara abierto (p. ej. una conexión keep-alive), no se cuelga el proceso.
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

main();
