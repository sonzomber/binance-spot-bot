/**
 * Estado del bot para el panel: ciclo de vida por ámbito, separación de
 * entornos y lista blanca de configuración pública (sin secretos).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { BotStatusStore, publicSettings } from '../../src/storage/bot-status-store.js';
import { openDatabase } from '../../src/storage/db.js';
import { testEnv } from '../helpers.js';

const T = Date.parse('2026-09-29T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const START = {
  time: T, pid: 4242, heartbeatMs: 60_000, strategy: 'sma-cross', params: { fast: 9, slow: 21 },
  symbol: 'BTC/USDT', timeframe: '15m', settings: { dryRun: true, maxDailyLossUsdt: 20 },
};

let db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

describe('ciclo de vida: starting → running → stopping → stopped', () => {
  it('guarda cada etapa con su hora, la estrategia y la config pública', () => {
    const status = new BotStatusStore(db, { env: 'testnet', mode: 'dry-run' });
    expect(status.get()).toBeNull(); // el bot nunca corrió en este ámbito

    status.start(START);
    expect(status.get()).toMatchObject({
      env: 'testnet', mode: 'dry-run', state: 'starting', pid: 4242, startedAt: iso(T), updatedAt: iso(T),
      heartbeatAt: null, heartbeatMs: 60_000, strategy: 'sma-cross', params: { fast: 9, slow: 21 },
      symbol: 'BTC/USDT', timeframe: '15m', settings: { dryRun: true, maxDailyLossUsdt: 20 }, stoppedAt: null,
    });

    status.running({ time: T + 1000 });
    status.heartbeat({ time: T + 2000, lastCandle: T - 900_000, price: 84_000.5, priceTime: T, data: { stale: false, reason: null } });
    expect(status.get()).toMatchObject({
      state: 'running', heartbeatAt: iso(T + 2000), updatedAt: iso(T + 2000), lastCandle: iso(T - 900_000),
      price: 84_000.5, priceTime: iso(T), dataStale: false, dataReason: null,
    });

    status.candleProcessed({ time: T + 3000, lastCandle: T });
    expect(status.get()).toMatchObject({ state: 'running', lastCandle: iso(T), heartbeatAt: iso(T + 2000) });

    status.heartbeat({ time: T + 4000, lastCandle: T, price: 84_100, priceTime: T + 3500, data: { stale: true, reason: 'sin mensajes hace 90 s' } });
    expect(status.get()).toMatchObject({ dataStale: true, dataReason: 'sin mensajes hace 90 s' });

    status.stopping({ time: T + 5000, reason: 'Ctrl+C' });
    expect(status.get()).toMatchObject({ state: 'stopping', stopReason: 'Ctrl+C', stoppedAt: null });

    status.stopped({ time: T + 6000, reason: 'Ctrl+C', exitCode: 0 });
    expect(status.get()).toMatchObject({ state: 'stopped', stoppedAt: iso(T + 6000), stopReason: 'Ctrl+C', exitCode: 0 });
  });

  it('heartbeat y vela procesada nunca cambian el estado (no "reviven" un bot detenido)', () => {
    const status = new BotStatusStore(db, { env: 'testnet', mode: 'dry-run' });
    status.start(START);
    status.stopped({ time: T + 1, reason: 'kill switch', exitCode: 1 });
    status.heartbeat({ time: T + 2, lastCandle: T, price: 1, priceTime: T });
    status.candleProcessed({ time: T + 3, lastCandle: T });
    expect(status.get()).toMatchObject({ state: 'stopped', stopReason: 'kill switch', exitCode: 1 });
  });

  it('un arranque nuevo reemplaza lo que quedó de la ejecución anterior', () => {
    const status = new BotStatusStore(db, { env: 'testnet', mode: 'dry-run' });
    status.start(START);
    status.heartbeat({ time: T + 1, lastCandle: T, price: 1, priceTime: T, data: { stale: true, reason: 'x' } });
    status.stopped({ time: T + 2, reason: 'apagado', exitCode: 0 });

    status.start({ ...START, time: T + 10_000, pid: 7, params: { fast: 5, slow: 30 } });
    expect(status.get()).toMatchObject({
      state: 'starting', pid: 7, startedAt: iso(T + 10_000), params: { fast: 5, slow: 30 },
      heartbeatAt: null, lastCandle: null, price: null, priceTime: null, dataStale: null, dataReason: null,
      stoppedAt: null, stopReason: null, exitCode: null,
    });
    expect(BotStatusStore.all(db)).toHaveLength(1); // sigue siendo una fila por ámbito
  });
});

describe('separación de entornos', () => {
  it('cada ámbito tiene su propia fila; escribir en uno no toca los otros', () => {
    const testnet = new BotStatusStore(db, { env: 'testnet', mode: 'dry-run' });
    const demo = new BotStatusStore(db, { env: 'demo', mode: 'exchange' });
    testnet.start(START);
    demo.start({ ...START, pid: 2 });
    demo.stopped({ time: T + 1, reason: 'solo demo', exitCode: 0 });

    expect(testnet.get()).toMatchObject({ env: 'testnet', mode: 'dry-run', state: 'starting', pid: 4242 });
    expect(demo.get()).toMatchObject({ env: 'demo', mode: 'exchange', state: 'stopped', pid: 2 });
    expect(new BotStatusStore(db, { env: 'testnet', mode: 'exchange' }).get()).toBeNull();
    expect(BotStatusStore.all(db).map((s) => `${s.env}/${s.mode}`)).toEqual(['demo/exchange', 'testnet/dry-run']);
  });

  it('no acepta ámbitos que no son de trading (producción nunca tiene estado de bot)', () => {
    expect(() => new BotStatusStore(db, { env: 'production-readonly', mode: 'dry-run' })).toThrow(/entorno de trading inválido/);
    expect(() => new BotStatusStore(db, { env: 'mainnet', mode: 'exchange' })).toThrow(/entorno de trading inválido/);
  });
});

describe('publicSettings: lista blanca, sin secretos', () => {
  it('solo copia valores públicos; nunca API keys', () => {
    const config = loadConfig(testEnv({ BINANCE_API_KEY: 'CLAVE-PUBLICA-NO-DEBE-SALIR', BINANCE_API_SECRET: 'SECRETO-NO-DEBE-SALIR' }));
    const settings = publicSettings(config);
    expect(Object.keys(settings).sort()).toEqual(
      ['dataFeed', 'dataStaleAfterMs', 'dryRun', 'feeRate', 'maxDailyLossUsdt', 'maxOpenPositions', 'maxTradeUsdt', 'slippageBps'],
    );
    expect(JSON.stringify(settings)).not.toMatch(/NO-DEBE-SALIR/);

    const status = new BotStatusStore(db, config);
    status.start({ ...START, settings });
    const raw = JSON.stringify(db.prepare('SELECT * FROM bot_status').all());
    expect(raw).not.toMatch(/NO-DEBE-SALIR/);
  });
});
