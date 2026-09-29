/**
 * Cliente de datos de mercado de PRODUCCIÓN, de SOLO LECTURA, para el backtest.
 *
 * Garantías (por diseño, no por disciplina):
 *   - Usa data-api.binance.vision: el dominio de Binance que solo sirve datos
 *     públicos de mercado. Ahí los endpoints de órdenes ni siquiera existen (404).
 *   - Sin API keys: no envía credenciales ni firma nada.
 *   - Sin ccxt ni el módulo de ejecución: esta clase no tiene ningún método para
 *     crear, cancelar ni consultar órdenes; solo velas y reglas del par.
 *   - Lista blanca: solo GET a /api/v3/klines y /api/v3/exchangeInfo en ese host.
 *   - Respeta los límites de peso de Binance (429/418) con el mismo limitador del bot.
 */
import { withRetry } from '../lib/backoff.js';
import { toCandle } from '../lib/candles.js';
import { WeightLimiter } from '../data/rate-limiter.js';

export const PRODUCTION_DATA_HOST = 'data-api.binance.vision';
const ALLOWED_PATHS = new Set(['/api/v3/klines', '/api/v3/exchangeInfo']);

export class ReadOnlyViolation extends Error {
  constructor(message) {
    super(`Cliente de solo lectura: ${message}`);
    this.name = 'ReadOnlyViolation';
  }
}

export class MarketDataClient {
  /**
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchImpl] (tests: red simulada)
   * @param {WeightLimiter} [options.limiter]
   * @param {import('pino').Logger} [options.logger]
   * @param {object} [options.retry] opciones de withRetry
   */
  constructor({ fetchImpl = globalThis.fetch, limiter, logger, retry = {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.limiter = limiter ?? new WeightLimiter({ logger });
    this.logger = logger;
    this.retry = retry;
  }

  /** Única salida a la red: GET a un endpoint de la lista blanca, sin credenciales. */
  async #get(path, params) {
    if (!ALLOWED_PATHS.has(path)) throw new ReadOnlyViolation(`endpoint no permitido: ${path}`);
    const url = new URL(`https://${PRODUCTION_DATA_HOST}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return withRetry(async () => {
      await this.limiter.beforeRequest();
      const response = await this.fetchImpl(url.toString(), { method: 'GET', headers: { accept: 'application/json' } });
      this.limiter.observe(response.status, response.headers); // 429/418 → error propio
      if (!response.ok) throw new Error(`HTTP ${response.status} en ${path}: ${await response.text()}`);
      return response.json();
    }, { logger: this.logger, label: `datos de producción ${path}`, ...this.retry });
  }

  /**
   * Reglas del par (filtros) en el mismo formato que usa el gestor de riesgo.
   * @param {string} symbol p. ej. 'BTC/USDT'
   */
  async fetchMarket(symbol) {
    const id = symbol.replace('/', '');
    const info = await this.#get('/api/v3/exchangeInfo', { symbol: id });
    const raw = info.symbols?.find((s) => s.symbol === id);
    if (!raw) throw new Error(`el par ${symbol} no existe en Binance`);
    return marketFromExchangeInfo(raw);
  }

  /**
   * Velas CERRADAS con inicio en [from, to), paginando de a 1000.
   * @returns {Promise<Array<{ time, open, high, low, close, volume }>>}
   */
  async fetchCandles(symbol, timeframe, { from, to, now = Date.now() }) {
    const id = symbol.replace('/', '');
    const candles = [];
    let startTime = from;
    while (startTime < to) {
      const rows = await this.#get('/api/v3/klines', {
        symbol: id, interval: timeframe, startTime, endTime: to - 1, limit: 1000,
      });
      // fila Binance: [openTime, open, high, low, close, volume, closeTime, …] (precios como texto)
      const page = rows
        .filter((row) => row[6] < now) // solo velas cerradas
        .map((row) => toCandle(row.slice(0, 6).map(Number)));
      candles.push(...page);
      if (rows.length < 1000 || page.length === 0) break;
      startTime = page.at(-1).time + 1;
    }
    return candles;
  }
}

/** Convierte los filtros de exchangeInfo al formato de mercado que usa el riesgo (como ccxt). */
export function marketFromExchangeInfo(raw) {
  const filter = (type) => raw.filters.find((f) => f.filterType === type) ?? {};
  const num = (value) => (value === undefined ? undefined : Number(value));
  const lot = filter('LOT_SIZE');
  const price = filter('PRICE_FILTER');
  const notional = filter('NOTIONAL');
  const marketLot = filter('MARKET_LOT_SIZE');
  return {
    id: raw.symbol,
    symbol: `${raw.baseAsset}/${raw.quoteAsset}`,
    base: raw.baseAsset,
    quote: raw.quoteAsset,
    spot: true,
    active: raw.status === 'TRADING',
    precision: { amount: num(lot.stepSize), price: num(price.tickSize) },
    limits: {
      amount: { min: num(lot.minQty), max: num(lot.maxQty) },
      price: { min: num(price.minPrice), max: num(price.maxPrice) },
      cost: { min: num(notional.minNotional), max: num(notional.maxNotional) },
      market: { min: num(marketLot.minQty), max: num(marketLot.maxQty) || undefined },
    },
  };
}
