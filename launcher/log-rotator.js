/**
 * Rotación de logs (proceso "binance-logs" del lanzador).
 *
 * Al iniciar y cada 5 minutos revisa el log del bot, el del lanzador y los de
 * pm2, y rota los que pasen de 10 MB (conserva 5 copias). Ver lib/rotate.js.
 *
 * Lee del .env solo las rutas (LOG_FILE, DB_PATH, KILL_SWITCH_FILE), en memoria:
 * nunca carga las API keys.
 */
import { launcherPaths, readEnv } from './lib/env.js';
import { pm2Home } from './lib/pm2.js';
import { ROTATION, logFilesToRotate, rotateAll } from './lib/rotate.js';
import { forwardShutdownMessage } from './lib/shutdown-message.js';

forwardShutdownMessage(); // no tiene nada que apagar: sale de inmediato

const paths = launcherPaths(readEnv().values);
const files = () => logFilesToRotate({ ...paths, pm2Home: pm2Home() });
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function run() {
  const { rotated, errors } = rotateAll(files(), ROTATION);
  for (const r of rotated) console.log(`Rotado ${r.file} (${mb(r.bytes)}): copia en .1, se conservan ${ROTATION.keep}.`);
  for (const e of errors) console.error(`No se pudo rotar ${e.file}: ${e.message}`);
}

console.log(`Rotación de logs: cada ${ROTATION.intervalMs / 60_000} min, a partir de ${mb(ROTATION.maxBytes)}, ${ROTATION.keep} copias.`);
run();
setInterval(run, ROTATION.intervalMs);
