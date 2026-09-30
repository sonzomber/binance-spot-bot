/**
 * Verificaciones del lanzador: .env (sin tocar process.env), config, interfaz
 * compilada, puerto del panel y estado del bot leído en solo lectura.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LauncherError, WEB_ROOT, botLooksAlive, describeSetup, haltedScopes, panelBuildState, probePanel, readBotState, requireBotConfig,
} from '../../launcher/lib/checks.js';
import { createConsoleUi, matchesWord } from '../../launcher/lib/console.js';
import { launcherPaths, readEnv } from '../../launcher/lib/env.js';
import { WEB_ROOT as PANEL_WEB_ROOT } from '../../panel/server/index.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { tempDir } from '../helpers.js';
import { SECRET_KEY, SECRET_SECRET, setupPanel } from '../panel/support.js';

let tmp;
afterEach(() => tmp?.cleanup());

describe('.env: se lee en memoria, nunca se carga en process.env', () => {
  it('lee el archivo; las variables del sistema tienen prioridad (como en el bot)', async () => {
    tmp = await tempDir('env-test-');
    const envFile = path.join(tmp.dir, '.env');
    fs.writeFileSync(envFile, `BINANCE_API_KEY=${SECRET_KEY}\nSYMBOL=ETH/USDT\nTIMEFRAME=5m\n`);
    const before = { ...process.env };
    const info = readEnv({ envFile, env: { TIMEFRAME: '1h', VACIA: undefined } });
    expect(info).toMatchObject({ envFile, found: true });
    expect(info.values).toMatchObject({ BINANCE_API_KEY: SECRET_KEY, SYMBOL: 'ETH/USDT', TIMEFRAME: '1h' });
    expect('VACIA' in info.values).toBe(false);
    expect(process.env).toEqual(before); // process.env intacto
    expect(Object.values(process.env)).not.toContain(SECRET_KEY);
  });

  it('sin .env: found=false y solo las variables del sistema', async () => {
    tmp = await tempDir('env-test-');
    expect(readEnv({ envFile: path.join(tmp.dir, '.env'), env: { A: '1' } })).toEqual({ envFile: path.join(tmp.dir, '.env'), found: false, values: { A: '1' } });
  });

  it('rutas: logs de pm2 y del lanzador junto al log del bot', () => {
    const logFile = path.resolve('/tmp/x/logs/bot.log');
    const paths = launcherPaths({ LOG_FILE: logFile, DB_PATH: '/tmp/x/bot.db' });
    expect(paths).toMatchObject({
      logFile, logDir: path.dirname(logFile),
      pm2LogDir: path.join(path.dirname(logFile), 'pm2'),
      launcherLog: path.join(path.dirname(logFile), 'lanzador.log'),
      dbPath: path.resolve('/tmp/x/bot.db'),
    });
  });
});

describe('config del bot', () => {
  it('sin .env: LauncherError con cómo crearlo', () => {
    const err = (() => { try { requireBotConfig({ found: false, values: {} }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(LauncherError);
    expect(err.hint).toMatch(/El lanzador nunca lo crea ni lo modifica/);
  });

  it('inválido: el mensaje del bot, sin valores (tampoco las keys)', () => {
    const values = { STRATEGY: 'sma-cross', BINANCE_ENV: 'mainnet', BINANCE_API_KEY: SECRET_KEY, BINANCE_API_SECRET: SECRET_SECRET, MAX_TRADE_USDT: SECRET_KEY };
    const err = (() => { try { requireBotConfig({ found: true, values }); } catch (e) { return e; } })();
    expect(err.message).toMatch(/^El \.env tiene errores\. Configuración inválida:/);
    expect(err.message).toMatch(/BINANCE_ENV/);
    expect(err.message).toMatch(/MAX_TRADE_USDT/);
    expect(err.message).not.toContain(SECRET_KEY);
    expect(err.message).not.toContain(SECRET_SECRET);
  });

  it('válido: la config completa, y un resumen sin keys', () => {
    const config = requireBotConfig({ found: true, values: { STRATEGY: 'sma-cross', BINANCE_API_KEY: SECRET_KEY, BINANCE_API_SECRET: SECRET_SECRET } });
    expect(config).toMatchObject({ env: 'testnet', dryRun: true, mode: 'dry-run' });
    const summary = describeSetup(config);
    expect(summary).toBe('Entorno: testnet · DRY_RUN: activado (órdenes simuladas) · Par: BTC/USDT 15m · Estrategia: sma-cross');
    expect(summary).not.toContain(SECRET_KEY);
    expect(describeSetup({ ...config, dryRun: false })).toMatch(/DRY_RUN: DESACTIVADO \(envía órdenes al exchange\)/);
  });
});

describe('interfaz del panel compilada', () => {
  const setup = async () => {
    tmp = await tempDir('web-test-');
    const webRoot = tmp.dir;
    fs.mkdirSync(path.join(webRoot, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'src', 'lib', 'a.js'), '');
    fs.writeFileSync(path.join(webRoot, 'index.html'), '');
    return webRoot;
  };
  const touch = (file, secondsAgo) => {
    const t = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, t, t);
  };

  it('sin dist: no compilada', async () => {
    const webRoot = await setup();
    expect(panelBuildState({ webRoot })).toEqual({ built: false, outdated: true });
  });

  it('dist más nuevo que todo el código: al día; un archivo más nuevo (aunque esté en una subcarpeta): desactualizada', async () => {
    const webRoot = await setup();
    fs.mkdirSync(path.join(webRoot, 'dist'));
    const index = path.join(webRoot, 'dist', 'index.html');
    fs.writeFileSync(index, '');
    touch(path.join(webRoot, 'src', 'lib', 'a.js'), 100);
    touch(path.join(webRoot, 'index.html'), 100);
    touch(index, 10);
    expect(panelBuildState({ webRoot })).toEqual({ built: true, outdated: false });
    touch(path.join(webRoot, 'src', 'lib', 'a.js'), 1);
    expect(panelBuildState({ webRoot })).toEqual({ built: true, outdated: true });
  });

  it('la carpeta de la interfaz es la misma que sirve el panel', () => {
    expect(path.resolve(WEB_ROOT)).toBe(path.resolve(PANEL_WEB_ROOT));
  });
});

describe('puerto del panel', () => {
  it('libre, nuestro panel (el real) u otro programa', async () => {
    const ctx = await setupPanel();
    try {
      expect(await probePanel(ctx.port)).toBe('ours');
    } finally {
      await ctx.cleanup();
    }
    const other = http.createServer((req, res) => res.end('<html>otra cosa</html>'));
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    const { port } = other.address();
    expect(await probePanel(port)).toBe('other');
    // Un JSON que no es el del panel tampoco cuenta.
    other.removeAllListeners('request');
    other.on('request', (req, res) => res.end(JSON.stringify({ panel: { readOnly: false } })));
    expect(await probePanel(port)).toBe('other');
    await new Promise((resolve) => other.close(resolve));
    expect(await probePanel(port)).toBe('free');
  });

  it('algo que acepta la conexión pero no responde: ocupado', async () => {
    const silent = http.createServer(() => {}); // nunca responde
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    expect(await probePanel(silent.address().port, { timeoutMs: 200 })).toBe('other');
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  });
});

describe('estado del bot en la base (solo lectura)', () => {
  const scope = { env: 'testnet', mode: 'dry-run' };

  it('base inexistente: no la crea; solo sabe del archivo STOP', async () => {
    tmp = await tempDir('state-test-');
    const dbPath = path.join(tmp.dir, 'bot.db');
    const killSwitchFile = path.join(tmp.dir, 'STOP');
    new KillSwitch(killSwitchFile).activate('prueba');
    const state = readBotState({ dbPath, killSwitchFile, scope, now: Date.now() });
    expect(state).toMatchObject({ available: false, state: 'never', killSwitch: { active: true, file: { reason: 'prueba' } }, halt: { halted: false } });
    expect(state.database.state).toBe('missing');
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(haltedScopes(dbPath)).toEqual([]);
  });

  it('con base: estado, parada y paradas de todos los ámbitos', async () => {
    tmp = await tempDir('state-test-');
    const dbPath = path.join(tmp.dir, 'bot.db');
    const db = openDatabase(dbPath);
    new RiskStore(db, scope).setHalt({ code: 'KILL_SWITCH', reason: 'x', time: Date.now() });
    new RiskStore(db, { env: 'demo', mode: 'exchange' }).setHalt({ code: 'DAILY_LOSS', reason: 'y', time: Date.now() });
    const state = readBotState({ dbPath, killSwitchFile: path.join(tmp.dir, 'STOP'), scope, now: Date.now() });
    expect(state).toMatchObject({ available: true, state: 'never', halt: { halted: true, code: 'KILL_SWITCH' }, killSwitch: { active: true, file: null } });
    expect(haltedScopes(dbPath).map((s) => [s.env, s.mode, s.code])).toEqual([['testnet', 'dry-run', 'KILL_SWITCH'], ['demo', 'exchange', 'DAILY_LOSS']]);
    db.close();
  });

  it('botLooksAlive: arrancando, en marcha o apagándose (con heartbeat reciente)', () => {
    for (const s of ['starting', 'running', 'stopping']) expect(botLooksAlive({ state: s })).toBe(true);
    for (const s of ['never', 'stopped', 'unresponsive']) expect(botLooksAlive({ state: s })).toBe(false);
  });
});

describe('consola', () => {
  it('confirmación: sin importar mayúsculas, tildes ni espacios; nada más', () => {
    for (const ok of ['SI', 'si', 'Sí', ' sí ', 'SÍ']) expect(matchesWord(ok, 'SI')).toBe(true);
    for (const no of ['', 's', 'sii', 'no', 'si por favor', undefined, null]) expect(matchesWord(no, 'SI')).toBe(false);
    expect(matchesWord('reanudar', 'REANUDAR')).toBe(true);
    expect(matchesWord('REANUDA', 'REANUDAR')).toBe(false);
  });

  it('confirm lee lo que se escribe y muestra la pregunta', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let shown = '';
    stdout.on('data', (c) => { shown += c; });
    const ui = createConsoleUi({ stdin, stdout, color: false });
    const answer = ui.confirm({ word: 'REANUDAR', prompt: 'Escribe REANUDAR: ' });
    stdin.write('reanudar\n');
    expect(await answer).toBe(true);
    expect(shown).toMatch(/Escribe REANUDAR: /);
    const denied = ui.confirm({ word: 'SI' });
    stdin.end(); // sin respuesta (ventana cerrada): cancela
    expect(await denied).toBe(false);
  });

  it('mensajes con etiquetas (sin símbolos que la consola clásica no muestra) y sin esperar si no es interactiva', async () => {
    const stdout = new PassThrough();
    let shown = '';
    stdout.on('data', (c) => { shown += c; });
    const ui = createConsoleUi({ stdin: new PassThrough(), stdout, color: false });
    ui.ok('listo');
    ui.warn('cuidado');
    ui.error('falló');
    await ui.waitKey();
    await ui.closeIn(5);
    expect(shown).toBe('OK     listo\nAVISO  cuidado\nERROR  falló\n');
    expect(ui.interactive).toBe(false);
  });
});
