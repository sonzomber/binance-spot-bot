/**
 * Arranque del servidor del panel: un proceso SEPARADO del bot.
 *
 * Si el panel falla, el bot no se entera: no comparten proceso, el panel solo
 * lee SQLite y su única escritura (el kill switch) es la misma de `npm run kill`.
 * El panel tampoco se conecta nunca a Binance (no importa ccxt ni el cliente).
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { createPanelApp } from './app.js';
import { PANEL_HOST } from './config.js';
import { PanelDatabase } from './database.js';
import { LiveHub } from './live.js';
import { createToken } from './security.js';

export const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

/**
 * @param {object} args
 * @param {ReturnType<import('./config.js').loadPanelConfig>} args.config
 * @param {import('pino').Logger} args.logger
 * @param {number} [args.port] puerto (por defecto el de la config; 0 = uno libre, para pruebas)
 * @param {string} [args.webRoot]
 * @param {(req, res, next) => void} [args.devMiddleware]
 * @param {object} [args.overrides] para pruebas (now, activateKill, intervalMs)
 * @returns {Promise<{ url: string, port: number, token: string, server: http.Server, hub: LiveHub, close: () => Promise<void> }>}
 */
export async function startPanel({ config, logger, port = config.port, webRoot = WEB_ROOT, devMiddleware, overrides = {} }) {
  const database = new PanelDatabase(config.dbPath);
  const killSwitch = new KillSwitch(config.killSwitchFile);
  const hub = new LiveHub({ database, killSwitch, logFile: config.logFile, intervalMs: overrides.intervalMs, now: overrides.now });
  const token = createToken();
  const listening = { port: null };

  const app = createPanelApp({
    config, database, killSwitch, hub, token, logger, webRoot: path.resolve(webRoot), devMiddleware,
    getPort: () => listening.port,
    now: overrides.now,
    activateKill: overrides.activateKill,
  });
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      database.close();
      reject(err.code === 'EADDRINUSE'
        ? new Error(`El puerto ${port} ya está en uso: cierra el otro programa o cambia PANEL_PORT en el .env.`)
        : err);
    });
    // SIEMPRE 127.0.0.1: el panel no es accesible desde otras máquinas de la red.
    server.listen(port, PANEL_HOST, resolve);
  });
  listening.port = server.address().port;
  const url = `http://${PANEL_HOST}:${listening.port}`;

  return {
    url,
    port: listening.port,
    token,
    server,
    hub,
    async close() {
      hub.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
