/**
 * Señales del sistema y errores inesperados → apagado ordenado del bot.
 *
 *   SIGINT (Ctrl+C) / SIGTERM → apagado ordenado. Un SEGUNDO Ctrl+C fuerza la
 *                                salida inmediata (queda registrado como advertencia).
 *   uncaughtException /       → se registra el error y se ejecuta el mismo
 *   unhandledRejection           apagado ordenado, con código de salida 1.
 *
 * Si el apagado se cuelga, un temporizador de seguridad fuerza la salida.
 */
export function installProcessHandlers({
  proc = process,
  logger,
  getBot,
  exit = (code) => process.exit(code),
  forceExitAfterMs = 60_000,
}) {
  let signals = 0;
  let watchdog;

  const armWatchdog = () => {
    if (watchdog) return;
    watchdog = setTimeout(() => {
      logger.error(`El apagado no terminó en ${forceExitAfterMs / 1000} s: salida forzada`);
      exit(1);
    }, forceExitAfterMs);
    watchdog.unref?.();
  };

  const onSignal = (signal) => {
    signals++;
    const bot = getBot();
    if (!bot) {
      logger.warn({ signal }, `Señal ${signal} durante el arranque: salida inmediata`);
      exit(130);
      return;
    }
    if (signals > 1) {
      logger.warn({ signal }, `Segunda señal (${signal}): salida FORZADA sin completar el apagado ordenado`);
      exit(130);
      return;
    }
    logger.info({ signal }, `Señal ${signal} recibida: apagado ordenado (otro Ctrl+C fuerza la salida)`);
    armWatchdog();
    bot.shutdown(`señal ${signal}`);
  };

  const onFatal = (kind) => (error) => {
    logger.fatal({ err: error }, kind === 'uncaughtException' ? 'Excepción no controlada' : 'Promesa rechazada sin manejar');
    const bot = getBot();
    if (!bot) {
      exit(1);
      return;
    }
    armWatchdog();
    bot.shutdown(`${kind}: ${error?.message ?? String(error)}`, { exitCode: 1 }).catch(() => exit(1));
  };

  const handlers = {
    SIGINT: () => onSignal('SIGINT'),
    SIGTERM: () => onSignal('SIGTERM'),
    uncaughtException: onFatal('uncaughtException'),
    unhandledRejection: onFatal('unhandledRejection'),
  };
  for (const [event, handler] of Object.entries(handlers)) proc.on(event, handler);

  return {
    uninstall() {
      clearTimeout(watchdog);
      for (const [event, handler] of Object.entries(handlers)) proc.off(event, handler);
    },
  };
}
