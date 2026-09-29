import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MarketDataClient, PRODUCTION_DATA_HOST, marketFromExchangeInfo } from '../../src/backtest/market-data-client.js';
import { IpBannedError } from '../../src/data/rate-limiter.js';

const EXCHANGE_INFO = JSON.parse(fs.readFileSync(new URL('../fixtures/binance-prod-exchangeinfo-btcusdt.json', import.meta.url), 'utf8'));
const H = 3_600_000;
const T0 = Date.parse('2025-01-01T00:00:00Z');
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const kline = (t) => [t, '100.0', '101.0', '99.0', '100.5', '3.0', t + H - 1, '300', 10, '1', '100', '0'];

/** "Red" que responde como data-api.binance.vision y guarda cada petición. */
function fakeNetwork({ lastOpen = T0 + 3000 * H } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api/v3/exchangeInfo') return json(EXCHANGE_INFO);
    if (pathname === '/api/v3/klines') {
      const rows = [];
      const end = Number(searchParams.get('endTime'));
      // como Binance: la primera vela es la que EMPIEZA en startTime o después (alineada al intervalo)
      for (let t = Math.ceil(Number(searchParams.get('startTime')) / H) * H; t <= Math.min(end, lastOpen) && rows.length < Number(searchParams.get('limit')); t += H) rows.push(kline(t));
      return json(rows);
    }
    return json({ code: -1, msg: 'not found' }, 404);
  });
  return { fetchImpl, calls };
}

const client = (network, extra = {}) => new MarketDataClient({ fetchImpl: network.fetchImpl, retry: { wait: async () => {} }, ...extra });

describe('cliente de datos de producción: solo lectura por diseño', () => {
  it('solo expone métodos de datos: ninguno para órdenes', () => {
    const methods = Object.getOwnPropertyNames(MarketDataClient.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['fetchCandles', 'fetchMarket']);
  });

  it('va solo al host de datos públicos, por GET y sin credenciales', async () => {
    const network = fakeNetwork();
    await client(network).fetchMarket('BTC/USDT');
    await client(network).fetchCandles('BTC/USDT', '1h', { from: T0, to: T0 + 5 * H, now: T0 + 100 * H });
    for (const { url, init } of network.calls) {
      expect(url.hostname).toBe(PRODUCTION_DATA_HOST);
      expect(url.protocol).toBe('https:');
      expect(init.method).toBe('GET');
      expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('x-mbx-apikey');
      expect(url.searchParams.has('signature')).toBe(false);
    }
  });

  it('respeta los límites de Binance: un 418 detiene las peticiones', async () => {
    const fetchImpl = vi.fn(async () => json({ code: -1003 }, 418, { 'retry-after': '120' }));
    const c = new MarketDataClient({ fetchImpl, retry: { wait: async () => {} } });
    await expect(c.fetchMarket('BTC/USDT')).rejects.toThrow(IpBannedError);
    await expect(c.fetchMarket('BTC/USDT')).rejects.toThrow(IpBannedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('datos', () => {
  it('reglas del par desde exchangeInfo real de producción, en el formato del gestor de riesgo', () => {
    const market = marketFromExchangeInfo(EXCHANGE_INFO.symbols[0]);
    expect(market).toMatchObject({
      symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true,
      precision: { amount: 0.00001, price: 0.01 },
      limits: { amount: { min: 0.00001 }, cost: { min: 5 } },
    });
    expect(market.limits.market.max).toBeGreaterThan(0);
  });

  it('pagina de a 1000 y devuelve solo velas cerradas', async () => {
    const network = fakeNetwork();
    const now = T0 + 2500 * H + 30 * 60_000; // la vela de T0 + 2500 h sigue abierta
    const candles = await client(network).fetchCandles('BTC/USDT', '1h', { from: T0, to: T0 + 2600 * H, now });
    expect(candles).toHaveLength(2500);
    expect(candles.at(-1).time).toBe(T0 + 2499 * H);
    expect(candles[0]).toEqual({ time: T0, open: 100, high: 101, low: 99, close: 100.5, volume: 3 });
    expect(network.calls.filter((c) => c.url.pathname === '/api/v3/klines')).toHaveLength(3);
  });
});
