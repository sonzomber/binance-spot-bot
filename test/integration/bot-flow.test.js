/**
 * Integración del flujo completo en DRY-RUN con datos simulados:
 * arranque real (5 pasos) → velas por WebSocket → estrategia → riesgo →
 * ejecución simulada → posición → apagado ordenado.
 *
 * Todo es código real del bot. Lo único simulado es la red: Binance por HTTP
 * (FakeBinance, a través del cliente ccxt) y el WebSocket (FakeSocket).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartupError, startBot } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { BotStatusStore } from '../../src/storage/bot-status-store.js';
import { openDatabase } from '../../src/storage/db.js';
import { OrderStore } from '../../src/storage/order-store.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { captureLogger, tempDir, testEnv } from '../helpers.js';
import { FakeBinance } from '../support/fake-binance.js';
import { socketFactory } from '../support/fake-socket.js';

const MIN = 60_000;
const SCOPE = { env: 'testnet', mode: 'dry-run' };

let tmp;
let fake;
let sockets;
let logs;
let config;
let bot;

beforeEach(async () => {
  tmp = await tempDir();
  logs = await captureLogger();
  sockets = socketFactory();
  // Historial bajista: cada vela cierra 10 USDT más abajo (la SMA rápida queda bajo la lenta).
  const start = Math.floor(Date.now() / MIN) * MIN - 100 * MIN;
  fake = new FakeBinance({ price: 84_000 });
  fake.closeAt = (t) => 84_000 - ((t - start) / MIN) * 10;
  config = loadConfig(testEnv({
    TIMEFRAME: '1m',
    DATA_FEED: 'ws',
    STRATEGY_PARAMS: '{"fast":2,"slow":4}',
    DB_PATH: path.join(tmp.dir, 'bot.db'),
    KILL_SWITCH_FILE: path.join(tmp.dir, 'STOP'),
    SHUTDOWN_TIMEOUT_SECONDS: '2',
    HEARTBEAT_SECONDS: '5',
  }));
});
afterEach(async () => {
  await bot?.shutdown('fin de la prueba');
  bot = undefined;
  tmp.cleanup();
});

const start = () => startBot({ config, logger: logs.logger, overrides: { fetchImplementation: fake.fetch, createSocket: sockets.create } });
const messages = () => logs.messages();
const orders = () => bot.executor.orders.list();

/** Abre la base de datos del archivo (después del apagado) para ver lo que quedó guardado. */
function readBack() {
  const db = openDatabase(config.storage.dbPath);
  const result = {
    orders: new OrderStore(db, SCOPE).list(),
    open: new RiskStore(db, SCOPE).openPositions(),
    events: new RiskStore(db, SCOPE).recentEvents(20),
    realized: new RiskStore(db, SCOPE).realizedForDay(new Date().toISOString().slice(0, 10)),
  };
  db.close();
  return result;
}

