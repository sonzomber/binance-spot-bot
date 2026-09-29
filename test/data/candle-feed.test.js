import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandleFeed } from '../../src/data/candle-feed.js';
import { DataHealth } from '../../src/data/data-health.js';
import { IpBannedError } from '../../src/data/rate-limiter.js';
import { CandleStore } from '../../src/storage/candle-store.js';
import { openDatabase } from '../../src/storage/db.js';
import SmaCrossStrategy from '../../src/strategy/strategies/sma-cross.js';
import { captureLogger, createClock } from '../helpers.js';

const MIN = 60_000;
const T = (hhmm) => Date.parse(`2026-09-28T${hhmm}:00.000Z`); // inicio de una vela de 1m
const iso = (ms) => new Date(ms).toISOString().slice(11, 16);
const candle = (t, close = 100 + ((t / MIN) % 7)) => ({ time: t, open: close, high: close + 1, low: close - 1, close, volume: 1 });

/** Exchange REST falso: sirve velas cerradas; puede faltar alguna o demorar la respuesta. */
function fakeRest({ now, missing = new Set(), publishDelayMs = 0 }) {
  let gate = null;
  const rest = {
    calls: [],
    hold() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    fail: null,
    fetchRange: vi.fn(async (from, to) => {
      rest.calls.push([iso(from), iso(to)]);
      if (gate) await gate;
      if (rest.fail) throw rest.fail;
      const out = [];
      for (let t = from; t < to; t += MIN) {
        if (!missing.has(t) && t + MIN + publishDelayMs <= now()) out.push(candle(t));
      }
      return out;
    }),
  };
  return rest;
}

class FakeStream extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
  kline(t, closed, close) { this.emit('kline', { candle: candle(t, close), closed, eventTime: t }); }
}

let db;
let store;
let clock;
let log;
beforeEach(async () => {
  db = openDatabase(':memory:');
  store = new CandleStore(db, { env: 'testnet' });
  clock = createClock('2026-09-28T12:00:30.000Z'); // la última vela cerrada es la de 11:59
  log = await captureLogger();
});
afterEach(() => db.close());

function makeFeed({ mode = 'ws', warmupCandles = 30, rest = fakeRest({ now: clock.now }), now = clock.now, fetchPrice } = {}) {
  const stream = new FakeStream();
  const health = new DataHealth({ timeframe: '1m', staleAfterMs: 60_000, now });
  const feed = new CandleFeed({
    symbol: 'BTC/USDT', timeframe: '1m', mode, store, fetcher: rest, health, now,
    createStream: () => stream, fetchPrice: fetchPrice ?? (async () => 84_000),
    warmupCandles, logger: log.logger, rest: { pollDelayMs: 2000, heartbeatMs: 15_000, retryMs: 5000 },
  });
  const events = { candle: [], price: [], fatal: [] };
  for (const name of Object.keys(events)) feed.on(name, (e) => events[name].push(e));
  return { feed, stream, health, rest, events };
}
const stored = () => store.last('BTC/USDT', '1m', 10_000);
const gapsBetween = (from, to) => store.findGaps('BTC/USDT', '1m', { from, to }).missing;

// ---------------------------------------------------------------------------------
describe('arranque: historial desde el caché + REST', () => {
  it('descarga las últimas N velas cerradas', async () => {
    const { feed, rest } = makeFeed({ warmupCandles: 30 });
    await feed.start();
    expect(rest.calls).toEqual([['11:30', '12:00']]);
    expect(stored()).toHaveLength(30);
    expect(feed.getCandles(1)[0].time).toBe(T('11:59'));
  });

  it('usa el caché: solo descarga las que faltan', async () => {
    store.upsert('BTC/USDT', '1m', Array.from({ length: 20 }, (_, i) => candle(T('11:30') + i * MIN)), { now: clock.now() });
    const { feed, rest } = makeFeed({ warmupCandles: 30 });
    await feed.start();
    expect(rest.calls).toEqual([['11:50', '12:00']]);
    expect(stored()).toHaveLength(30);
  });

  it('si Binance no tiene alguna vela, avisa del hueco', async () => {
    const { feed } = makeFeed({ rest: fakeRest({ now: clock.now, missing: new Set([T('11:40')]) }) });
    await feed.start();
    expect(log.messages().join('\n')).toMatch(/Faltan 1 de 30 velas [\s\S]*2026-09-28 11:40 → 2026-09-28 11:40 UTC \(1 vela\)/);
  });
});

