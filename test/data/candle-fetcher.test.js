import ccxt from 'ccxt';
import { describe, expect, it, vi } from 'vitest';
import { CandleFetcher } from '../../src/data/candle-fetcher.js';

const MIN = 60_000;
const T0 = Date.parse('2026-09-28T00:00:00Z');
const row = (t) => [t, 100, 101, 99, 100.5, 3];

/** fetchOHLCV falso con el comportamiento de Binance: desde `since`, hasta `limit`, hasta endTime. */
function fakeExchange(lastOpen) {
  return {
    fetchOHLCV: vi.fn(async (_symbol, _tf, since, limit, { endTime }) => {
      const rows = [];
      for (let t = since; t <= Math.min(endTime, lastOpen) && rows.length < limit; t += MIN) rows.push(row(t));
      return rows;
    }),
  };
}

describe('CandleFetcher', () => {
  it('pagina de a 1000 velas hasta cubrir el rango', async () => {
    const now = T0 + 2500 * MIN + 1;
    const exchange = fakeExchange(T0 + 3000 * MIN);
    const fetcher = new CandleFetcher({ exchange, symbol: 'BTC/USDT', timeframe: '1m', now: () => now });
    const candles = await fetcher.fetchRange(T0, T0 + 2500 * MIN);
    expect(candles).toHaveLength(2500);
    expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(3);
    expect(exchange.fetchOHLCV.mock.calls.map((c) => (c[2] - T0) / MIN)).toEqual([0, 1000, 2000]);
    expect(candles[0]).toEqual({ time: T0, open: 100, high: 101, low: 99, close: 100.5, volume: 3 });
  });

  it('nunca devuelve la vela en curso (según la hora del servidor)', async () => {
    const now = T0 + 10 * MIN + 30_000; // la vela de las 00:10 sigue abierta
    const fetcher = new CandleFetcher({ exchange: fakeExchange(T0 + 10 * MIN), symbol: 'BTC/USDT', timeframe: '1m', now: () => now });
    const candles = await fetcher.fetchRange(T0, T0 + 11 * MIN);
    expect(candles.at(-1).time).toBe(T0 + 9 * MIN);
  });

  it('pide solo el rango (endTime) y descarta lo que sobre', async () => {
    const exchange = fakeExchange(T0 + 100 * MIN);
    const fetcher = new CandleFetcher({ exchange, symbol: 'BTC/USDT', timeframe: '1m', now: () => T0 + 200 * MIN });
    const candles = await fetcher.fetchRange(T0 + 5 * MIN, T0 + 8 * MIN);
    expect(candles.map((c) => (c.time - T0) / MIN)).toEqual([5, 6, 7]);
    expect(exchange.fetchOHLCV.mock.calls[0][4]).toEqual({ endTime: T0 + 8 * MIN - 1 });
  });

  it('reintenta errores de red transitorios', async () => {
    const exchange = fakeExchange(T0 + 10 * MIN);
    const real = exchange.fetchOHLCV.getMockImplementation();
    exchange.fetchOHLCV.mockRejectedValueOnce(new ccxt.NetworkError('reset')).mockImplementation(real);
    const fetcher = new CandleFetcher({
      exchange, symbol: 'BTC/USDT', timeframe: '1m', now: () => T0 + 20 * MIN, retry: { wait: async () => {} },
    });
    expect(await fetcher.fetchRange(T0, T0 + 3 * MIN)).toHaveLength(3);
    expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(2);
  });
});
