/**
 * Verificaciones del lanzador antes de actuar: .env y config, interfaz del panel
 * compilada, puerto del panel, y estado del bot según la base de datos.
 *
 * El estado del bot se lee con el acceso de SOLO LECTURA del panel (nunca migra
 * ni escribe) y con las mismas consultas que muestra el panel.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PanelDatabase } from '../../panel/server/database.js';
import { botStatus } from '../../panel/server/queries/status.js';
import { ConfigError, PROJECT_ROOT, loadConfig } from '../../src/config/index.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { MODES, TRADING_ENVS } from '../../src/storage/scope.js';

export const WEB_ROOT = path.join(PROJECT_ROOT, 'panel', 'web');
export const VITE_BIN = path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** Error esperado del lanzador: se muestra el mensaje, sin detalles técnicos. */
export class LauncherError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'LauncherError';
    this.hint = hint;
  }
}

/**
 * Config COMPLETA del bot (la que usará al arrancar), validada en memoria.
 * @param {{ found: boolean, values: Record<string, string> }} envInfo resultado de readEnv()
 * @throws {LauncherError} si falta el .env o tiene errores
 */
export function requireBotConfig(envInfo) {
  if (!envInfo.found) {
    throw new LauncherError('Falta el archivo .env en la carpeta del proyecto.', {
      hint: 'Copia .env.example como .env y complétalo (STRATEGY es obligatoria). El lanzador nunca lo crea ni lo modifica.',
    });
  }
  try {
    return loadConfig(envInfo.values);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    throw new LauncherError(`El .env tiene errores. ${err.message}`, {
      hint: 'Corrígelo en el .env y vuelve a intentarlo (el lanzador no lo modifica).',
    });
  }
}

/** Resumen legible de la config (nunca incluye las API keys). */
export function describeSetup({ env, dryRun, symbol, timeframe, strategy }) {
  return [
    `Entorno: ${env}`,
    `DRY_RUN: ${dryRun ? 'activado (órdenes simuladas)' : 'DESACTIVADO (envía órdenes al exchange)'}`,
    `Par: ${symbol} ${timeframe}`,
    `Estrategia: ${strategy.id}`,
  ].join(' · ');
}

// --- Interfaz del panel ------------------------------------------------------------

/** Fecha de modificación más reciente dentro de una lista de archivos o carpetas. */
function newestMtime(entries) {
  let newest = 0;
  for (const entry of entries) {
    let stat;
    try {
      stat = fs.statSync(entry);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      newest = Math.max(newest, newestMtime(fs.readdirSync(entry).map((name) => path.join(entry, name))));
    } else {
      newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

/**
 * ¿La interfaz está compilada y al día con su código?
 * @returns {{ built: boolean, outdated: boolean }}
 */
export function panelBuildState({ webRoot = WEB_ROOT } = {}) {
  const index = path.join(webRoot, 'dist', 'index.html');
  if (!fs.existsSync(index)) return { built: false, outdated: true };
  const sources = ['src', 'public', 'index.html', 'vite.config.js'].map((p) => path.join(webRoot, p));
  return { built: true, outdated: newestMtime(sources) > fs.statSync(index).mtimeMs };
}

/**
 * Qué hay en el puerto del panel.
 * @returns {Promise<'free'|'ours'|'other'>} 'ours': responde nuestro panel (en pm2 o en una terminal)
 */
export function probePanel(port, { host = '127.0.0.1', timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({
      host, port, path: '/api/meta', headers: { host: `${host}:${port}` }, timeout: timeoutMs,
      agent: false, // sin conexiones que queden abiertas y mantengan vivo el lanzador
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(res.statusCode === 200 && meta?.panel?.readOnly === true && typeof meta.panel.instanceId === 'string' ? 'ours' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); }); // algo aceptó la conexión pero no responde
    req.on('error', (err) => resolve(err.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

// --- Estado del bot en la base (solo lectura) ----------------------------------------

/**
 * Estado del bot en un ámbito, como lo ve el panel. Si la base no existe o está
 * en otra versión, solo se sabe lo del archivo del kill switch.
 * @param {{ dbPath: string, killSwitchFile: string, scope: { env: string, mode: string }, now: number }} args
 */
export function readBotState({ dbPath, killSwitchFile, scope, now }) {
  const killSwitch = new KillSwitch(killSwitchFile);
  const database = new PanelDatabase(dbPath);
  try {
    const db = database.status();
    if (db.state !== 'ok') {
      const file = killSwitch.read();
      return {
        available: false, database: db, scope, state: 'never', bot: null,
        halt: { halted: false, code: null, reason: null, haltedAt: null },
        killSwitch: { active: Boolean(file), file },
      };
    }
    return { available: true, database: db, ...database.read((conn) => botStatus(conn, scope, { killSwitch, now })) };
  } finally {
    database.close();
  }
}

/** Ámbitos (entorno/modo) con una parada guardada. Base inexistente o de otra versión → []. */
export function haltedScopes(dbPath) {
  const database = new PanelDatabase(dbPath);
  try {
    if (database.status().state !== 'ok') return [];
    return database.read((conn) => TRADING_ENVS.flatMap((env) => MODES.map((mode) => ({ env, mode })))
      .map((scope) => ({ ...scope, ...new RiskStore(conn, scope).getHaltState() }))
      .filter((s) => s.halted));
  } finally {
    database.close();
  }
}

/** ¿El estado guardado dice que el bot está corriendo (con heartbeat reciente)? */
export const botLooksAlive = (state) => ['starting', 'running', 'stopping'].includes(state.state);
