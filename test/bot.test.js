/**
 * TradingBot: cola secuencial de velas y apagado ordenado.
 * El riesgo y SQLite son reales; feed, estrategia y ejecutor son simulados y
 * controlables (se puede "congelar" una orden para ver qué pasa mientras tanto).
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TradingBot } from '../src/bot.js';
import { loadConfig } from '../src/config/index.js';
import { IpBannedError } from '../src/data/rate-limiter.js';
import { KillSwitch } from '../src/risk/kill-switch.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { openDatabase } from '../src/storage/db.js';
import { BotStatusStore } from '../src/storage/bot-status-store.js';
import { RiskStore } from '../src/storage/risk-store.js';
import { captureLogger, tempDir, testEnv } from './helpers.js';

const MIN = 60_000;
const T0 = Math.floor(Date.now() / MIN) * MIN;
const candle = (i, close = 100) => ({ time: T0 + i * MIN, open: close, high: close, low: close, close, volume: 1 });

/** Promesa que el test resuelve cuando quiere. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

let ctx;
beforeEach(async () => {
  const tmp = await tempDir();
  const logs = await captureLogger();
  const db = openDatabase(':memory:');
  const config = loadConfig(testEnv({ TIMEFRAME: '1m', SHUTDOWN_TIMEOUT_SECONDS: '2', HEARTBEAT_SECONDS: '60' }));
  const killSwitch = new KillSwitch(path.join(tmp.dir, 'STOP'));
  const risk = new RiskManager({
    store: new RiskStore(db, { env: 'testnet', mode: 'dry-run' }),
    killSwitch,
    limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 },
    feeRate: 0.001, slippageBps: 5, logger: logs.logger,
  });
  const feed = Object.assign(new EventEmitter(), { getCandles: () => [candle(0)] });
  const strategy = { id: 'test', params: {}, lookback: 5, evaluate: vi.fn(() => ({ action: 'BUY', code: 'TEST', reason: 'prueba' })) };
  const executor = { submit: vi.fn(async () => ({ status: 'filled' })), cancelAll: vi.fn(async () => []) };
  const closed = [];
  const resources = ['feed', 'monitor', 'hora', 'cliente', 'base de datos'].map((name) => ({ name, close: vi.fn(() => { closed.push(name); }) }));
  const bot = new TradingBot({ config, strategy, feed, executor, risk, killSwitch, logger: logs.logger, resources });
  ctx = { bot, feed, strategy, executor, risk, logs, closed, resources, db, tmp };
});
afterEach(async () => {
  vi.useRealTimers();
  await ctx.bot.shutdown('fin de la prueba');
  ctx.db.close();
  ctx.tmp.cleanup();
});

const emit = (i, close) => ctx.feed.emit('candle', { candle: candle(i, close), source: 'ws' });
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------
describe('cola de velas: una a la vez, en orden', () => {
  it('si llegan velas mientras otra se procesa, se encolan y nunca se procesan en paralelo', async () => {
    ctx.bot.start();
    let active = 0;
    let maxActive = 0;
    const gates = [deferred(), deferred(), deferred()];
    const seen = [];
    ctx.executor.submit.mockImplementation(async ({ signalKey }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      seen.push(signalKey.split(':')[3]);
      await gates[seen.length - 1].promise;
      active--;
      return { status: 'filled' };
    });

    emit(0); emit(1); emit(2); // llegan casi juntas
    await flush();
    expect(ctx.executor.submit).toHaveBeenCalledTimes(1); // solo la primera está en proceso
    expect(ctx.bot.queue).toHaveLength(2);

    gates[0].resolve(); await flush(); await flush();
    expect(ctx.executor.submit).toHaveBeenCalledTimes(2);
    gates[1].resolve(); await flush(); await flush();
    gates[2].resolve(); await vi.waitFor(() => expect(ctx.bot.current).toBeNull());

    expect(maxActive).toBe(1);
    expect(seen).toEqual([String(T0), String(T0 + MIN), String(T0 + 2 * MIN)]); // en orden de llegada
    expect(ctx.bot.stats.processed).toBe(3);
  });

  it('cada vela pasa límites → estrategia → orden; la clave de señal identifica vela y acción', async () => {
    ctx.bot.start();
    emit(0, 84_000);
    await vi.waitFor(() => expect(ctx.executor.submit).toHaveBeenCalled());
    expect(ctx.strategy.evaluate).toHaveBeenCalledWith([candle(0)], { position: null });
    expect(ctx.executor.submit).toHaveBeenCalledWith({
      side: 'buy', signalKey: `test:BTC/USDT:1m:${T0}:BUY`, strategy: 'test', signalCode: 'TEST',
    });
  });

  it('HOLD no genera órdenes', async () => {
    ctx.strategy.evaluate.mockReturnValue({ action: 'HOLD', code: 'NO_CROSS', reason: 'nada' });
    ctx.bot.start();
    emit(0);
    await vi.waitFor(() => expect(ctx.bot.stats.processed).toBe(1));
    expect(ctx.executor.submit).not.toHaveBeenCalled();
  });

  it('una señal de una vela vieja (llegó tarde) no opera', async () => {
    ctx.bot.start();
    ctx.feed.emit('candle', { candle: candle(-10), source: 'backfill' }); // cerró hace ~9 min
    await vi.waitFor(() => expect(ctx.bot.stats.processed).toBe(1));
    expect(ctx.executor.submit).not.toHaveBeenCalled();
    expect(ctx.logs.messages().join()).toMatch(/descartada: la vela cerró hace/);
  });

  it('un error procesando una vela no detiene el ciclo; tres seguidos, sí (apagado seguro)', async () => {
    ctx.executor.submit.mockRejectedValue(new Error('fallo inesperado'));
    ctx.bot.start();
    emit(0);
    await vi.waitFor(() => expect(ctx.bot.consecutiveErrors).toBe(1));
    expect(ctx.bot.stopping).toBeNull();
    emit(1); emit(2);
    const result = await ctx.bot.stopped;
    expect(result).toMatchObject({ exitCode: 1, reason: '3 errores seguidos procesando velas' });
  });
});

// ---------------------------------------------------------------------------------
describe('apagado ordenado', () => {
  it('deja de aceptar velas, espera la operación en curso, cancela pendientes, guarda y cierra en orden', async () => {
    ctx.bot.start();
    const gate = deferred();
    ctx.executor.submit.mockImplementation(() => gate.promise.then(() => ({ status: 'filled' })));
    emit(0);
    await vi.waitFor(() => expect(ctx.executor.submit).toHaveBeenCalledTimes(1));
    emit(1); // encolada: se descarta al apagar

    let done = false;
    const stopping = ctx.bot.shutdown('Ctrl+C de prueba').then((r) => { done = true; return r; });
    emit(2); // ya apagando: se ignora
    await flush();
    expect(done).toBe(false); // espera a que termine la orden en curso
    expect(ctx.executor.cancelAll).not.toHaveBeenCalled();

    gate.resolve();
    const result = await stopping;
    expect(result).toEqual({ reason: 'Ctrl+C de prueba', exitCode: 0, timedOut: false });
    expect(ctx.executor.submit).toHaveBeenCalledTimes(1); // ni la encolada ni la tardía se procesaron
    expect(ctx.executor.cancelAll).toHaveBeenCalledTimes(1); // órdenes pendientes canceladas
    expect(ctx.closed).toEqual(['feed', 'monitor', 'hora', 'cliente', 'base de datos']);
    expect(ctx.risk.store.recentEvents(1)[0]).toMatchObject({ type: 'SHUTDOWN', code: 'NORMAL', message: 'Ctrl+C de prueba' });
    const log = ctx.logs.messages().join('\n');
    expect(log).toMatch(/Se descartan 1 vela\(s\) en cola/);
    expect(log).toMatch(/Apagando: se ignora la vela/);
    expect(log).toMatch(/Bot detenido: Ctrl\+C de prueba/);
  });

  it('si la operación en curso no termina a tiempo, sigue con el apagado y lo advierte', async () => {
    ctx.bot.start();
    ctx.executor.submit.mockImplementation(() => new Promise(() => {})); // nunca termina
    emit(0);
    await vi.waitFor(() => expect(ctx.executor.submit).toHaveBeenCalled());
    vi.useFakeTimers();
    const stopping = ctx.bot.shutdown('prueba de timeout');
    await vi.advanceTimersByTimeAsync(2000); // SHUTDOWN_TIMEOUT_SECONDS=2
    const result = await stopping;
    expect(result.timedOut).toBe(true);
    expect(ctx.logs.messages().join()).toMatch(/no terminó en 2 s: se sigue con el apagado/);
    expect(ctx.closed).toContain('base de datos');
  });

  it('NO cierra ni vende las posiciones abiertas', async () => {
    ctx.risk.recordEntry({ symbol: 'BTC/USDT', qty: 0.00059, price: 84_000 });
    ctx.bot.start();
    await ctx.bot.shutdown('prueba');
    expect(ctx.executor.submit).not.toHaveBeenCalled();
    expect(ctx.risk.store.openPositions()).toHaveLength(1);
    expect(ctx.logs.messages().join()).toMatch(/Quedan 1 posición\(es\) abierta\(s\): NO se cierran al apagar/);
  });

  it('es idempotente: un segundo pedido de apagado no repite nada', async () => {
    ctx.bot.start();
    const [a, b] = await Promise.all([ctx.bot.shutdown('uno'), ctx.bot.shutdown('dos')]);
    expect(a).toBe(b);
    expect(a.reason).toBe('uno');
    expect(ctx.resources[4].close).toHaveBeenCalledTimes(1);
  });

  it('un error al cancelar órdenes no impide cerrar lo demás', async () => {
    ctx.executor.cancelAll.mockRejectedValue(new Error('exchange caído'));
    ctx.bot.start();
    await ctx.bot.shutdown('prueba');
    expect(ctx.closed).toEqual(['feed', 'monitor', 'hora', 'cliente', 'base de datos']);
    expect(ctx.logs.messages().join()).toMatch(/No se pudieron cancelar las órdenes pendientes/);
  });

  it('el kill switch con el bot corriendo: parada de riesgo y apagado con código 3 (no se reinicia solo)', async () => {
    vi.useFakeTimers();
    ctx.bot.start();
    ctx.bot.killSwitch.activate('prueba en caliente');
    await vi.advanceTimersByTimeAsync(1000); // el bot lo revisa cada segundo
    const result = await ctx.bot.stopped;
    expect(result).toMatchObject({ exitCode: 3, reason: expect.stringMatching(/kill switch: .*prueba en caliente/) });
    expect(ctx.risk.haltState()).toMatchObject({ halted: true, code: 'KILL_SWITCH' });
    // El log dice claramente que se detuvo a propósito, por qué y que no se reinicia solo.
    expect(ctx.logs.messages().join('\n')).toMatch(
      /Bot detenido\. Detenido a propósito \(código 3\): kill switch: .*prueba en caliente\. No se reinicia solo/,
    );
  });

  it('kill switch con errores al procesarlo: igual se apaga con código 3', async () => {
    vi.useFakeTimers();
    vi.spyOn(ctx.risk, 'enforceLimits').mockRejectedValueOnce(new Error('base ocupada'));
    ctx.bot.start();
    ctx.bot.killSwitch.activate('prueba');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await ctx.bot.stopped).toMatchObject({ exitCode: 3, reason: 'kill switch (con errores al procesarlo)' });
  });

  it('pérdida diaria alcanzada antes de operar: parada y apagado con código 3', async () => {
    ctx.risk.recordEntry({ symbol: 'BTC/USDT', qty: 1, price: 100 });
    ctx.risk.recordExit({ symbol: 'BTC/USDT', qty: 1, price: 70 }); // −30 > 20
    ctx.bot.start();
    emit(0);
    const result = await ctx.bot.stopped;
    expect(result).toMatchObject({ exitCode: 3, reason: expect.stringMatching(/parada de riesgo: pérdida del día/) });
    expect(ctx.executor.submit).not.toHaveBeenCalled();
  });

  it('pérdida diaria alcanzada por la operación recién hecha: parada y apagado con código 3', async () => {
    ctx.risk.recordEntry({ symbol: 'BTC/USDT', qty: 1, price: 100 });
    ctx.strategy.evaluate.mockReturnValue({ action: 'SELL', code: 'TEST', reason: 'prueba' });
    ctx.executor.submit.mockImplementation(async () => {
      ctx.risk.recordExit({ symbol: 'BTC/USDT', qty: 1, price: 70 }); // la venta cierra con −30 > 20
      return { status: 'filled' };
    });
    ctx.bot.start();
    emit(0, 100); // antes de operar no hay pérdida: la posición vale lo que costó
    const result = await ctx.bot.stopped;
    expect(ctx.executor.submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ exitCode: 3, reason: expect.stringMatching(/parada de riesgo: pérdida del día/) });
  });

  it('IP bloqueada por Binance (418): se apaga con código 3 para no insistir y alargar el bloqueo', async () => {
    ctx.bot.start();
    ctx.feed.emit('fatal', new IpBannedError(Date.now() + 120_000));
    expect(await ctx.bot.stopped).toMatchObject({ exitCode: 3, reason: expect.stringMatching(/^error irrecuperable en los datos: /) });
  });

  it('otro error irrecuperable en los datos: se apaga con código 1 (caída; el lanzador lo reinicia)', async () => {
    ctx.bot.start();
    ctx.feed.emit('fatal', new Error('WebSocket rechazado'));
    expect(await ctx.bot.stopped).toMatchObject({ exitCode: 1, reason: 'error irrecuperable en los datos: WebSocket rechazado' });
  });
});

describe('heartbeat', () => {
  it('registra entorno, estrategia, última vela, posiciones y PnL del día', async () => {
    ctx.risk.recordEntry({ symbol: 'BTC/USDT', qty: 0.001, price: 84_000 });
    ctx.strategy.evaluate.mockReturnValue({ action: 'HOLD', code: 'X', reason: 'x' });
    ctx.bot.start();
    emit(3, 85_000);
    await vi.waitFor(() => expect(ctx.bot.stats.processed).toBe(1));
    ctx.bot.heartbeat();
    const line = ctx.logs.lines.filter((l) => l.msg.startsWith('Estado:')).at(-1);
    expect(line).toMatchObject({
      env: 'testnet',
      mode: 'dry-run',
      strategy: { id: 'test' },
      lastCandle: new Date(T0 + 3 * MIN).toISOString(),
      price: 85_000,
      positions: [{ symbol: 'BTC/USDT', qty: 0.001, entryPrice: 84_000 }],
      dailyPnl: { realized: 0, unrealized: 0.915 }, // 0.001 × 85 000 × 0.999 − 84
    });
    expect(line.msg).toMatch(/Estado: testnet\/dry-run · test · 1 posición\(es\) · PnL del día 0.915 USDT/);
  });

  it('se registra periódicamente', async () => {
    vi.useFakeTimers();
    ctx.bot.start();
    const count = () => ctx.logs.lines.filter((l) => l.msg.startsWith('Estado:')).length;
    expect(count()).toBe(1); // al arrancar
    await vi.advanceTimersByTimeAsync(3 * 60_000); // HEARTBEAT_SECONDS=60
    expect(count()).toBe(4);
  });
});

// ---------------------------------------------------------------------------------
describe('estado para el panel (bot_status)', () => {
  /** Reemplaza el bot del contexto por uno con registro de estado (afterEach lo apaga). */
  function botWithStatus(status) {
    ctx.bot = new TradingBot({
      config: ctx.bot.config, strategy: ctx.strategy, feed: ctx.feed, executor: ctx.executor, risk: ctx.risk,
      killSwitch: ctx.bot.killSwitch, logger: ctx.logs.logger, resources: ctx.resources, status,
    });
    return ctx.bot;
  }
  const iso = (ms) => new Date(ms).toISOString();

  it('guarda el arranque, cada heartbeat, cada vela procesada y el apagado (con motivo)', async () => {
    const status = new BotStatusStore(ctx.db, { env: 'testnet', mode: 'dry-run' });
    status.start({ time: T0, pid: 1, heartbeatMs: 60_000, strategy: 'test', params: {}, symbol: 'BTC/USDT', timeframe: '1m' });
    const stopping = vi.spyOn(status, 'stopping');
    const bot = botWithStatus(status);

    bot.start();
    expect(status.get()).toMatchObject({ state: 'running', heartbeatAt: expect.any(String), lastCandle: null });

    ctx.strategy.evaluate.mockReturnValue({ action: 'HOLD', code: 'X', reason: 'x' });
    emit(2, 85_000);
    await vi.waitFor(() => expect(status.get().lastCandle).toBe(iso(T0 + 2 * MIN))); // sin esperar al heartbeat

    bot.heartbeat();
    // precio = cierre de la última vela; su hora = el cierre (inicio + 1 min)
    expect(status.get()).toMatchObject({ price: 85_000, priceTime: iso(T0 + 3 * MIN) });
    ctx.feed.emit('price', { price: 85_100, time: T0 + 3 * MIN + 5000 }); // precio en vivo, posterior
    bot.heartbeat();
    expect(status.get()).toMatchObject({ price: 85_100, priceTime: iso(T0 + 3 * MIN + 5000) });

    await bot.shutdown('Ctrl+C de prueba');
    expect(stopping).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Ctrl+C de prueba' }));
    expect(status.get()).toMatchObject({ state: 'stopped', stopReason: 'Ctrl+C de prueba', exitCode: 0, stoppedAt: expect.any(String) });
  });

  it('una parada de riesgo queda registrada con su motivo y código de salida', async () => {
    const status = new BotStatusStore(ctx.db, { env: 'testnet', mode: 'dry-run' });
    status.start({ time: T0, pid: 1, heartbeatMs: 60_000, strategy: 'test', params: {}, symbol: 'BTC/USDT', timeframe: '1m' });
    ctx.risk.recordEntry({ symbol: 'BTC/USDT', qty: 1, price: 100 });
    ctx.risk.recordExit({ symbol: 'BTC/USDT', qty: 1, price: 70 }); // −30 > 20
    const bot = botWithStatus(status);
    bot.start();
    emit(0);
    await bot.stopped;
    expect(status.get()).toMatchObject({ state: 'stopped', exitCode: 3, stopReason: expect.stringMatching(/parada de riesgo: pérdida del día/) });
  });

  it('si guardar el estado falla, el bot sigue IGUAL: procesa, opera y se apaga normalmente', async () => {
    const broken = () => { throw new Error('disco lleno'); };
    const status = { running: vi.fn(broken), heartbeat: vi.fn(broken), candleProcessed: vi.fn(broken), stopping: vi.fn(broken), stopped: vi.fn(broken) };
    const bot = botWithStatus(status);

    bot.start();
    emit(0, 84_000);
    await vi.waitFor(() => expect(ctx.executor.submit).toHaveBeenCalledTimes(1)); // la señal se operó
    await vi.waitFor(() => expect(status.candleProcessed).toHaveBeenCalled());
    emit(1, 84_000);
    await vi.waitFor(() => expect(ctx.executor.submit).toHaveBeenCalledTimes(2)); // y el ciclo sigue
    expect(bot.consecutiveErrors).toBe(0); // no cuenta como error procesando velas

    const result = await bot.shutdown('prueba');
    expect(result).toEqual({ reason: 'prueba', exitCode: 0, timedOut: false });
    expect(ctx.executor.cancelAll).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toEqual(['feed', 'monitor', 'hora', 'cliente', 'base de datos']);
    expect(status.stopped).toHaveBeenCalled();
    const warnings = ctx.logs.lines.filter((l) => l.level === 40).map((l) => l.msg);
    expect(warnings).toContain('No se pudo guardar el estado del bot para el panel (heartbeat); el bot sigue normalmente');
    expect(warnings).toContain('No se pudo guardar el estado del bot para el panel (vela procesada); el bot sigue normalmente');
    expect(ctx.logs.messages().join('\n')).toMatch(/Bot detenido: prueba/);
  });
});
