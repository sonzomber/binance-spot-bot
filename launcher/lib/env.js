/**
 * El .env para el lanzador: se LEE en memoria y nunca se carga en process.env.
 *
 * Motivo: pm2 copia el entorno de quien lo llama en su lista de procesos
 * (visible con `pm2 jlist`). Si el lanzador cargara el .env, las API keys
 * terminarían ahí. Por eso se lee con dotenv.parse, igual que el panel; solo el
 * proceso del bot (src/index.js) carga el .env, como con `npm start`.
 *
 * Las variables del sistema tienen prioridad sobre el .env, igual que en el bot
 * (dotenv no pisa las que ya existen).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { PROJECT_ROOT, loadPaths } from '../../src/config/index.js';

export const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env');

/**
 * @param {{ envFile?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {{ envFile: string, found: boolean, values: Record<string, string> }}
 */
export function readEnv({ envFile = DEFAULT_ENV_FILE, env = process.env } = {}) {
  const found = fs.existsSync(envFile);
  const fromFile = found ? dotenv.parse(fs.readFileSync(envFile)) : {};
  const fromSystem = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  return { envFile, found, values: { ...fromFile, ...fromSystem } };
}

/**
 * Rutas que usa el lanzador. Los logs de pm2 y el del lanzador van junto al
 * log del bot (LOG_FILE), en la misma carpeta.
 * @param {Record<string, string>} values
 */
export function launcherPaths(values) {
  const paths = loadPaths(values); // solo KILL_SWITCH_FILE, DB_PATH y LOG_FILE (funciona aunque el resto sea inválido)
  const logDir = path.dirname(paths.logFile);
  return Object.freeze({
    ...paths,
    logDir,
    pm2LogDir: path.join(logDir, 'pm2'),
    launcherLog: path.join(logDir, 'lanzador.log'),
  });
}
