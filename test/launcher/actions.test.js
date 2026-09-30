/**
 * Acciones del lanzador con pm2 y consola simulados, sobre una base real
 * (los stores del bot) y un .env temporal con API keys centinela.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KILL_REASON, WORDS, lastProblems } from '../../launcher/lib/actions.js';
import { LauncherError } from '../../launcher/lib/checks.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { SECRET_KEY, SECRET_SECRET, botRunningOutside, botStarts, setupLauncher } from './support.js';

let ctx;
afterEach(() => ctx?.cleanup());

const noSecrets = (text) => {
  expect(text).not.toContain(SECRET_KEY);
  expect(text).not.toContain(SECRET_SECRET);
};
const rejects = async (promise) => {
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(LauncherError);
  return err;
};
/** Un bot que arranca bien: al iniciarlo en pm2, escribe su estado con el pid del proceso. */
const healthyBot = () => ({ onStart: { 'binance-bot': (app) => botStarts(ctx, app) } });

describe('Iniciar bot', () => {
  it('sin .env: explica cómo crearlo y no inicia nada', async () => {
    ctx = await setupLauncher({ writeEnv: false });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('Falta el archivo .env en la carpeta del proyecto.');
    expect(err.hint).toMatch(/Copia \.env\.example como \.env/);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('.env con errores: muestra el mismo mensaje del bot, sin valores secretos, y no inicia nada', async () => {
    ctx = await setupLauncher({ envLines: ['BINANCE_ENV=mainnet'] });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toMatch(/^El \.env tiene errores\. Configuración inválida:\n {2}- BINANCE_ENV/);
    expect(err.hint).toMatch(/el lanzador no lo modifica/);
    noSecrets(`${err.message}\n${ctx.ui.text()}`);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('arranca en segundo plano, espera a que el bot diga "en marcha" y activa la rotación de logs', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    const result = await ctx.launcher.startBot();
    expect(result).toEqual({ ok: true });
    expect(ctx.pm2.started()).toEqual(['binance-bot', 'binance-logs']);
    expect(ctx.ui.text()).toMatch(/Entorno: testnet · DRY_RUN: activado \(órdenes simuladas\) · Par: BTC\/USDT 1m · Estrategia: sma-cross/);
    expect(ctx.ui.text()).toMatch(/\[ok\] Bot en marcha en testnet\/dry-run \(dry-run: órdenes simuladas\)/);
    expect(ctx.ui.asked).toEqual([]); // en dry-run no pide confirmación
    expect(ctx.journal.lines.at(-1)).toMatchObject({ action: 'start-bot', outcome: 'ok', msg: 'Bot iniciado desde el lanzador' });
    noSecrets(ctx.ui.text());
  });

  it('si pm2 tenía el bot detenido o con errores, lo quita y lo inicia de cero', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    ctx.pm2.set('binance-bot', { status: 'errored', restarts: 10 });
    expect(await ctx.launcher.startBot()).toEqual({ ok: true });
    expect(ctx.pm2.calls.filter((c) => c[0] !== 'list')).toEqual([['remove', 'binance-bot'], ['start', 'binance-bot'], ['start', 'binance-logs']]);
  });

  it('la rotación que ya corre no se reinicia', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    ctx.pm2.set('binance-logs', {});
    await ctx.launcher.startBot();
    expect(ctx.pm2.started()).toEqual(['binance-bot']);
  });

  describe('DRY_RUN=false', () => {
    it('pide escribir OPERAR; cualquier otra cosa cancela sin iniciar', async () => {
      ctx = await setupLauncher({ envLines: ['DRY_RUN=false'], answers: ['si'], pm2: healthyBot() });
      expect(await ctx.launcher.startBot()).toEqual({ ok: true, cancelled: true });
      expect(ctx.ui.asked).toEqual([expect.stringMatching(/^Escribe OPERAR y presiona Enter/)]);
      expect(ctx.ui.text()).toMatch(/DRY_RUN está DESACTIVADO/);
      expect(ctx.ui.text()).toMatch(/no verás la cuenta regresiva de 5 s/);
      expect(ctx.pm2.started()).toEqual([]);
    });

    it('con OPERAR (sin importar mayúsculas) inicia en modo exchange', async () => {
      ctx = await setupLauncher({
        envLines: ['DRY_RUN=false'], answers: [' operar '],
        pm2: { onStart: { 'binance-bot': (app) => botStarts(ctx, app, { env: 'testnet', mode: 'exchange' }) } },
      });
      expect(await ctx.launcher.startBot()).toEqual({ ok: true });
      expect(WORDS.orders).toBe('OPERAR');
      expect(ctx.ui.text()).toMatch(/Bot en marcha en testnet\/exchange \(enviando órdenes al exchange\)/);
    });

    it('el inicio automático NUNCA lo arranca (ni pregunta: no hay nadie para confirmar)', async () => {
      ctx = await setupLauncher({ envLines: ['DRY_RUN=false'], answers: ['OPERAR'], pm2: healthyBot() });
      const err = await rejects(ctx.launcher.startBot({ unattended: true }));
      expect(err.message).toBe('DRY_RUN=false: el inicio automático nunca arranca el bot en ese modo.');
      expect(ctx.ui.asked).toEqual([]);
      expect(ctx.pm2.started()).toEqual([]);
    });
  });

  it('con el kill switch activo no inicia y explica cómo reanudar', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    new KillSwitch(ctx.files.killSwitchFile).activate('mantenimiento');
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('El bot está detenido en testnet/dry-run y no puede iniciarse.');
    expect(err.hint).toBe('Para volver a operar: "Reanudar bot" y después "Iniciar bot".');
    expect(ctx.ui.text()).toMatch(/\[warn\] Kill switch ACTIVO \(archivo STOP\): mantenimiento/);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('con una parada guardada (p. ej. pérdida diaria) no inicia', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    ctx.risk().setHalt({ code: 'DAILY_LOSS', reason: 'pérdida del día −21 USDT', time: ctx.now() - 60_000 });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toMatch(/está detenido en testnet\/dry-run/);
    expect(ctx.ui.text()).toMatch(/\[warn\] Detenido desde .* \(DAILY_LOSS\): pérdida del día −21 USDT/);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('una parada de OTRO ámbito no impide iniciar el del .env', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    ctx.risk({ env: 'demo', mode: 'dry-run' }).setHalt({ code: 'DAILY_LOSS', reason: 'demo', time: ctx.now() });
    expect(await ctx.launcher.startBot()).toEqual({ ok: true });
  });

  it('si ya corre en pm2, no inicia otro', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    ctx.pm2.set('binance-bot', { since: ctx.now() - 2 * 3_600_000 });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('El bot ya está corriendo desde el lanzador (desde hace 2 h).');
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('si corre FUERA del lanzador (npm start en una terminal), no inicia otro', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    botRunningOutside(ctx, { heartbeatAgoMs: 20_000 });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toMatch(/^El bot ya está corriendo fuera del lanzador .*: último heartbeat hace 20 s\.$/);
    expect(err.hint).toMatch(/para no tener dos bots a la vez/);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('si el registro dice "corriendo" pero sin heartbeat hace rato (cierre de golpe), avisa e inicia', async () => {
    ctx = await setupLauncher({ pm2: healthyBot() });
    botRunningOutside(ctx, { heartbeatAgoMs: 10 * 60_000 });
    expect(await ctx.launcher.startBot()).toEqual({ ok: true });
    expect(ctx.ui.text()).toMatch(/\[warn\] El último registro dice que el bot corría, pero su último heartbeat fue hace 10 min/);
  });

  it('arranque rechazado (código 3): muestra el motivo guardado por el bot y que no se reinicia solo', async () => {
    ctx = await setupLauncher({
      pm2: {
        onStart: {
          'binance-bot': (app) => {
            ctx.status().start({ time: ctx.now(), pid: app.pid, heartbeatMs: 60_000, strategy: 'sma-cross', params: {}, symbol: 'BTC/USDT', timeframe: '1m' });
            ctx.status().stopped({ time: ctx.now(), reason: 'no arrancó: paso 4/5 (Reconciliación): 1 diferencia(s) con el exchange', exitCode: 3 });
            Object.assign(app, { status: 'stopped', exitCode: 3, pid: null });
          },
        },
      },
    });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('El bot no arrancó: paso 4/5 (Reconciliación): 1 diferencia(s) con el exchange');
    expect(err.hint).toMatch(/Se detuvo a propósito \(código 3\) y no se reinicia solo/);
    expect(ctx.journal.lines.at(-1)).toMatchObject({ action: 'start-bot', outcome: 'stopped' });
  });

  it('si falla antes de guardar su estado (pasos 1-2), el motivo sale del log de pm2', async () => {
    ctx = await setupLauncher({
      pm2: {
        onStart: {
          'binance-bot': (app) => {
            const outLog = path.join(ctx.tmp.dir, 'bot.out.log');
            fs.writeFileSync(outLog, [
              '2026-09-29 12:00:00: {"level":30,"msg":"[1/5] Configuración y entorno…"}',
              '2026-09-29 12:00:01: {"level":60,"msg":"El bot no arranca: paso 1/5 (Configuración y entorno): testnet.binance.vision rechazó las API keys"}',
              '2026-09-29 12:00:01: {"level":40,"msg":"Arranque rechazado (código 3): … No se reinicia solo: revisa el motivo antes de volver a iniciarlo."}',
            ].join('\n'));
            Object.assign(app, { status: 'stopped', exitCode: 3, outLog });
          },
        },
      },
    });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toMatch(/^El bot no arrancó: El bot no arranca: paso 1\/5 .*rechazó las API keys \/ Arranque rechazado \(código 3\)/);
  });

  it('si se cae al arrancar (código 1) y pm2 lo reintenta, lo dice', async () => {
    ctx = await setupLauncher({ pm2: { onStart: { 'binance-bot': (app) => { Object.assign(app, { status: 'waiting restart', restarts: 1 }); } } } });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toMatch(/^El bot se cayó al arrancar: /);
    expect(err.hint).toMatch(/reintentando con espera creciente/);
  });

  it('si tarda más de 90 s en quedar en marcha, lo dice sin quedarse esperando para siempre', async () => {
    ctx = await setupLauncher(); // pm2 lo deja "online" pero el bot nunca escribe "running"
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('El bot sigue arrancando después de 90 s.');
  });

  it('un "en marcha" NUEVO pero de otro proceso (otro pid) no cuenta como éxito del que inició pm2', async () => {
    ctx = await setupLauncher({ pm2: { onStart: { 'binance-bot': (app) => botStarts(ctx, { pid: app.pid + 1 }) } } });
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('El bot sigue arrancando después de 90 s.');
  });

  it('un estado "running" de un arranque ANTERIOR (otro pid) no cuenta como éxito', async () => {
    ctx = await setupLauncher();
    botRunningOutside(ctx, { heartbeatAgoMs: 10 * 60_000, pid: 1 }); // viejo, sin responder
    const err = await rejects(ctx.launcher.startBot());
    expect(err.message).toBe('El bot sigue arrancando después de 90 s.');
  });
});

describe('Detener bot', () => {
  const stopsCleanly = (exitCode = 0, reason = 'señal SIGINT') => ({
    onRemove: { 'binance-bot': () => ctx.status().stopped({ time: ctx.now(), reason, exitCode }) },
  });

  it('apagado ordenado vía pm2; si no queda nada corriendo, apaga la rotación y el daemon', async () => {
    ctx = await setupLauncher({ pm2: stopsCleanly() });
    botRunningOutside(ctx);
    ctx.pm2.set('binance-bot', {});
    ctx.pm2.set('binance-logs', {});
    expect(await ctx.launcher.stopBot()).toEqual({ ok: true });
    expect(ctx.ui.text()).toMatch(/Apagado ordenado \(igual que Ctrl\+C\): .*NO vende las posiciones abiertas/);
    expect(ctx.ui.text()).toMatch(/\[ok\] Bot detenido \(apagado ordenado\)\./);
    expect(ctx.pm2.calls.filter((c) => c[0] !== 'list')).toEqual([['remove', 'binance-bot'], ['remove', 'binance-logs'], ['kill']]);
  });

  it('con el panel corriendo, la rotación y el daemon siguen', async () => {
    ctx = await setupLauncher({ pm2: stopsCleanly() });
    botRunningOutside(ctx);
    ctx.pm2.set('binance-bot', {});
    ctx.pm2.set('binance-panel', {});
    ctx.pm2.set('binance-logs', {});
    await ctx.launcher.stopBot();
    expect(ctx.pm2.removed()).toEqual(['binance-bot']);
    expect(ctx.pm2.calls.some((c) => c[0] === 'kill')).toBe(false);
  });

  it('si al detenerse queda registrado otro motivo, lo muestra', async () => {
    ctx = await setupLauncher({ pm2: stopsCleanly(3, 'kill switch: mantenimiento') });
    botRunningOutside(ctx);
    ctx.pm2.set('binance-bot', {});
    await ctx.launcher.stopBot();
    expect(ctx.ui.text()).toMatch(/\[ok\] Bot detenido: kill switch: mantenimiento \(detenido a propósito/);
  });

  it('si el proceso terminó sin registrar el apagado, lo advierte', async () => {
    ctx = await setupLauncher();
    botRunningOutside(ctx);
    ctx.pm2.set('binance-bot', {});
    await ctx.launcher.stopBot();
    expect(ctx.ui.text()).toMatch(/\[warn\] El proceso del bot terminó, pero no quedó registrado un apagado ordenado/);
  });

  it('si corre en una terminal, explica que se detiene ahí con Ctrl+C', async () => {
    ctx = await setupLauncher();
    botRunningOutside(ctx);
    const err = await rejects(ctx.launcher.stopBot());
    expect(err.message).toMatch(/corriendo fuera del lanzador \(en una terminal\)/);
    expect(err.hint).toBe('Detenlo en esa terminal con Ctrl+C, o usa "Kill switch".');
    expect(ctx.pm2.removed()).toEqual([]);
  });

  it('si no corre, lo dice (y limpia un proceso detenido de la lista de pm2)', async () => {
    ctx = await setupLauncher();
    ctx.pm2.set('binance-bot', { status: 'stopped', exitCode: 3 });
    expect(await ctx.launcher.stopBot()).toEqual({ ok: true });
    expect(ctx.ui.text()).toMatch(/\[ok\] El bot no está corriendo: no hay nada que detener\./);
    expect(ctx.pm2.calls.filter((c) => c[0] !== 'list')).toEqual([['remove', 'binance-bot'], ['kill']]);
  });
});

describe('Iniciar panel', () => {
  it('compila la interfaz si falta, lo inicia, espera a que responda y abre el navegador', async () => {
    let answers = 0;
    ctx = await setupLauncher({
      deps: {
        buildState: () => ({ built: false, outdated: true }),
        probe: async () => (ctx.pm2.apps.has('binance-panel') && ++answers > 1 ? 'ours' : 'free'),
      },
    });
    expect(await ctx.launcher.startPanel()).toEqual({ ok: true });
    expect(ctx.buildPanel).toHaveBeenCalledTimes(1);
    expect(ctx.ui.text()).toMatch(/Falta compilar la interfaz del panel: compilando/);
    expect(ctx.pm2.started()).toEqual(['binance-panel', 'binance-logs']);
    expect(ctx.openBrowser).toHaveBeenCalledWith('http://127.0.0.1:8799');
    expect(ctx.ui.text()).toMatch(/\[ok\] Panel en marcha: http:\/\/127\.0\.0\.1:8799/);
  });

  it('recompila si el código de la interfaz cambió; si está al día, no', async () => {
    ctx = await setupLauncher({ deps: { buildState: () => ({ built: true, outdated: true }), probe: async () => (ctx.pm2.apps.has('binance-panel') ? 'ours' : 'free') } });
    await ctx.launcher.startPanel();
    expect(ctx.buildPanel).toHaveBeenCalledTimes(1);
    expect(ctx.ui.text()).toMatch(/La interfaz cambió desde la última compilación/);
    ctx.cleanup();
    ctx = await setupLauncher({ deps: { probe: async () => (ctx.pm2.apps.has('binance-panel') ? 'ours' : 'free') } });
    await ctx.launcher.startPanel();
    expect(ctx.buildPanel).not.toHaveBeenCalled();
  });

  it('si ya corre (en pm2 o en una terminal), solo abre el navegador', async () => {
    ctx = await setupLauncher({ deps: { probe: async () => 'ours' } });
    ctx.pm2.set('binance-panel', {});
    await ctx.launcher.startPanel();
    expect(ctx.ui.text()).toMatch(/El panel ya estaba corriendo: http:\/\/127\.0\.0\.1:8799/);
    ctx.pm2.apps.clear();
    await ctx.launcher.startPanel();
    expect(ctx.ui.text()).toMatch(/fuera del lanzador \(en una terminal\)/);
    expect(ctx.openBrowser).toHaveBeenCalledTimes(2);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('puerto ocupado por otro programa: explica qué hacer sin tocar el .env', async () => {
    ctx = await setupLauncher({ deps: { probe: async () => 'other' } });
    const err = await rejects(ctx.launcher.startPanel());
    expect(err.message).toBe('El puerto 8799 está ocupado por otro programa.');
    expect(err.hint).toMatch(/cambia PANEL_PORT en el \.env \(el lanzador no cambia la configuración\)/);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('si no compila, no inicia el panel', async () => {
    ctx = await setupLauncher({ deps: { buildState: () => ({ built: false, outdated: true }) } });
    ctx.buildPanel.mockRejectedValue(new LauncherError('No se pudo compilar la interfaz del panel:\nerror de sintaxis'));
    const err = await rejects(ctx.launcher.startPanel());
    expect(err.message).toMatch(/No se pudo compilar/);
    expect(ctx.pm2.started()).toEqual([]);
  });

  it('si el panel no arranca (p. ej. se cae), muestra el motivo del log', async () => {
    const outLog = path.join((await import('node:os')).tmpdir(), `panel-out-${process.pid}.log`);
    fs.writeFileSync(outLog, '2026-09-29 12:00:00: {"level":60,"msg":"El panel no arranca: listen EADDRINUSE"}\n');
    ctx = await setupLauncher({ pm2: { onStart: { 'binance-panel': (app) => { Object.assign(app, { status: 'errored', outLog }); } } } });
    const err = await rejects(ctx.launcher.startPanel());
    fs.rmSync(outLog);
    expect(err.message).toBe('El panel no arrancó: El panel no arranca: listen EADDRINUSE');
  });
});

describe('Detener panel', () => {
  it('lo detiene; si el bot sigue, la rotación sigue', async () => {
    ctx = await setupLauncher();
    ctx.pm2.set('binance-panel', {});
    ctx.pm2.set('binance-bot', {});
    ctx.pm2.set('binance-logs', {});
    expect(await ctx.launcher.stopPanel()).toEqual({ ok: true });
    expect(ctx.pm2.removed()).toEqual(['binance-panel']);
    expect(ctx.ui.text()).toMatch(/Panel detenido \(el bot no se ve afectado\)/);
  });

  it('si corre en una terminal, explica que se cierra ahí', async () => {
    ctx = await setupLauncher({ deps: { probe: async () => 'ours' } });
    const err = await rejects(ctx.launcher.stopPanel());
    expect(err.hint).toBe('Ciérralo en esa terminal con Ctrl+C.');
  });

  it('si no corre, lo dice', async () => {
    ctx = await setupLauncher();
    expect(await ctx.launcher.stopPanel()).toEqual({ ok: true });
    expect(ctx.ui.text()).toMatch(/El panel no está corriendo/);
  });
});

describe('Estado del bot', () => {
  it('procesos, config (sin keys), estado del bot y el riesgo de npm run status; espera una tecla', async () => {
    ctx = await setupLauncher();
    botRunningOutside(ctx, { heartbeatAgoMs: 12_000 });
    ctx.pm2.set('binance-bot', { since: ctx.now() - 5 * 60_000 });
    ctx.pm2.set('binance-panel', { since: ctx.now() - 60 * 60_000 });
    const result = await ctx.launcher.status();
    expect(result).toEqual({ ok: true, keepOpen: true });
    const text = ctx.ui.text();
    expect(text).toMatch(/Bot {5}corriendo \(desde hace 5 min\) · reinicios: 0/);
    expect(text).toMatch(/Panel {3}corriendo \(desde hace 1 h\) · reinicios: 0 · http:\/\/127\.0\.0\.1:8799/);
    expect(text).toMatch(/Logs {4}detenido/);
    expect(text).toMatch(/Entorno: testnet · DRY_RUN: activado/);
    expect(text).toMatch(/\[ok\] En marcha · último heartbeat hace 12 s$/m);
    expect(ctx.runScript).toHaveBeenCalledWith('scripts/status.js');
    noSecrets(text);
  });

  it('detenido a propósito (código 3): lo dice, con el motivo, y que no se reinicia solo', async () => {
    ctx = await setupLauncher();
    ctx.status().start({ time: ctx.now() - 60_000, pid: 1, heartbeatMs: 60_000, strategy: 'sma-cross', params: {}, symbol: 'BTC/USDT', timeframe: '1m' });
    ctx.status().stopped({ time: ctx.now() - 30_000, reason: 'kill switch: kill switch desde el panel', exitCode: 3 });
    ctx.risk().setHalt({ code: 'KILL_SWITCH', reason: 'kill switch desde el panel', time: ctx.now() - 30_000 });
    ctx.pm2.set('binance-bot', { status: 'stopped', exitCode: 3 });
    await ctx.launcher.status();
    const text = ctx.ui.text();
    expect(text).toMatch(/Bot {5}detenido: detenido a propósito \(requiere intervención; no se reinicia solo\)/);
    expect(text).toMatch(/\[warn\] Detenido a propósito \(.*\): kill switch: kill switch desde el panel/);
    expect(text).toMatch(/Código 3: no se reinicia solo/);
    expect(text).toMatch(/\[warn\] Detenido desde .* \(KILL_SWITCH\)/);
    expect(text).toMatch(/Para volver a operar: "Reanudar bot" y después "Iniciar bot"\./);
  });

  it('caída (código 1) y pm2 reintentando; o pm2 que se rindió', async () => {
    ctx = await setupLauncher();
    ctx.status().start({ time: ctx.now() - 60_000, pid: 1, heartbeatMs: 60_000, strategy: 'sma-cross', params: {}, symbol: 'BTC/USDT', timeframe: '1m' });
    ctx.status().stopped({ time: ctx.now() - 30_000, reason: '3 errores seguidos procesando velas', exitCode: 1 });
    ctx.pm2.set('binance-bot', { status: 'waiting restart', restarts: 2 });
    await ctx.launcher.status();
    expect(ctx.ui.text()).toMatch(/Bot {5}se cayó; pm2 lo reinicia con espera creciente \(reinicios: 2\)/);
    expect(ctx.ui.text()).toMatch(/\[warn\] Detenido por una caída \(.*\): 3 errores seguidos procesando velas \(caída inesperada\)/);
    ctx.pm2.set('binance-bot', { status: 'errored', restarts: 10 });
    await ctx.launcher.status();
    expect(ctx.ui.text()).toMatch(/con errores: pm2 dejó de reiniciarlo tras 10 reinicios seguidos/);
  });

  it('bot sin responder y bot que nunca corrió', async () => {
    ctx = await setupLauncher();
    await ctx.launcher.status();
    expect(ctx.ui.text()).toMatch(/Nunca corrió en este entorno y modo\./);
    botRunningOutside(ctx, { heartbeatAgoMs: 5 * 60_000 });
    await ctx.launcher.status();
    expect(ctx.ui.text()).toMatch(/\[warn\] Sin responder: el último heartbeat fue hace 5 min/);
  });

  it('un bot en marcha que pm2 no conoce se muestra como "fuera del lanzador"', async () => {
    ctx = await setupLauncher();
    botRunningOutside(ctx);
    await ctx.launcher.status();
    expect(ctx.ui.text()).toMatch(/corre FUERA del lanzador \(en una terminal\)/);
  });

  it('con el .env inválido lo muestra y no corre npm run status', async () => {
    ctx = await setupLauncher({ envLines: ['MAX_TRADE_USDT=-5'] });
    await ctx.launcher.status();
    expect(ctx.ui.text()).toMatch(/\[error\] El \.env tiene errores\. .*MAX_TRADE_USDT/s);
    expect(ctx.runScript).not.toHaveBeenCalled();
    noSecrets(ctx.ui.text());
  });
});

describe('Kill switch', () => {
  it('pide escribir SI; otra cosa cancela y no ejecuta nada', async () => {
    ctx = await setupLauncher({ answers: ['no'] });
    expect(await ctx.launcher.kill()).toEqual({ ok: true, cancelled: true });
    expect(ctx.ui.asked).toEqual([expect.stringMatching(/^Escribe SI y presiona Enter para activarlo/)]);
    expect(ctx.ui.text()).toMatch(/TODOS los entornos y modos/);
    expect(ctx.ui.text()).toMatch(/NO vende ni cierra las posiciones abiertas/);
    expect(ctx.runScript).not.toHaveBeenCalled();
  });

  it('con "sí" usa el mismo script que npm run kill y espera a que el bot se detenga', async () => {
    ctx = await setupLauncher({ answers: ['sí'] });
    botRunningOutside(ctx);
    ctx.pm2.set('binance-bot', {});
    ctx.runScript.mockImplementation(async () => {
      // el bot detecta el archivo STOP en ~1 s y se detiene con código 3 (antes de que el lanzador vuelva a mirar)
      ctx.status().stopped({ time: ctx.now(), reason: `kill switch: ${KILL_REASON}`, exitCode: 3 });
      Object.assign(ctx.pm2.apps.get('binance-bot'), { status: 'stopped', exitCode: 3 });
      return { code: 0 };
    });
    expect(await ctx.launcher.kill()).toEqual({ ok: true });
    expect(ctx.ui.text()).toMatch(/Esperando a que el bot se detenga…/);
    expect(ctx.runScript).toHaveBeenCalledWith('scripts/kill.js', ['kill switch desde el acceso directo del escritorio']);
    expect(ctx.ui.text()).toMatch(/\[ok\] Bot detenido: kill switch: kill switch desde el acceso directo del escritorio\. No se reinicia solo\./);
    expect(ctx.journal.lines.at(-1)).toMatchObject({ action: 'kill', outcome: 'ok' });
  });

  it('con el bot detenido, igual lo activa (no podrá iniciarse hasta reanudar)', async () => {
    ctx = await setupLauncher({ answers: ['SI'] });
    expect(await ctx.launcher.kill()).toEqual({ ok: true });
    expect(ctx.ui.text()).toMatch(/El bot no estaba corriendo: no podrá iniciarse hasta reanudarlo/);
  });

  it('si el bot no se detiene a tiempo, lo dice', async () => {
    ctx = await setupLauncher({ answers: ['SI'] });
    ctx.pm2.set('binance-bot', {});
    const err = await rejects(ctx.launcher.kill());
    expect(err.message).toBe('El bot no se detuvo en 120 s.');
  });

  it('si el script falla, lo informa', async () => {
    ctx = await setupLauncher({ answers: ['SI'] });
    ctx.runScript.mockResolvedValue({ code: 1 });
    const err = await rejects(ctx.launcher.kill());
    expect(err.message).toMatch(/El comando del kill switch falló/);
  });
});

describe('Reanudar bot', () => {
  it('si no hay nada que reanudar, lo dice sin pedir confirmación', async () => {
    ctx = await setupLauncher();
    expect(await ctx.launcher.resume()).toEqual({ ok: true });
    expect(ctx.ui.asked).toEqual([]);
    expect(ctx.ui.text()).toMatch(/No hay nada que reanudar: el bot no está detenido en testnet\/dry-run/);
    expect(ctx.runScript).not.toHaveBeenCalled();
  });

  it('muestra la parada, qué ámbito se reanuda y cuáles siguen detenidos; exige REANUDAR', async () => {
    ctx = await setupLauncher({ answers: ['reanudar ahora'] });
    new KillSwitch(ctx.files.killSwitchFile).activate('mantenimiento');
    for (const scope of [{ env: 'testnet', mode: 'dry-run' }, { env: 'demo', mode: 'exchange' }]) {
      ctx.risk(scope).setHalt({ code: 'KILL_SWITCH', reason: 'kill switch: mantenimiento', time: ctx.now() });
    }
    expect(await ctx.launcher.resume()).toEqual({ ok: true, cancelled: true });
    const text = ctx.ui.text();
    expect(text).toMatch(/Kill switch ACTIVO \(archivo STOP\): mantenimiento/);
    expect(text).toMatch(/Se reanuda SOLO testnet\/dry-run/);
    expect(text).toMatch(/Seguirán detenidos: demo\/exchange\./);
    expect(ctx.ui.asked).toEqual([expect.stringMatching(/^Escribe REANUDAR y presiona Enter/)]);
    expect(ctx.runScript).not.toHaveBeenCalled();
  });

  it('con REANUDAR usa el mismo script que npm run resume', async () => {
    ctx = await setupLauncher({ answers: ['REANUDAR'] });
    ctx.risk().setHalt({ code: 'DAILY_LOSS', reason: 'pérdida', time: ctx.now() });
    expect(await ctx.launcher.resume()).toEqual({ ok: true });
    expect(ctx.runScript).toHaveBeenCalledWith('scripts/resume.js');
    expect(ctx.ui.text()).toMatch(/Listo\. Para volver a operar, usa "Iniciar bot"\./);
  });

  it('si npm run resume se niega (p. ej. pérdida del día), lo informa', async () => {
    ctx = await setupLauncher({ answers: ['REANUDAR'] });
    ctx.risk().setHalt({ code: 'DAILY_LOSS', reason: 'pérdida', time: ctx.now() });
    ctx.runScript.mockResolvedValue({ code: 1 });
    const err = await rejects(ctx.launcher.resume());
    expect(err.message).toBe('No se reanudó (el motivo está arriba).');
  });

  it('sin .env válido no reanuda (resume necesita la config completa)', async () => {
    ctx = await setupLauncher({ writeEnv: false });
    await rejects(ctx.launcher.resume());
    expect(ctx.runScript).not.toHaveBeenCalled();
  });
});

describe('accesos directos', () => {
  it('crea la carpeta del escritorio y lista los accesos', async () => {
    ctx = await setupLauncher();
    expect(await ctx.launcher.installShortcuts()).toEqual({ ok: true });
    expect(ctx.shortcuts.state.desktop).toBe(true);
    const text = ctx.ui.text();
    expect(text).toMatch(/\[ok\] Carpeta "C:\\Users\\prueba\\Desktop\\Binance Spot Bot" con 7 accesos directos:/);
    for (const name of ['Iniciar bot', 'Detener bot', 'Iniciar panel', 'Detener panel', 'Estado del bot', 'Kill switch', 'Reanudar bot']) {
      expect(text).toContain(`[detail]   ${name}\n`);
    }
    expect(text).toMatch(/Si mueves la carpeta del proyecto, vuelve a crearlos/);
  });

  it('los quita (o dice que no había)', async () => {
    ctx = await setupLauncher();
    await ctx.launcher.removeShortcuts();
    expect(ctx.ui.text()).toMatch(/No había accesos directos que quitar/);
    await ctx.launcher.installShortcuts();
    await ctx.launcher.removeShortcuts();
    expect(ctx.ui.text()).toMatch(/Se quitaron 7 accesos directos/);
  });

  it('sin Windows (sin accesos directos) lo explica', async () => {
    ctx = await setupLauncher({ deps: { shortcuts: undefined } });
    const err = await rejects(ctx.launcher.installShortcuts());
    expect(err.message).toBe('Los accesos directos y el inicio automático solo existen en Windows.');
  });
});

describe('inicio automático', () => {
  it('activar: explica qué hará y crea el acceso en la carpeta Inicio', async () => {
    ctx = await setupLauncher();
    expect(await ctx.launcher.autostartOn()).toEqual({ ok: true });
    expect(ctx.shortcuts.state.autostart).toBe(true);
    const text = ctx.ui.text();
    expect(text).toMatch(/inicia el panel \(sin abrir el navegador\)/);
    expect(text).toMatch(/inicia el bot SOLO si DRY_RUN está activado y no hay kill switch ni parada guardada/);
    expect(text).toMatch(/al iniciar sesión, no al encender el computador/);
    expect(text).toMatch(/\[ok\] Inicio automático activado: .*Binance Spot Bot \(inicio automático\)\.lnk/);
    expect(text).toMatch(/desactivar-inicio-automatico\.bat/);
    expect(text).not.toMatch(/DRY_RUN=false/);
  });

  it('activar con DRY_RUN=false avisa que el bot no se iniciará solo', async () => {
    ctx = await setupLauncher({ envLines: ['DRY_RUN=false'] });
    await ctx.launcher.autostartOn();
    expect(ctx.ui.text()).toMatch(/\[warn\] Con tu \.env actual \(DRY_RUN=false\) el bot NO se iniciará solo: solo el panel\./);
  });

  it('desactivar: quita el acceso (o dice que no estaba) y no detiene nada', async () => {
    ctx = await setupLauncher();
    ctx.pm2.set('binance-bot', {});
    await ctx.launcher.autostartOff();
    expect(ctx.ui.text()).toMatch(/El inicio automático no estaba activado/);
    await ctx.launcher.autostartOn();
    await ctx.launcher.autostartOff();
    expect(ctx.ui.text()).toMatch(/\[ok\] Inicio automático desactivado\./);
    expect(ctx.pm2.removed()).toEqual([]);
  });

  describe('al iniciar sesión', () => {
    const panelResponds = () => ({ probe: async () => (ctx.pm2.apps.has('binance-panel') ? 'ours' : 'free') });

    it('inicia el panel SIN abrir el navegador y el bot; anota el resultado', async () => {
      ctx = await setupLauncher({ pm2: healthyBot(), deps: panelResponds() });
      expect(await ctx.launcher.autostart()).toEqual({ ok: true });
      expect(ctx.pm2.started()).toEqual(['binance-panel', 'binance-logs', 'binance-bot']);
      expect(ctx.openBrowser).not.toHaveBeenCalled();
      expect(ctx.journal.lines.at(-1)).toMatchObject({ action: 'autostart', panel: 'en marcha', bot: 'en marcha' });
    });

    it('con DRY_RUN=false: el panel sí, el bot NUNCA (y no pregunta nada)', async () => {
      ctx = await setupLauncher({ envLines: ['DRY_RUN=false'], answers: ['OPERAR'], pm2: healthyBot(), deps: panelResponds() });
      expect(await ctx.launcher.autostart()).toEqual({ ok: true });
      expect(ctx.pm2.started()).toEqual(['binance-panel', 'binance-logs']);
      expect(ctx.ui.asked).toEqual([]);
      expect(ctx.journal.lines.at(-1)).toMatchObject({
        action: 'autostart', panel: 'en marcha', bot: 'no se inició: DRY_RUN=false: el inicio automático nunca arranca el bot en ese modo.',
      });
    });

    it('con el kill switch activo: el bot no se inicia', async () => {
      ctx = await setupLauncher({ pm2: healthyBot(), deps: panelResponds() });
      new KillSwitch(ctx.files.killSwitchFile).activate('mantenimiento');
      await ctx.launcher.autostart();
      expect(ctx.pm2.started()).toEqual(['binance-panel', 'binance-logs']);
      expect(ctx.journal.lines.at(-1).bot).toMatch(/^no se inició: El bot está detenido en testnet\/dry-run/);
    });

    it('si el panel falla, igual intenta el bot (y al revés), sin lanzar errores', async () => {
      ctx = await setupLauncher({ pm2: healthyBot(), deps: { probe: async () => 'other' } });
      expect(await ctx.launcher.autostart()).toEqual({ ok: true });
      expect(ctx.pm2.started()).toEqual(['binance-bot', 'binance-logs']);
      expect(ctx.journal.lines.at(-1)).toMatchObject({ panel: 'no se inició: El puerto 8799 está ocupado por otro programa.', bot: 'en marcha' });
      ctx.cleanup();
      ctx = await setupLauncher({ deps: { probe: async () => 'other' } });
      ctx.pm2.list = async () => { throw new Error('pm2 no responde'); };
      expect(await ctx.launcher.autostart()).toEqual({ ok: true });
      expect(ctx.journal.lines.at(-1)).toMatchObject({ panel: 'no se inició: pm2 no responde', bot: 'no se inició: pm2 no responde' });
    });

    it('"Estado del bot" muestra si está activado y el último resultado', async () => {
      ctx = await setupLauncher({ envLines: ['DRY_RUN=false'], deps: { probe: async () => 'other' } });
      await ctx.launcher.status();
      expect(ctx.ui.text()).toMatch(/Inicio automático \(al iniciar sesión en Windows\)\]?\n?.*Desactivado\./);
      expect(ctx.ui.text()).not.toMatch(/Último:/);
      // Un inicio automático real deja su resultado en el log del lanzador (junto al log del bot).
      const log = path.join(path.dirname(ctx.files.logFile), 'lanzador.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, [
        JSON.stringify({ level: 30, time: '2026-09-30T11:00:00.000Z', action: 'autostart', panel: 'viejo', bot: 'viejo' }),
        'línea rota',
        JSON.stringify({ level: 30, time: '2026-09-30T12:00:00.000Z', action: 'autostart', panel: 'en marcha', bot: 'no se inició: DRY_RUN=false: …' }),
        JSON.stringify({ level: 30, time: '2026-09-30T12:05:00.000Z', action: 'status', outcome: 'ok' }),
      ].join('\n'));
      await ctx.launcher.autostartOn();
      ctx.ui.lines.length = 0;
      await ctx.launcher.status();
      expect(ctx.ui.text()).toMatch(/Activado\./);
      expect(ctx.ui.text()).toMatch(/Último: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · panel: en marcha · bot: no se inició: DRY_RUN=false: …/);
    });

    it('sin Windows, el estado no muestra la sección', async () => {
      ctx = await setupLauncher({ deps: { shortcuts: undefined } });
      await ctx.launcher.status();
      expect(ctx.ui.text()).not.toMatch(/Inicio automático/);
    });
  });
});

describe('lastProblems (motivos desde el log de pm2)', () => {
  it('toma advertencias y errores de pino (con la fecha de pm2 adelante) e ignora lo demás', async () => {
    ctx = await setupLauncher();
    const file = path.join(ctx.tmp.dir, 'x.log');
    fs.writeFileSync(file, [
      'texto suelto',
      '2026-09-29 12:00:00: {"level":30,"msg":"info"}',
      '2026-09-29 12:00:00: {"level":40,"msg":"aviso"}',
      '2026-09-29 12:00:00: {roto',
      '2026-09-29 12:00:00: {"level":50,"msg":"error"}',
      '{"level":60,"msg":"fatal"}',
    ].join('\n'));
    expect(lastProblems(file)).toEqual(['aviso', 'error', 'fatal']);
    expect(lastProblems(file, { max: 1 })).toEqual(['fatal']);
    expect(lastProblems(path.join(ctx.tmp.dir, 'no-existe.log'))).toEqual([]);
    expect(lastProblems(null)).toEqual([]);
  });
});
