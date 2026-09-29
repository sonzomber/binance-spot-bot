/**
 * Panel web de monitoreo (solo lectura), en un proceso separado del bot.
 *
 *   npm run panel        → compila la interfaz y abre http://127.0.0.1:8787 (puerto: PANEL_PORT)
 *   npm run panel:dev    → igual, pero recompila la interfaz al guardar (basta con recargar)
 *   npm run panel:build  → solo compila la interfaz (panel/web/dist)
 *
 * Solo escucha en 127.0.0.1. Lee SQLite en solo lectura y el log del bot. Su
 * única acción es activar el kill switch (el mismo mecanismo que npm run kill).
 * Nunca lee las API keys ni se conecta a Binance.
 */
import path from 'node:path';
import { loadPanelConfig } from '../panel/server/config.js';
import { WEB_ROOT, startPanel } from '../panel/server/index.js';
import { createLogger } from '../src/lib/logger.js';

const dev = process.argv.includes('--dev');
const config = loadPanelConfig();
// Sin ámbito: las líneas del panel son "generales" en el log (p. ej. el kill switch desde el panel).
const logger = createLogger({ level: 'info', file: config.logFile });
for (const warning of config.warnings) logger.warn(`Config del panel: ${warning}`);
if (!config.envFileFound) logger.warn('No se encontró .env: el panel usa variables de entorno y valores por defecto.');

// Desarrollo: recompila la interfaz al guardar. El panel la sirve igual que siempre
// (desde dist, con la misma seguridad): no hay servidor de desarrollo de Vite.
let watcher;
if (dev) {
  const { build } = await import('vite');
  watcher = await build({ configFile: path.join(WEB_ROOT, 'vite.config.js'), logLevel: 'warn', build: { watch: {} } });
  watcher.on('event', (event) => {
    if (event.code === 'END') logger.info('Interfaz compilada: recarga la página para ver los cambios.');
    if (event.code === 'ERROR') logger.error(`Error al compilar la interfaz: ${event.error?.message}`);
    event.result?.close?.();
  });
}

let panel;
try {
  panel = await startPanel({ config, logger });
} catch (err) {
  logger.fatal(`El panel no arranca: ${err.message}`);
  await watcher?.close();
  process.exit(1);
}
logger.info(`Panel de monitoreo en ${panel.url} (solo lectura; única acción: kill switch). Ctrl+C para cerrarlo.`);

let closing = false;
const close = async () => {
  if (closing) process.exit(1); // segundo Ctrl+C: salida inmediata
  closing = true;
  logger.info('Cerrando el panel… (el bot no se ve afectado)');
  await watcher?.close();
  await panel.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
