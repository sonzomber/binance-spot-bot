/**
 * Soporte para las pruebas del lanzador: consola y pm2 simulados, y una carpeta
 * temporal con .env (API keys centinela), base de datos creada con los stores
 * REALES del bot y el lanzador armado con todo inyectado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { createLauncher } from '../../launcher/lib/actions.js';
import { BotStatusStore } from '../../src/storage/bot-status-store.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { captureLogger, tempDir } from '../helpers.js';
import { SCOPE, SECRET_KEY, SECRET_SECRET } from '../panel/support.js';

export { SCOPE, SECRET_KEY, SECRET_SECRET };

/**
 * Consola simulada: guarda cada línea y responde las preguntas en orden.
 * @param {string[]} [answers] lo que "escribe" la persona en cada pregunta
 */
export function fakeUi(answers = []) {
  const lines = [];
  const pending = [...answers];
  const push = (kind) => (text = '') => lines.push({ kind, text: String(text) });
  const ui = {
    interactive: true,
    lines,
    asked: [],
    text: () => lines.map((l) => (l.kind === 'line' ? l.text : `[${l.kind}] ${l.text}`)).join('\n'),
    line: push('line'),
    title: push('title'),
    section: push('section'),
    info: push('info'),
    detail: push('detail'),
    ok: push('ok'),
    warn: push('warn'),
    error: push('error'),
    async ask(question) {
      ui.asked.push(question);
      return pending.shift() ?? '';
    },
    async confirm({ word, prompt }) {
      ui.asked.push(prompt);
      const { matchesWord } = await import('../../launcher/lib/console.js');
      return matchesWord(pending.shift() ?? '', word);
    },
    waitKey: vi.fn(async () => {}),
    closeIn: vi.fn(async () => {}),
  };
  return ui;
}

/**
 * pm2 simulado: una lista de procesos en memoria. Los "hooks" permiten simular lo
 * que hace cada proceso al iniciarse o detenerse (p. ej. el bot escribe su estado).
 */
export function fakePm2({ now, onStart = {}, onRemove = {} } = {}) {
  const apps = new Map();
  let nextPid = 5000;
  let daemon = false;
  const calls = [];
  const pm2 = {
    apps,
    calls,
    daemonRunning: () => daemon,
    async ensureDaemon() { daemon = true; },
    async list() {
      calls.push(['list']);
      return daemon ? [...apps.values()].map((a) => ({ ...a })) : [];
    },
    async start(name) {
      calls.push(['start', name]);
      daemon = true;
      const app = { name, pid: nextPid++, status: 'online', since: now(), restarts: 0, unstableRestarts: 0, exitCode: null, outLog: null, errLog: null };
      apps.set(name, app);
      await onStart[name]?.(app);
    },
    async remove(name) {
      calls.push(['remove', name]);
      const app = apps.get(name);
      apps.delete(name);
      await onRemove[name]?.(app);
    },
    async kill() {
      calls.push(['kill']);
      daemon = false;
      apps.clear();
    },
    /** Deja un proceso en la lista (como si pm2 ya lo tuviera). */
    set(name, fields) {
      daemon = true;
      const app = { name, pid: nextPid++, status: 'online', since: now(), restarts: 0, unstableRestarts: 0, exitCode: null, outLog: null, errLog: null, ...fields };
      apps.set(name, app);
      return app;
    },
    started: () => calls.filter((c) => c[0] === 'start').map((c) => c[1]),
    removed: () => calls.filter((c) => c[0] === 'remove').map((c) => c[1]),
  };
  return pm2;
}

/**
 * Carpeta temporal con .env, base de datos (escritura, como el bot) y el lanzador.
 * @param {{ envLines?: string[], writeEnv?: boolean, answers?: string[], pm2?: object, deps?: object }} [options]
 */
export async function setupLauncher({ envLines = [], writeEnv = true, answers = [], pm2: pm2Options = {}, deps = {} } = {}) {
  const tmp = await tempDir('launcher-test-');
  const files = {
    envFile: path.join(tmp.dir, '.env'),
    dbPath: path.join(tmp.dir, 'bot.db'),
    logFile: path.join(tmp.dir, 'logs', 'bot.log'),
    killSwitchFile: path.join(tmp.dir, 'STOP'),
  };
  if (writeEnv) {
    fs.writeFileSync(files.envFile, [
      `BINANCE_API_KEY=${SECRET_KEY}`,
      `BINANCE_API_SECRET=${SECRET_SECRET}`,
      'STRATEGY=sma-cross',
      'STRATEGY_PARAMS={"fast":2,"slow":4}',
      'TIMEFRAME=1m',
      'PANEL_PORT=8799',
      `DB_PATH=${files.dbPath}`,
      `LOG_FILE=${files.logFile}`,
      `KILL_SWITCH_FILE=${files.killSwitchFile}`,
      ...envLines,
    ].join('\n'));
  }
  const clock = { t: Date.parse('2026-09-29T12:00:00.000Z') };
  const now = () => clock.t;
  const writer = openDatabase(files.dbPath);
  const ui = fakeUi(answers);
  const pm2 = fakePm2({ now, ...pm2Options });
  const journal = await captureLogger();
  const runScript = vi.fn(async () => ({ code: 0 }));
  const buildPanel = vi.fn(async () => {});
  const openBrowser = vi.fn();
  const ctx = { tmp, files, writer, ui, pm2, journal, runScript, buildPanel, openBrowser, clock, now };
  ctx.launcher = createLauncher({
    ui, pm2, journal: journal.logger, runScript, buildPanel, openBrowser,
    envFile: files.envFile,
    env: {}, // sin variables del sistema: la prueba solo depende del .env temporal
    now,
    sleep: async (ms) => { clock.t += ms; },
    buildState: () => ({ built: true, outdated: false }),
    probe: async () => 'free',
    ...deps,
  });
  ctx.status = (scope = SCOPE) => new BotStatusStore(writer, scope);
  ctx.risk = (scope = SCOPE) => new RiskStore(writer, scope);
  ctx.cleanup = () => {
    writer.close();
    tmp.cleanup();
  };
  return ctx;
}

/** El bot escribe su estado al arrancar (paso 3) y al quedar en marcha, con el pid de pm2. */
export function botStarts(ctx, app, scope = SCOPE) {
  const status = ctx.status(scope);
  status.start({ time: ctx.now(), pid: app.pid, heartbeatMs: 60_000, strategy: 'sma-cross', params: { fast: 2, slow: 4 }, symbol: 'BTC/USDT', timeframe: '1m' });
  status.running({ time: ctx.now() });
  status.heartbeat({ time: ctx.now(), data: { stale: false, reason: null } });
}

/** Un bot en marcha con heartbeat reciente (p. ej. abierto con npm start en una terminal). */
export function botRunningOutside(ctx, { heartbeatAgoMs = 5_000, pid = 777 } = {}) {
  const status = ctx.status();
  status.start({ time: ctx.now() - 3_600_000, pid, heartbeatMs: 60_000, strategy: 'sma-cross', params: {}, symbol: 'BTC/USDT', timeframe: '1m' });
  status.running({ time: ctx.now() - 3_590_000 });
  status.heartbeat({ time: ctx.now() - heartbeatAgoMs, data: { stale: false, reason: null } });
}