describe('flujo completo en dry-run', () => {
  it('arranca en orden, compra en el golden cross, vende en el death cross y se apaga ordenadamente', async () => {
    bot = await start();

    // Secuencia de arranque, en el orden pedido
    const steps = messages().filter((m) => /^\[\d\/5\] .*: OK$/.test(m));
    expect(steps).toEqual([
      '[1/5] Configuración y entorno (bloqueo de mainnet): OK',
      '[2/5] Sincronizar la hora con Binance: OK',
      '[3/5] Cargar el estado de riesgo desde SQLite: OK',
      '[4/5] Reconciliar con Binance: OK',
      '[5/5] Cargar velas históricas para calentar los indicadores: OK',
    ]);
    expect(bot.feed.getCandles(100).length).toBeGreaterThanOrEqual(50);

    const socket = sockets.current();
    socket.open();
    const t0 = bot.feed.lastClosed.time + MIN;

    // 1) Salto alcista: la SMA2 cruza por encima de la SMA4 → BUY
    socket.kline(t0, 84_000, false); // actualización en curso: no genera señales
    socket.kline(t0, 84_000);
    await vi.waitFor(() => expect(orders()).toHaveLength(1), { timeout: 5000 });
    expect(orders()[0]).toMatchObject({ side: 'buy', status: 'filled', mode: 'dry-run', signalCode: 'GOLDEN_CROSS' });
    expect(orders()[0].avgFillPrice).toBeCloseTo(84_000 * 1.0005, 6); // slippage simulado
    expect(bot.risk.store.openPositions()).toHaveLength(1);

    // 2) Sigue subiendo: HOLD
    socket.kline(t0 + MIN, 84_100);
    await vi.waitFor(() => expect(bot.stats.processed).toBe(2));
    expect(orders()).toHaveLength(1);

    // 3) Caída: death cross → SELL
    socket.kline(t0 + 2 * MIN, 82_000);
    await vi.waitFor(() => expect(orders()).toHaveLength(2), { timeout: 5000 });
    expect(orders()[1]).toMatchObject({ side: 'sell', status: 'filled', signalCode: 'DEATH_CROSS' });
    expect(bot.risk.store.openPositions()).toHaveLength(0);

    // Heartbeat con el estado del bot
    bot.heartbeat();
    const heartbeat = logs.lines.filter((l) => l.msg.startsWith('Estado:')).at(-1);
    expect(heartbeat).toMatchObject({
      env: 'testnet', mode: 'dry-run', strategy: { id: 'sma-cross', params: { fast: 2, slow: 4 } },
      lastCandle: new Date(t0 + 2 * MIN).toISOString(), positions: [],
    });
    expect(heartbeat.dailyPnl.realized).toBeLessThan(0);

    // Apagado ordenado
    const result = await bot.shutdown('prueba de integración');
    expect(result).toEqual({ reason: 'prueba de integración', exitCode: 0, timedOut: false });
    expect(socket.close).toHaveBeenCalled(); // WebSocket cerrado

    // Lo que quedó en disco
    const saved = readBack();
    expect(saved.orders.map((o) => [o.side, o.status])).toEqual([['buy', 'filled'], ['sell', 'filled']]);
    expect(saved.realized.trades).toBe(1);
    expect(saved.events[0]).toMatchObject({ type: 'SHUTDOWN', code: 'NORMAL', message: 'prueba de integración' });
  });

  it('apagar NO cierra ni vende la posición abierta', async () => {
    bot = await start();
    sockets.current().open();
    sockets.current().kline(bot.feed.lastClosed.time + MIN, 84_000); // golden cross → compra
    await vi.waitFor(() => expect(bot.risk.store.openPositions()).toHaveLength(1), { timeout: 5000 });

    await bot.shutdown('prueba');
    const saved = readBack();
    expect(saved.orders.map((o) => o.side)).toEqual(['buy']); // ninguna venta
    expect(saved.open).toHaveLength(1);
    expect(messages().join('\n')).toMatch(/Quedan 1 posición\(es\) abierta\(s\): NO se cierran al apagar/);
  });

  it('una señal que llega con los datos desactualizados no opera', async () => {
    bot = await start();
    sockets.current().open();
    bot.health.setRecovering('simulación de datos viejos');
    sockets.current().kline(bot.feed.lastClosed.time + MIN, 84_000);
    await vi.waitFor(() => expect(orders()).toHaveLength(1), { timeout: 5000 });
    expect(orders()[0]).toMatchObject({ status: 'rejected', rejectCode: 'STALE_DATA' });
  });
});

