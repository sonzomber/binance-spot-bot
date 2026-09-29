/**
 * Panel web de monitoreo (solo lectura), en un proceso separado del bot.
 *
 *   npm run panel        → http://127.0.0.1:8787 (puerto: PANEL_PORT en el .env)
 *
 * Solo escucha en 127.0.0.1. Lee SQLite en solo lectura y el log del bot. Su
 * única acción es activar el kill switch (el mismo mecanismo que npm run kill).
 * Nunca lee las API keys ni se conecta a Binance.
 */
import { loadPanelConfig } from '../panel/server/config.js';
import { startPanel } from '../panel/server/index.js';
import { createLogger } from '../src/lib/logger.js';

const config = loadPanelConfig();
// Sin ámbito: las líneas del panel son "generales" en el log (p. ej. el kill switch desde el panel).
const logger = createLogger({ level: 'info', file: config.logFile });
for (const warning of config.warnings) logger.warn(`Config del panel: ${warning}`);
if (!config.envFileFound) logger.warn('No se encontró .env: el panel usa variables de entorno y valores por defecto.');

let panel;
try {
  panel = await startPanel({ config, logger });
} catch (err) {
  logger.fatal(`El panel no arranca: ${err.message}`);
  process.exit(1);
}
logger.info(`Panel de monitoreo en ${panel.url} (solo lectura; única acción: kill switch). Ctrl+C para cerrarlo.`);

let closing = false;
const close = async () => {
  if (closing) process.exit(1); // segundo Ctrl+C: salida inmediata
  closing = true;
  logger.info('Cerrando el panel… (el bot no se ve afectado)');
  await panel.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
