/**
 * Lanzador del bot y el panel (pensado para los accesos directos de Windows).
 *
 *   node launcher/cli.js <acción> [--no-pause]
 *   npm run launcher -- <acción>
 *
 * Acciones: start-bot, stop-bot, start-panel, stop-panel, status, kill, resume.
 *
 * Antes de cargar cualquier dependencia verifica la versión de Node y que exista
 * node_modules, para explicar qué falta en vez de cerrarse con un error críptico.
 */
import fs from 'node:fs';
import { createConsoleUi } from './lib/console.js';

const MIN_NODE = [22, 12];
const REQUIRED = ['pm2/bin/pm2', 'dotenv/package.json', 'better-sqlite3/package.json', 'express/package.json', 'pino/package.json', 'zod/package.json'];
const pause = !process.argv.includes('--no-pause');

async function fail(message, hint) {
  const ui = createConsoleUi();
  ui.error(message);
  ui.detail(hint);
  if (pause) await ui.waitKey();
  return 1;
}

async function run() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    return fail(`Este proyecto necesita Node ${MIN_NODE.join('.')} o superior (tienes ${process.versions.node}).`, 'Instala una versión más nueva de Node.js y vuelve a intentarlo.');
  }
  const modules = new URL('../node_modules/', import.meta.url);
  if (REQUIRED.some((file) => !fs.existsSync(new URL(file, modules)))) {
    return fail('Faltan las dependencias del proyecto (la carpeta node_modules no está completa).', 'Abre una terminal en la carpeta del proyecto y ejecuta: npm install');
  }
  const { main } = await import('./lib/main.js');
  return main(process.argv.slice(2));
}

const code = await run();
// Sale explícitamente: nada del lanzador debe quedar vivo manteniendo la ventana abierta.
process.exit(code);
