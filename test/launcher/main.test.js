/**
 * El lanzador completo (main): acciones, mensajes de error, pausas al terminar,
 * y que nunca modifique el .env ni cargue las keys en process.env.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, main } from '../../launcher/lib/main.js';
import { Pm2Error } from '../../launcher/lib/pm2.js';
import { PROJECT_ROOT } from '../../src/config/index.js';
import { SECRET_KEY, SECRET_SECRET, fakeUi, setupLauncher } from './support.js';

let ctx;
afterEach(() => ctx?.cleanup());

/**
 * Dependencias de main para la carpeta temporal: nada real (ni pm2, ni scripts, ni
 * navegador, ni accesos directos en el escritorio).
 */
const depsFor = (c, extra = {}) => ({
  envFile: c.files.envFile, env: {}, pm2: c.pm2, journal: c.journal.logger, runScript: c.runScript,
  buildPanel: c.buildPanel, openBrowser: c.openBrowser, shortcuts: c.shortcuts, now: c.now,
  sleep: async (ms) => { c.clock.t += ms; },
  buildState: () => ({ built: true, outdated: false }), probe: async () => 'free', ...extra,
});

describe('main', () => {
  it('las acciones disponibles, cada una con el título de su ventana', () => {
    expect(Object.fromEntries(Object.entries(ACTIONS).map(([name, a]) => [name, a.title]))).toEqual({
      'start-bot': 'Iniciar bot',
      'stop-bot': 'Detener bot',
      'start-panel': 'Iniciar panel',
      'stop-panel': 'Detener panel',
      status: 'Estado del bot',
      kill: 'Kill switch',
      resume: 'Reanudar bot',
      'install-shortcuts': 'Accesos directos',
      'remove-shortcuts': 'Quitar accesos directos',
      'autostart-on': 'Activar inicio automático',
      'autostart-off': 'Desactivar inicio automático',
      autostart: 'Inicio automático',
    });
  });

  it('el inicio automático nunca espera una tecla (corre minimizado, sin nadie mirando)', async () => {
    ctx = await setupLauncher({ writeEnv: false }); // falla todo: igual no espera
    expect(await main(['autostart'], { ui: ctx.ui, deps: depsFor(ctx) })).toBe(0);
    expect(ctx.ui.waitKey).not.toHaveBeenCalled();
    expect(ctx.ui.closeIn).not.toHaveBeenCalled();
  });

  it('acción desconocida: lo explica, espera una tecla y sale con 2', async () => {
    const ui = fakeUi();
    expect(await main(['borrar-todo'], { ui })).toBe(2);
    expect(ui.text()).toMatch(/\[error\] Acción desconocida: borrar-todo\./);
    expect(ui.text()).toMatch(/Acciones: start-bot, stop-bot, start-panel, stop-panel, status, kill, resume/);
    expect(ui.waitKey).toHaveBeenCalled();
    const quiet = fakeUi();
    expect(await main(['--no-pause'], { ui: quiet })).toBe(2);
    expect(quiet.waitKey).not.toHaveBeenCalled();
  });

  it('si sale bien, la ventana se cierra sola a los 5 s', async () => {
    ctx = await setupLauncher();
    expect(await main(['stop-panel'], { ui: ctx.ui, deps: depsFor(ctx) })).toBe(0);
    expect(ctx.ui.closeIn).toHaveBeenCalledWith(5);
    expect(ctx.ui.waitKey).not.toHaveBeenCalled();
  });

  it('el estado siempre espera una tecla (para poder leerlo)', async () => {
    ctx = await setupLauncher();
    expect(await main(['status'], { ui: ctx.ui, deps: depsFor(ctx) })).toBe(0);
    expect(ctx.ui.waitKey).toHaveBeenCalled();
    expect(ctx.ui.closeIn).not.toHaveBeenCalled();
  });

  it('un error esperado: mensaje claro y qué hacer, espera una tecla y sale con 1', async () => {
    ctx = await setupLauncher({ writeEnv: false });
    expect(await main(['start-bot'], { ui: ctx.ui, deps: depsFor(ctx) })).toBe(1);
    expect(ctx.ui.text()).toMatch(/\[error\] Falta el archivo \.env en la carpeta del proyecto\.\n\[detail\] Copia \.env\.example/);
    expect(ctx.ui.waitKey).toHaveBeenCalled();
  });

  it('pm2 falla: muestra su salida y lo registra', async () => {
    ctx = await setupLauncher();
    ctx.pm2.list = async () => { throw new Pm2Error(['jlist'], { code: 1, output: 'línea 1\n[PM2][ERROR] algo salió mal\n' }); };
    expect(await main(['stop-bot', '--no-pause'], { ui: ctx.ui, deps: depsFor(ctx) })).toBe(1);
    expect(ctx.ui.text()).toMatch(/\[error\] pm2 falló: pm2 jlist terminó con código 1\.\n\[detail\] línea 1\n\[PM2\]\[ERROR\] algo salió mal/);
    expect(ctx.journal.lines.at(-1)).toMatchObject({ level: 50, action: 'stop-bot', msg: 'pm2 falló: pm2 jlist terminó con código 1' });
  });

  it('error inesperado: lo dice y deja el detalle en el log del lanzador', async () => {
    ctx = await setupLauncher();
    ctx.pm2.list = async () => { throw new TypeError('x is undefined'); };
    expect(await main(['stop-panel', '--no-pause'], { ui: ctx.ui, deps: depsFor(ctx) })).toBe(1);
    expect(ctx.ui.text()).toMatch(/\[error\] Error inesperado: x is undefined\n\[detail\] El detalle quedó en .*lanzador\.log\./);
    expect(ctx.journal.lines.at(-1)).toMatchObject({ level: 50, err: expect.objectContaining({ message: 'x is undefined' }) });
  });

  it('ninguna acción modifica el .env ni carga las keys en process.env, y nada muestra las keys', async () => {
    ctx = await setupLauncher({ answers: ['SI', 'REANUDAR'] });
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(ctx.files.envFile)).digest('hex');
    const before = { hash: hash(), mtime: fs.statSync(ctx.files.envFile).mtimeMs, env: { ...process.env } };
    ctx.pm2.start = vi.fn(async () => {}); // nada llega a "en marcha": igual recorre todo
    for (const action of Object.keys(ACTIONS)) {
      await main([action, '--no-pause'], { ui: ctx.ui, deps: depsFor(ctx) });
    }
    expect(hash()).toBe(before.hash);
    expect(fs.statSync(ctx.files.envFile).mtimeMs).toBe(before.mtime);
    expect(process.env).toEqual(before.env);
    const everything = `${ctx.ui.text()}\n${JSON.stringify(ctx.journal.lines)}`;
    expect(everything).not.toContain(SECRET_KEY);
    expect(everything).not.toContain(SECRET_SECRET);
  });
});

describe('código fuente del lanzador', () => {
  const files = fs.readdirSync(path.join(PROJECT_ROOT, 'launcher'), { recursive: true })
    .filter((f) => /\.(c?js)$/.test(f))
    .map((f) => path.join(PROJECT_ROOT, 'launcher', f));

  it('nunca carga el .env en process.env ni escribe en process.env', () => {
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/loadEnvFile\(|dotenv\.config\(|process\.env(\.[A-Z_]+|\[[^\]]+\])\s*=[^=]|Object\.assign\(\s*process\.env/);
    }
  });
});
