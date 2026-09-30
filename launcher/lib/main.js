/**
 * Arma el lanzador (pm2, consola, registro, scripts) y ejecuta una acción.
 * Al terminar: si salió bien, la ventana se cierra sola a los 5 s; si falló (o
 * es el estado), espera una tecla para que se pueda leer el mensaje. El inicio
 * automático nunca espera: nadie está mirando (el resultado queda en el log).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { createLauncher } from './actions.js';
import { LauncherError, VITE_BIN, WEB_ROOT } from './checks.js';
import { createConsoleUi } from './console.js';
import { launcherPaths, readEnv } from './env.js';
import { Pm2Error, createPm2, runToFile } from './pm2.js';
import { createShortcuts } from './shortcuts.js';

/** Cada acción y el título de su ventana. */
export const ACTIONS = Object.freeze({
  'start-bot': { title: 'Iniciar bot', run: (launcher) => launcher.startBot() },
  'stop-bot': { title: 'Detener bot', run: (launcher) => launcher.stopBot() },
  'start-panel': { title: 'Iniciar panel', run: (launcher) => launcher.startPanel() },
  'stop-panel': { title: 'Detener panel', run: (launcher) => launcher.stopPanel() },
  status: { title: 'Estado del bot', run: (launcher) => launcher.status() },
  kill: { title: 'Kill switch', run: (launcher) => launcher.kill() },
  resume: { title: 'Reanudar bot', run: (launcher) => launcher.resume() },
  'install-shortcuts': { title: 'Accesos directos', run: (launcher) => launcher.installShortcuts() },
  'remove-shortcuts': { title: 'Quitar accesos directos', run: (launcher) => launcher.removeShortcuts() },
  'autostart-on': { title: 'Activar inicio automático', run: (launcher) => launcher.autostartOn() },
  'autostart-off': { title: 'Desactivar inicio automático', run: (launcher) => launcher.autostartOff() },
  autostart: { title: 'Inicio automático', run: (launcher) => launcher.autostart() },
});

/** Corre un script del proyecto (kill, resume, status) mostrando su salida tal cual. */
export function runScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, script), ...args], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code }));
  });
}

/** Compila la interfaz del panel (lo mismo que npm run panel:build). */
export async function buildPanel() {
  if (!fs.existsSync(VITE_BIN)) {
    throw new LauncherError('Falta compilar la interfaz del panel y Vite no está instalado.', {
      hint: 'Abre una terminal en la carpeta del proyecto y ejecuta: npm install',
    });
  }
  const { code, output } = await runToFile(
    process.execPath,
    [VITE_BIN, 'build', '--config', path.join(WEB_ROOT, 'vite.config.js'), '--logLevel', 'warn'],
    { env: process.env },
  );
  if (code !== 0) {
    throw new LauncherError(`No se pudo compilar la interfaz del panel:\n${output.trim().split('\n').slice(-15).join('\n')}`);
  }
}

/** Abre una URL en el navegador predeterminado. */
export function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // si no se puede abrir, la URL ya se mostró en la consola
  }
}

/**
 * @param {string[]} argv acción y opciones (--no-pause: no esperar al terminar)
 * @param {{ ui?: ReturnType<typeof createConsoleUi>, deps?: object }} [options] deps: para pruebas
 * @returns {Promise<number>} código de salida
 */
export async function main(argv, { ui: givenUi, deps = {} } = {}) {
  const ui = givenUi ?? createConsoleUi();
  const action = argv.find((arg) => !arg.startsWith('--'));
  // El inicio automático nunca espera una tecla: corre minimizado y sin nadie mirando.
  const pause = !argv.includes('--no-pause') && action !== 'autostart';
  if (!Object.hasOwn(ACTIONS, action ?? '')) {
    ui.error(`Acción desconocida: ${action ?? '(ninguna)'}.`);
    ui.detail(`Acciones: ${Object.keys(ACTIONS).join(', ')}. Ejemplo: npm run launcher -- status`);
    if (pause) await ui.waitKey();
    return 2;
  }

  // Solo rutas: el .env se lee en memoria y nunca se carga en process.env.
  const paths = launcherPaths(readEnv({
    ...(deps.envFile ? { envFile: deps.envFile } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }).values);
  const journal = deps.journal ?? createLogger({ level: 'info', file: paths.launcherLog, console: false });
  const launcher = createLauncher({
    ui,
    journal,
    pm2: createPm2({ logDir: paths.pm2LogDir }),
    runScript,
    buildPanel,
    openBrowser,
    shortcuts: process.platform === 'win32' ? createShortcuts() : undefined,
    ...deps,
  });
  if (!givenUi) process.title = `Binance Spot Bot · ${ACTIONS[action].title}`; // título de la ventana

  let result;
  try {
    result = await ACTIONS[action].run(launcher);
  } catch (err) {
    result = { ok: false };
    ui.line();
    if (err instanceof LauncherError) {
      ui.error(err.message);
      if (err.hint) ui.detail(err.hint);
    } else if (err instanceof Pm2Error) {
      ui.error(`pm2 falló: ${err.message}.`);
      ui.detail(err.output.trim().split('\n').slice(-10).join('\n'));
      journal.error({ action, output: err.output }, `pm2 falló: ${err.message}`);
    } else {
      ui.error(`Error inesperado: ${err.message}`);
      ui.detail(`El detalle quedó en ${paths.launcherLog}.`);
      journal.error({ err, action }, 'Error inesperado en el lanzador');
    }
  }
  if (pause) {
    if (result.ok && !result.keepOpen) await ui.closeIn(5);
    else await ui.waitKey();
  }
  return result.ok ? 0 : 1;
}
