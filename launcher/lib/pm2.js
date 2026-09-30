/**
 * pm2 por su línea de comandos (node node_modules/pm2/bin/pm2 …).
 *
 * - Se usa como programa externo, sin importarlo: pm2 es AGPL-3.0 y así queda
 *   separado de este código.
 * - El daemon de pm2 vive en ~/.pm2 (PM2_HOME). En Windows su canal de
 *   comunicación tiene un nombre fijo, así que no se puede aislar por proyecto.
 * - Se desactiva la consulta diaria de versión del daemon a los servidores de pm2.
 * - La salida de cada comando va a un archivo temporal y se espera a que el
 *   proceso TERMINE (no a que se cierre su salida): en Windows, cuando un comando
 *   levanta el daemon, el daemon hereda la salida de quien lo lanzó y la deja
 *   abierta para siempre. Con tuberías, esperar su cierre colgaría el lanzador.
 *   Además, el daemon se levanta aparte (`ensureDaemon`) sin heredar nada.
 * - El entorno que recibe pm2 es el del lanzador, que nunca carga el .env: pm2
 *   guarda ese entorno en su lista de procesos, y ahí no deben estar las keys.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/config/index.js';
import ecosystem from '../ecosystem.config.cjs';

export const PM2_BIN = path.join(PROJECT_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');
export const ECOSYSTEM_FILE = path.join(PROJECT_ROOT, 'launcher', 'ecosystem.config.cjs');
export const APPS = Object.freeze({ bot: 'binance-bot', panel: 'binance-panel', logs: 'binance-logs' });
/** Estados de pm2 en los que el proceso está (o volverá a estar) en marcha. */
export const ACTIVE_STATUSES = Object.freeze(['online', 'launching', 'waiting restart']);

if (!ecosystem.apps.every((app) => Object.values(APPS).includes(app.name))) {
  throw new Error('launcher/ecosystem.config.cjs y APPS no coinciden'); // protección ante un cambio de nombres
}

/** Carpeta del daemon de pm2. */
export function pm2Home(env = process.env) {
  return env.PM2_HOME || path.join(os.homedir(), '.pm2');
}

/** Error de un comando de pm2, con su salida para mostrarla. */
export class Pm2Error extends Error {
  constructor(args, { code, output }) {
    super(`pm2 ${args.join(' ')} terminó con código ${code}`);
    this.name = 'Pm2Error';
    this.code = code;
    this.output = output;
  }
}

let counter = 0;

/**
 * Ejecuta un comando con la salida en un archivo temporal y espera a que TERMINE.
 * @returns {Promise<{ code: number|null, output: string }>}
 */
export function runToFile(command, args, { env, cwd = PROJECT_ROOT, stdio = 'file', timeoutMs = 15 * 60_000 } = {}) {
  const file = path.join(os.tmpdir(), `binance-launcher-${process.pid}-${Date.now()}-${counter++}.log`);
  const fd = stdio === 'file' ? fs.openSync(file, 'w') : null;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd, env, windowsHide: true, stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
      });
    } catch (err) {
      reject(err);
      return;
    } finally {
      if (fd !== null) fs.closeSync(fd); // el hijo ya tiene su copia
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const read = () => {
      if (fd === null) return '';
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      } finally {
        fs.rmSync(file, { force: true });
      }
    };
    child.once('error', (err) => {
      clearTimeout(timer);
      read();
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output: read() });
    });
  });
}

/**
 * Resumen de un proceso de `pm2 jlist` (sin el entorno ni la config completa).
 *
 * Corrige una rareza de pm2 7: con `exp_backoff_restart_delay`, un proceso que sale
 * con un código de `stop_exit_codes` NO se reinicia, pero pm2 deja su estado en
 * "waiting restart" para siempre (God.handleExit lo asigna sin mirar si se detiene).
 * Aquí se muestra como lo que es: detenido.
 */
export function summarizeApp(raw) {
  const env = raw.pm2_env ?? {};
  const stopCodes = [].concat(env.stop_exit_codes ?? []).map(Number);
  const stoppedForGood = env.status === 'waiting restart' && stopCodes.includes(env.exit_code);
  return {
    name: raw.name,
    pid: raw.pid || null,
    status: stoppedForGood ? 'stopped' : env.status,
    since: env.pm_uptime ?? null, // cuándo arrancó (o se detuvo) por última vez, ms
    restarts: env.restart_time ?? 0,
    unstableRestarts: env.unstable_restarts ?? 0,
    exitCode: env.exit_code ?? null,
    outLog: env.pm_out_log_path ?? null,
    errLog: env.pm_err_log_path ?? null,
  };
}

/**
 * Extrae el arreglo JSON de la salida de `pm2 jlist`. pm2 puede imprimir avisos
 * antes ("[PM2] …", que también empiezan con "["): la lista es la línea que
 * empieza con "[{" o "[]".
 */
export function parseJlist(output) {
  const start = output.search(/^\[\s*[{\]]/m);
  const end = output.lastIndexOf(']');
  if (start === -1 || end < start) throw new Error(`pm2 jlist no devolvió una lista: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start, end + 1)).map(summarizeApp);
}

/**
 * @param {{ logDir?: string, env?: Record<string, string|undefined>, home?: string,
 *           run?: typeof runToFile, isAlive?: (pid: number) => boolean }} [options]
 *        logDir: carpeta de los logs de pm2 (la lee ecosystem.config.cjs)
 */
export function createPm2({
  logDir,
  env = process.env,
  home = pm2Home(env),
  run = runToFile,
  isAlive = defaultIsAlive,
} = {}) {
  const pm2Env = {
    ...env,
    PM2_DISABLE_VERSION_CHECK: 'true',
    ...(logDir ? { BOT_LAUNCHER_LOG_DIR: logDir } : {}),
  };
  const exec = async (args, options = {}) => {
    const result = await run(process.execPath, [PM2_BIN, ...args], { env: pm2Env, ...options });
    if (result.code !== 0) throw new Pm2Error(args, result);
    return result.output;
  };

  const api = {
    env: pm2Env,
    /** ¿Está corriendo el daemon? (sin llamar a pm2, que lo levantaría) */
    daemonRunning() {
      try {
        const pid = Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 && isAlive(pid);
      } catch {
        return false;
      }
    },
    /** Levanta el daemon si no está, sin que herede nada del lanzador. */
    async ensureDaemon() {
      if (!api.daemonRunning()) await exec(['ping'], { stdio: 'ignore' });
    },
    /** Procesos que conoce pm2. Si el daemon no corre, ninguno (y no lo levanta). */
    async list() {
      if (!api.daemonRunning()) return [];
      return parseJlist(await exec(['jlist']));
    },
    async start(name) {
      await api.ensureDaemon();
      return exec(['start', ECOSYSTEM_FILE, '--only', name]);
    },
    /** Detiene (con el apagado ordenado) y lo quita de la lista de pm2. */
    async remove(name) {
      return exec(['delete', name]);
    },
    /** Apaga el daemon de pm2. */
    async kill() {
      return exec(['kill']);
    },
  };
  return api;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
