/**
 * pm2: configuración de los procesos, llamadas a su línea de comandos (simuladas)
 * y el apagado por mensaje. Nada de esto levanta el daemon real de pm2.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { APPS, ECOSYSTEM_FILE, PM2_BIN, createPm2, parseJlist, runToFile } from '../../launcher/lib/pm2.js';
import { forwardShutdownMessage } from '../../launcher/lib/shutdown-message.js';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { EXIT_CODES } from '../../src/lib/exit-codes.js';
import { tempDir } from '../helpers.js';

const require = createRequire(import.meta.url);
const loadEcosystem = (logDir) => {
  const previous = process.env.BOT_LAUNCHER_LOG_DIR;
  if (logDir === undefined) delete process.env.BOT_LAUNCHER_LOG_DIR;
  else process.env.BOT_LAUNCHER_LOG_DIR = logDir;
  try {
    delete require.cache[require.resolve(ECOSYSTEM_FILE)];
    return require(ECOSYSTEM_FILE);
  } finally {
    if (previous === undefined) delete process.env.BOT_LAUNCHER_LOG_DIR;
    else process.env.BOT_LAUNCHER_LOG_DIR = previous;
  }
};
const app = (ecosystem, name) => ecosystem.apps.find((a) => a.name === name);

describe('procesos de pm2 (launcher/ecosystem.config.cjs)', () => {
  it('bot, panel y rotación, con los nombres que usa el lanzador', () => {
    const eco = loadEcosystem();
    expect(eco.apps.map((a) => a.name)).toEqual([APPS.bot, APPS.panel, APPS.logs]);
    expect(app(eco, APPS.bot).script).toBe(path.join(PROJECT_ROOT, 'launcher', 'bot-process.js'));
    expect(app(eco, APPS.panel).script).toBe(path.join(PROJECT_ROOT, 'launcher', 'panel-process.js'));
    expect(app(eco, APPS.logs).script).toBe(path.join(PROJECT_ROOT, 'launcher', 'log-rotator.js'));
    for (const a of eco.apps) {
      expect(fs.existsSync(a.script)).toBe(true);
      expect(a).toMatchObject({ cwd: path.resolve(PROJECT_ROOT), exec_mode: 'fork', instances: 1, watch: false, windowsHide: true, pmx: false });
    }
  });

  it('el bot NO se reinicia con código 3 (detenido a propósito) ni con 0 (apagado pedido)', () => {
    const bot = app(loadEcosystem(), APPS.bot);
    expect(bot.stop_exit_codes).toEqual([EXIT_CODES.OK, EXIT_CODES.NEEDS_ATTENTION]);
    expect(bot.stop_exit_codes).not.toContain(EXIT_CODES.ERROR); // una caída sí se reinicia
    expect(bot.autorestart).toBe(true);
  });

  it('caídas: reinicio con espera creciente y tope de intentos seguidos', () => {
    for (const a of loadEcosystem().apps) {
      expect(a).toMatchObject({ exp_backoff_restart_delay: 2_000, min_uptime: 60_000, max_restarts: 10 });
      expect(a.restart_delay).toBeUndefined(); // no una espera fija
    }
  });

  it('apagado con mensaje (Windows no puede mandar Ctrl+C) y tiempo de espera mayor que el vigilante del bot', () => {
    const eco = loadEcosystem();
    for (const a of eco.apps) expect(a.shutdown_with_message).toBe(true);
    // El vigilante del bot fuerza la salida a los SHUTDOWN_TIMEOUT_SECONDS (máx. 600) + 30 s.
    expect(app(eco, APPS.bot).kill_timeout).toBeGreaterThan((600 + 30) * 1000);
  });

  it('logs de cada proceso en la carpeta que pasa el lanzador (por defecto data/logs/pm2)', () => {
    const custom = loadEcosystem(path.join('C:', 'x', 'pm2'));
    expect(app(custom, APPS.bot)).toMatchObject({
      out_file: path.join('C:', 'x', 'pm2', 'bot.out.log'), error_file: path.join('C:', 'x', 'pm2', 'bot.err.log'),
    });
    expect(app(custom, APPS.panel).out_file).toBe(path.join('C:', 'x', 'pm2', 'panel.out.log'));
    expect(app(custom, APPS.logs).out_file).toBe(path.join('C:', 'x', 'pm2', 'rotacion.out.log'));
    expect(app(loadEcosystem(), APPS.bot).out_file).toBe(path.join(PROJECT_ROOT, 'data', 'logs', 'pm2', 'bot.out.log'));
    // Nombres fijos: sin merge_logs, pm2 agrega el id del proceso (bot.out-0.log).
    for (const a of custom.apps) expect(a.merge_logs).toBe(true);
  });

  it('ningún proceso define variables de entorno propias (nada de keys en la config de pm2)', () => {
    for (const a of loadEcosystem().apps) {
      expect(a.env).toBeUndefined();
      expect(JSON.stringify(a)).not.toMatch(/BINANCE_API/);
    }
  });
});

describe('llamadas a pm2', () => {
  const fakeRun = (outputs = {}) => vi.fn(async (_node, [, ...args]) => ({ code: 0, output: outputs[args[0]] ?? '' }));

  it('entorno: el del lanzador + sin consulta de versión + carpeta de logs; nunca las keys', async () => {
    const run = fakeRun();
    const pm2 = createPm2({ logDir: 'C:/logs/pm2', env: { PATH: 'x' }, home: 'C:/nada', run, isAlive: () => false });
    expect(pm2.env).toEqual({ PATH: 'x', PM2_DISABLE_VERSION_CHECK: 'true', BOT_LAUNCHER_LOG_DIR: 'C:/logs/pm2' });
    await pm2.start(APPS.bot);
    for (const [node, args, options] of run.mock.calls) {
      expect(node).toBe(process.execPath);
      expect(args[0]).toBe(PM2_BIN);
      expect(options.env).toBe(pm2.env);
    }
  });

  it('sin daemon, list() devuelve [] SIN llamar a pm2 (que lo levantaría)', async () => {
    const run = fakeRun();
    const pm2 = createPm2({ home: 'C:/no-existe', run });
    expect(pm2.daemonRunning()).toBe(false);
    expect(await pm2.list()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('start: primero levanta el daemon sin heredar la salida, después inicia con el ecosistema', async () => {
    const tmp = await tempDir('pm2-home-');
    let alive = false;
    const run = vi.fn(async (_node, [, command]) => {
      if (command === 'ping') {
        fs.writeFileSync(path.join(tmp.dir, 'pm2.pid'), '4242');
        alive = true;
      }
      return { code: 0, output: '' };
    });
    const pm2 = createPm2({ home: tmp.dir, run, isAlive: (pid) => alive && pid === 4242 });
    await pm2.start(APPS.panel);
    await pm2.start(APPS.bot); // el daemon ya corre: no se vuelve a levantar
    expect(run.mock.calls.map(([, [, ...args], options]) => [args, options.stdio])).toEqual([
      [['ping'], 'ignore'],
      [['start', ECOSYSTEM_FILE, '--only', APPS.panel], undefined],
      [['start', ECOSYSTEM_FILE, '--only', APPS.bot], undefined],
    ]);
    tmp.cleanup();
  });

  it('un comando que falla lanza Pm2Error con su salida', async () => {
    const pm2 = createPm2({ home: 'C:/x', run: async () => ({ code: 1, output: '[PM2][ERROR] Process not found' }) });
    await expect(pm2.remove(APPS.bot)).rejects.toMatchObject({
      name: 'Pm2Error', message: 'pm2 delete binance-bot terminó con código 1', output: '[PM2][ERROR] Process not found',
    });
  });

  it('jlist: extrae la lista aunque pm2 imprima algo antes, y resume cada proceso', () => {
    const raw = [{
      name: 'binance-bot', pid: 123,
      pm2_env: { status: 'online', pm_uptime: 1000, restart_time: 2, unstable_restarts: 1, exit_code: 1, pm_out_log_path: 'o.log', pm_err_log_path: 'e.log', env: { SECRETO: 'x' } },
    }, { name: 'binance-logs', pid: 0, pm2_env: { status: 'stopped' } }];
    expect(parseJlist(`[PM2] aviso [1]\n${JSON.stringify(raw)}\n`)).toEqual([
      { name: 'binance-bot', pid: 123, status: 'online', since: 1000, restarts: 2, unstableRestarts: 1, exitCode: 1, outLog: 'o.log', errLog: 'e.log' },
      { name: 'binance-logs', pid: null, status: 'stopped', since: null, restarts: 0, unstableRestarts: 0, exitCode: null, outLog: null, errLog: null },
    ]);
    expect(parseJlist('[PM2] Spawning PM2 daemon\n[]\n')).toEqual([]);
  });

  it('rareza de pm2 7: "waiting restart" tras salir con un código de stop_exit_codes es "detenido" (no se reinicia)', () => {
    const exited = (exitCode, stopCodes) => parseJlist(JSON.stringify([{
      name: 'binance-bot', pid: 0, pm2_env: { status: 'waiting restart', exit_code: exitCode, stop_exit_codes: stopCodes },
    }]))[0].status;
    expect(exited(3, [0, 3])).toBe('stopped'); // kill switch: visto en vivo con pm2 7.0.4
    expect(exited(3, ['0', '3'])).toBe('stopped'); // pm2 también acepta los códigos como texto
    expect(exited(0, [0, 3])).toBe('stopped');
    expect(exited(1, [0, 3])).toBe('waiting restart'); // una caída sí se reinicia
    expect(exited(3, undefined)).toBe('waiting restart');
    expect(exited(3, 3)).toBe('stopped'); // un solo código (sin arreglo)
    expect(() => parseJlist('[PM2] Spawning PM2 daemon')).toThrow(/no devolvió una lista/);
  });
});

describe('runToFile (salida a archivo, espera a que el proceso termine)', () => {
  it('devuelve la salida y el código', async () => {
    const result = await runToFile(process.execPath, ['-e', 'console.log("hola ñandú"); console.error("err"); process.exit(3)'], { env: process.env });
    expect(result.code).toBe(3);
    expect(result.output).toMatch(/hola ñandú/);
    expect(result.output).toMatch(/err/);
  });

  it('NO se cuelga si el comando deja un proceso hijo vivo que hereda su salida (como el daemon de pm2 en Windows)', async () => {
    // El hijo lanza un "daemon" desacoplado que hereda stdout y vive 20 s; el hijo termina enseguida.
    const script = `
      const { spawn } = require('node:child_process');
      const d = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      console.log('daemon ' + d.pid);
      d.unref();
    `;
    const started = Date.now();
    const result = await runToFile(process.execPath, ['-e', script], { env: process.env });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.code).toBe(0);
    const pid = Number(/daemon (\d+)/.exec(result.output)[1]);
    process.kill(pid); // limpieza
  }, 20_000);

  it('con stdio "ignore" no crea archivo de salida', async () => {
    const result = await runToFile(process.execPath, ['-e', 'console.log("x")'], { env: process.env, stdio: 'ignore' });
    expect(result).toEqual({ code: 0, output: '' });
  });

  it('un comando inexistente rechaza la promesa', async () => {
    await expect(runToFile('comando-que-no-existe-xyz', [], { env: process.env })).rejects.toThrow();
  });

  it('control de la propia prueba: con tuberías normales, el mismo caso SÍ se queda esperando', async () => {
    const script = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref()";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => child.once('exit', () => resolve(Date.now())));
    const closed = new Promise((resolve) => child.once('close', () => resolve(Date.now())));
    const [exitAt, closeAt] = await Promise.all([exited, closed]);
    expect(closeAt - exitAt).toBeGreaterThan(2_000); // la salida quedó abierta por el "daemon"
  }, 20_000);
});

describe('apagado pedido por pm2 → el mismo apagado que Ctrl+C', () => {
  const fakeProcess = () => Object.assign(new EventEmitter(), { send: vi.fn(), exit: vi.fn(), channel: { unref: vi.fn() } });

  it('el mensaje "shutdown" dispara los manejadores de SIGINT (los de src/lifecycle.js)', () => {
    const proc = fakeProcess();
    const log = vi.fn();
    expect(forwardShutdownMessage({ proc, log })).toBe(true);
    const onSigint = vi.fn();
    proc.on('SIGINT', onSigint);
    proc.emit('message', 'otra cosa');
    expect(onSigint).not.toHaveBeenCalled();
    proc.emit('message', 'shutdown');
    expect(onSigint).toHaveBeenCalledWith('SIGINT');
    expect(proc.exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/mismo apagado ordenado que con Ctrl\+C/));
    expect(proc.channel.unref).toHaveBeenCalled(); // el canal no mantiene vivo el proceso
  });

  it('si no hay manejador de Ctrl+C (la rotación, o un proceso arrancando), sale de inmediato con 0', () => {
    const proc = fakeProcess();
    const log = vi.fn();
    forwardShutdownMessage({ proc, log });
    proc.emit('message', 'shutdown');
    expect(proc.exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no hay un apagado ordenado pendiente; sale de inmediato/));
  });

  it('sin canal IPC (no lo corre pm2) no hace nada', () => {
    const proc = new EventEmitter();
    expect(forwardShutdownMessage({ proc })).toBe(false);
    expect(proc.listenerCount('message')).toBe(0);
  });

  it('con el lifecycle REAL del bot: el mensaje inicia el apagado ordenado', async () => {
    const { installProcessHandlers } = await import('../../src/lifecycle.js');
    const proc = fakeProcess();
    forwardShutdownMessage({ proc, log: () => {} });
    const bot = { shutdown: vi.fn(async () => {}) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
    const handlers = installProcessHandlers({ proc, logger, getBot: () => bot, exit: vi.fn() });
    proc.emit('message', 'shutdown');
    expect(bot.shutdown).toHaveBeenCalledWith('señal SIGINT');
    handlers.uninstall();
  });

  it('bot-process.js y panel-process.js lo instalan antes de cargar el bot y el panel', () => {
    for (const [file, target] of [['bot-process.js', '../src/index.js'], ['panel-process.js', '../scripts/panel.js']]) {
      const source = fs.readFileSync(path.join(PROJECT_ROOT, 'launcher', file), 'utf8');
      const install = source.indexOf('forwardShutdownMessage();');
      const load = source.indexOf(`await import('${target}')`);
      expect(install).toBeGreaterThan(-1);
      expect(load).toBeGreaterThan(install);
    }
  });
});