describe('si un paso del arranque falla, el bot no arranca y explica el motivo', () => {
  it('paso 3: kill switch activo', async () => {
    new KillSwitch(config.risk.killSwitchFile).activate('mantenimiento');
    const error = await start().catch((err) => err);
    expect(error).toBeInstanceOf(StartupError);
    expect(error.step).toBe(3);
    expect(error.message).toMatch(/paso 3\/5 \(Cargar el estado de riesgo desde SQLite\): kill switch activo .*mantenimiento/);
    // lo abierto se cerró: la base de datos no quedó bloqueada
    expect(() => fs.renameSync(config.storage.dbPath, `${config.storage.dbPath}.x`)).not.toThrow();
  });

  it('paso 5: no hay suficientes velas para calentar los indicadores', async () => {
    fake.historyStart = Math.floor(Date.now() / MIN) * MIN - 3 * MIN; // solo 3 velas cerradas
    const error = await start().catch((err) => err);
    expect(error).toBeInstanceOf(StartupError);
    expect(error.message).toMatch(/paso 5\/5 .*hay 3 velas y la estrategia "sma-cross" necesita 5/);
  });

  it('paso 4: diferencias en la reconciliación (modo exchange)', async () => {
    config = loadConfig(testEnv({
      TIMEFRAME: '1m', DATA_FEED: 'ws', STRATEGY_PARAMS: '{"fast":2,"slow":4}', DRY_RUN: 'false',
      BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's',
      DB_PATH: path.join(tmp.dir, 'bot.db'), KILL_SWITCH_FILE: path.join(tmp.dir, 'STOP'),
    }));
    fake.addExternalOrder({ clientOrderId: 'web_manual_9' });
    const error = await startBot({
      config, logger: logs.logger, overrides: { fetchImplementation: fake.fetch, createSocket: sockets.create, warnDelayMs: 0 },
    }).catch((err) => err);
    expect(error.step).toBe(4);
    expect(error.message).toMatch(/diferencia\(s\) con el exchange: orden abierta en Binance que el bot no registró.*npm run reconcile/);
    expect(messages().join('\n')).toMatch(/DRY-RUN DESACTIVADO/); // advertencia al arrancar sin dry-run
  });
});

describe('estado del bot para el panel (bot_status)', () => {
  function readStatus() {
    const db = openDatabase(config.storage.dbPath);
    try {
      return new BotStatusStore(db, SCOPE).get();
    } finally {
      db.close();
    }
  }

  it('arranque real → "running" con estrategia, parámetros y config pública; apagado → "stopped"', async () => {
    bot = await start();
    expect(readStatus()).toMatchObject({
      env: 'testnet', mode: 'dry-run', state: 'running', pid: process.pid, heartbeatMs: 5000,
      strategy: 'sma-cross', params: { fast: 2, slow: 4 }, symbol: 'BTC/USDT', timeframe: '1m',
      heartbeatAt: expect.any(String), dataStale: expect.any(Boolean),
      settings: { dryRun: true, maxDailyLossUsdt: 20, maxOpenPositions: 1, maxTradeUsdt: 50 },
    });

    sockets.current().open();
    const next = bot.feed.lastClosed.time + MIN;
    sockets.current().kline(next, 84_000);
    await vi.waitFor(() => expect(readStatus().lastCandle).toBe(new Date(next).toISOString()), { timeout: 5000 });

    await bot.shutdown('prueba del panel');
    expect(readStatus()).toMatchObject({ state: 'stopped', stopReason: 'prueba del panel', exitCode: 0 });
  });

  it('si el arranque se rechaza, queda registrado por qué y con código 3 (sin dejar la base bloqueada)', async () => {
    new KillSwitch(config.risk.killSwitchFile).activate('mantenimiento');
    await start().catch(() => {});
    expect(readStatus()).toMatchObject({
      state: 'stopped', exitCode: 3, stopReason: expect.stringMatching(/^no arrancó: paso 3\/5 .*kill switch activo/),
    });
  });

  it('si el arranque falla por un error inesperado, queda registrado con código 1 (se puede reintentar)', async () => {
    fake.historyStart = Math.floor(Date.now() / MIN) * MIN - 3 * MIN; // paso 5: faltan velas (Error genérico)
    await start().catch(() => {});
    expect(readStatus()).toMatchObject({
      state: 'stopped', exitCode: 1, stopReason: expect.stringMatching(/^no arrancó: paso 5\/5 /),
    });
  });
});