// ---------------------------------------------------------------------------------
describe('solo velas cerradas llegan a la estrategia', () => {
  it('las actualizaciones de la vela en curso emiten precio, nunca "candle", y no se guardan', async () => {
    const { feed, stream, events } = makeFeed();
    await feed.start();
    stream.kline(T('12:00'), false, 101);
    stream.kline(T('12:00'), false, 105);
    stream.kline(T('12:00'), false, 103);
    await feed.queue;
    expect(events.candle).toEqual([]);
    expect(events.price.map((p) => p.price)).toEqual([101, 105, 103]);
    expect(stored()).toHaveLength(30);
    expect(feed.getCandles(5).map((c) => iso(c.time))).toEqual(['11:55', '11:56', '11:57', '11:58', '11:59']);
  });

  it('la estrategia evaluada con getCandles nunca ve la vela en curso', async () => {
    const { feed, stream } = makeFeed();
    await feed.start();
    const strategy = new SmaCrossStrategy({ fast: 2, slow: 4 });
    const before = strategy.evaluate(feed.getCandles(strategy.lookback));
    stream.kline(T('12:00'), false, 999_999); // precio absurdo en la vela en curso
    await feed.queue;
    expect(strategy.evaluate(feed.getCandles(strategy.lookback))).toEqual(before);
  });

  it('la vela cerrada (x = true) se guarda y se emite una sola vez', async () => {
    const { feed, stream, events } = makeFeed();
    await feed.start();
    clock.set('2026-09-28T12:01:00.200Z');
    stream.kline(T('12:00'), true);
    stream.kline(T('12:00'), true); // repetida
    await feed.queue;
    expect(events.candle.map((e) => [iso(e.candle.time), e.source])).toEqual([['12:00', 'ws']]);
    expect(stored()).toHaveLength(31);
  });

  it('una vela cerrada vieja y fuera de orden se ignora, aunque no esté en el caché', async () => {
    // Binance no tenía la de 11:40 al arrancar; si apareciera tarde por el stream,
    // emitirla haría que el bot reevaluara (y quizá repitiera) la señal más reciente.
    const { feed, stream, events } = makeFeed({ rest: fakeRest({ now: clock.now, missing: new Set([T('11:40')]) }) });
    await feed.start();
    stream.kline(T('11:40'), true);
    await feed.queue;
    expect(events.candle).toEqual([]);
    expect(stored()).toHaveLength(29);
  });

  it('se acepta la vela cerrada aunque el reloj local vaya unos ms atrasado', async () => {
    const { feed, stream, events } = makeFeed();
    await feed.start();
    clock.set('2026-09-28T12:00:59.990Z'); // 10 ms antes del cierre según nuestro reloj
    stream.kline(T('12:00'), true); // Binance dice que ya cerró
    await feed.queue;
    expect(events.candle).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------
describe('reconexión del WebSocket con huecos', () => {
  it('rellena por REST lo perdido ANTES de reanudar; sin duplicados; órdenes bloqueadas mientras tanto', async () => {
    const { feed, stream, rest, health, events } = makeFeed();
    await feed.start();
    stream.emit('open', { reconnect: false, downtimeMs: 0 });
    rest.calls.length = 0;

    // Se corta 4.5 min: cierran las velas 12:00 a 12:04 sin que las veamos.
    clock.set('2026-09-28T12:05:10.000Z');
    const release = rest.hold(); // el relleno REST tarda
    stream.emit('open', { reconnect: true, downtimeMs: 270_000 });
    await Promise.resolve();

    expect(health.status()).toEqual({ stale: true, reason: 'rellenando velas perdidas durante la desconexión (270 s)' });
    stream.kline(T('12:04'), true); // llega por WS mientras se rellena (y REST también la trae)
    stream.kline(T('12:05'), false); // actualización en curso: solo precio

    release();
    await feed.queue;

    expect(rest.calls).toEqual([['12:00', '12:05']]); // solo el hueco
    expect(gapsBetween(T('11:30'), T('12:05'))).toBe(0); // serie continua
    expect(stored()).toHaveLength(35); // 30 + 5, sin duplicar la 12:04
    // Una sola vela emitida: la más reciente. Las señales viejas no se ejecutan tarde.
    expect(events.candle.map((e) => [iso(e.candle.time), e.source, e.added])).toEqual([['12:04', 'backfill', 5]]);
    expect(health.isStale()).toBe(false);

    // Y sigue normal por WS
    clock.set('2026-09-28T12:06:00.100Z');
    stream.kline(T('12:05'), true);
    await feed.queue;
    expect(events.candle.at(-1)).toMatchObject({ source: 'ws', candle: { time: T('12:05') } });
  });

  it('una vela cerrada que llega saltándose otras dispara el relleno de las intermedias', async () => {
    const { feed, stream, rest, events } = makeFeed();
    await feed.start();
    rest.calls.length = 0;
    clock.set('2026-09-28T12:03:00.500Z');
    stream.kline(T('12:02'), true); // faltan 12:00 y 12:01
    await feed.queue;
    expect(rest.calls).toEqual([['12:00', '12:02']]);
    expect(gapsBetween(T('11:30'), T('12:03'))).toBe(0);
    expect(events.candle.map((e) => iso(e.candle.time))).toEqual(['12:02']);
  });

  it('si el relleno falla, los datos quedan desactualizados y se reintenta en el próximo cierre', async () => {
    const { feed, stream, rest, health, events } = makeFeed();
    await feed.start();
    clock.set('2026-09-28T12:03:10.000Z');
    rest.fail = new Error('timeout');
    stream.emit('open', { reconnect: true, downtimeMs: 150_000 });
    await feed.queue;
    stream.emit('activity'); // el socket reconectado sigue recibiendo pings
    expect(log.messages().join()).toMatch(/Error procesando velas/);
    expect(health.status()).toMatchObject({ stale: true, reason: expect.stringMatching(/falta la vela de .*12:00:00/) });

    rest.fail = null;
    clock.set('2026-09-28T12:04:00.300Z');
    stream.kline(T('12:03'), true);
    await feed.queue;
    expect(gapsBetween(T('11:30'), T('12:04'))).toBe(0);
    expect(events.candle.map((e) => iso(e.candle.time))).toEqual(['12:03']);
    expect(health.isStale()).toBe(false);
  });

  it('IP bloqueada (418) durante el relleno → error fatal y el feed se detiene', async () => {
    const { feed, stream, rest, events } = makeFeed();
    await feed.start();
    clock.set('2026-09-28T12:03:10.000Z');
    rest.fail = new IpBannedError(Date.now() + 60_000);
    stream.emit('open', { reconnect: true, downtimeMs: 150_000 });
    await feed.queue;
    expect(events.fatal).toHaveLength(1);
    expect(stream.stop).toHaveBeenCalled();
  });

  it('la actividad del stream (mensajes y pings) cuenta como señal de vida', async () => {
    const { feed, stream, health } = makeFeed();
    await feed.start();
    clock.advance(59_000);
    stream.emit('activity');
    clock.advance(30_000); // 12:01:59 — la vela de 12:00 cerró hace 59 s, sin llegar
    expect(health.isStale()).toBe(false);
    clock.advance(2000);
    expect(health.status().reason).toMatch(/falta la vela/);
  });
});

// ---------------------------------------------------------------------------------
describe('modo REST', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-09-28T12:00:30.000Z') });
  });
  afterEach(() => vi.useRealTimers());

  it('consulta justo después de cada cierre y emite la vela nueva', async () => {
    const now = () => Date.now();
    const { feed, events } = makeFeed({ mode: 'rest', now, rest: fakeRest({ now }) });
    await feed.start();
    await vi.advanceTimersByTimeAsync(31_999); // 12:01:01.999
    expect(events.candle).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); // 12:01:02 = cierre + 2 s
    await feed.queue;
    expect(events.candle.map((e) => [iso(e.candle.time), e.source])).toEqual([['12:00', 'rest']]);
    await vi.advanceTimersByTimeAsync(60_000);
    await feed.queue;
    expect(events.candle.map((e) => iso(e.candle.time))).toEqual(['12:00', '12:01']);
    await feed.stop();
  });

  it('si Binance tarda en publicar la vela, reintenta a los pocos segundos', async () => {
    const now = () => Date.now();
    const rest = fakeRest({ now, publishDelayMs: 4000 }); // la vela aparece 4 s después del cierre
    const { feed, events } = makeFeed({ mode: 'rest', now, rest });
    await feed.start();
    await vi.advanceTimersByTimeAsync(32_000); // 12:01:02: aún no está
    await feed.queue;
    expect(events.candle).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000); // reintento a las 12:01:07
    await feed.queue;
    expect(events.candle.map((e) => iso(e.candle.time))).toEqual(['12:00']);
    await feed.stop();
  });

  it('latido de precio periódico: emite "price" y mantiene los datos al día', async () => {
    const now = () => Date.now();
    const fetchPrice = vi.fn(async () => 84_123);
    const { feed, events, health } = makeFeed({ mode: 'rest', now, rest: fakeRest({ now }), fetchPrice });
    await feed.start();
    await vi.advanceTimersByTimeAsync(45_000);
    await feed.queue;
    expect(fetchPrice).toHaveBeenCalledTimes(4); // al arrancar + cada 15 s
    expect(events.price.at(-1).price).toBe(84_123);
    expect(health.isStale()).toBe(false);
    await feed.stop();
  });
});
