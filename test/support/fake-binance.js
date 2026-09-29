/**
 * Binance Spot simulado a nivel HTTP, para usar como fetchImplementation de ccxt.
 *
 * Así las pruebas pasan por el cliente ccxt REAL (firma, formato de peticiones,
 * interpretación de respuestas) y por la guardia de red y el filtro de órdenes
 * del bot. Solo implementa lo que usa el bot, con el formato de la API real.
 *
 * Fallas que se pueden provocar:
 *   failNextCreate = 'timeout-after-create'   la orden SE CREA pero la respuesta se pierde
 *   failNextCreate = 'timeout-before-create'  la petición no llega: la orden NO se crea
 *   failQueries = true                        las consultas también fallan (red caída)
 *   fillRatio = 0.6                           las órdenes de mercado se ejecutan al 60% (EXPIRED)
 *   restNextOrder = true                      la próxima orden queda abierta (NEW), sin ejecutarse
 */
import fs from 'node:fs';

export const MARKET = JSON.parse(
  fs.readFileSync(new URL('../fixtures/binance-btc-usdt-market.json', import.meta.url), 'utf8'),
);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-mbx-used-weight-1m': '10' } });
const error = (code, msg, status = 400) => json({ code, msg }, status);
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const fmt = (n) => n.toFixed(8);
const STEP = 1e-5;

export class FakeBinance {
  constructor({ price = 84_000, balances = { BTC: 1, USDT: 10_000 }, commission = 0.001, commissionAssetOnBuy = 'BTC' } = {}) {
    Object.assign(this, { price, commission, commissionAssetOnBuy });
    this.balances = { ...balances };
    this.orders = []; // todas las órdenes creadas
    this.trades = [];
    this.nextOrderId = 1000;
    this.nextTradeId = 5000;
    this.requests = []; // [método, ruta] de cada petición recibida
    this.failNextCreate = null;
    this.failQueries = false;
    this.fillRatio = 1;
    this.restNextOrder = false;
    this.onCreate = null; // hook: se llama justo antes de procesar un POST /order
    // Velas: precio de cierre para la vela que empieza en t (ms). Por defecto, precio fijo.
    this.closeAt = () => this.price;
    this.historyStart = 0; // no hay velas antes de este instante (simula poco historial)
    this.fetch = this.fetch.bind(this);
  }

  count(method, path) {
    return this.requests.filter(([m, p]) => m === method && p === path).length;
  }

  /** Crea una orden abierta "externa" (hecha a mano en la cuenta, sin el bot). */
  addExternalOrder({ side = 'BUY', quantity = 0.001, price = 50_000, clientOrderId = 'web_manual_1' } = {}) {
    return this.#newOrder({ side, type: 'LIMIT', quantity, price, clientOrderId, rest: true });
  }

  async fetch(url, { method = 'GET', body } = {}) {
    const { pathname, searchParams } = new URL(url);
    const params = new URLSearchParams(method === 'GET' || method === 'DELETE' ? searchParams : body ?? '');
    this.requests.push([method, pathname]);

    if (method === 'POST' && pathname === '/api/v3/order') return this.#createOrder(params);
    if (method === 'GET' && pathname === '/api/v3/order') {
      if (this.failQueries) throw timeoutError();
      const order = this.orders.find((o) => o.clientOrderId === params.get('origClientOrderId') || String(o.orderId) === params.get('orderId'));
      return order ? json(this.#orderJson(order)) : error(-2013, 'Order does not exist.');
    }
    if (method === 'GET' && pathname === '/api/v3/myTrades') {
      if (this.failQueries) throw timeoutError();
      return json(this.trades.filter((t) => String(t.orderId) === params.get('orderId')));
    }
    if (method === 'GET' && pathname === '/api/v3/openOrders') {
      return json(this.orders.filter((o) => ['NEW', 'PARTIALLY_FILLED'].includes(o.status)).map((o) => this.#orderJson(o)));
    }
    if (method === 'DELETE' && pathname === '/api/v3/openOrders') {
      const open = this.orders.filter((o) => ['NEW', 'PARTIALLY_FILLED'].includes(o.status));
      if (open.length === 0) return error(-2011, 'Unknown order sent.');
      for (const o of open) o.status = 'CANCELED';
      return json(open.map((o) => this.#orderJson(o)));
    }
    if (method === 'DELETE' && pathname === '/api/v3/order') {
      const order = this.orders.find((o) => String(o.orderId) === params.get('orderId'));
      if (!order) return error(-2011, 'Unknown order sent.');
      order.status = 'CANCELED';
      return json(this.#orderJson(order));
    }
    if (method === 'GET' && pathname === '/api/v3/account') {
      return json({
        makerCommission: 10, takerCommission: 10, canTrade: true, accountType: 'SPOT', permissions: ['SPOT'],
        balances: Object.entries(this.balances).map(([asset, free]) => ({ asset, free: fmt(free), locked: '0.00000000' })),
      });
    }
    if (method === 'GET' && pathname === '/api/v3/time') return json({ serverTime: Date.now() });
    if (method === 'GET' && pathname === '/api/v3/exchangeInfo') {
      return json({
        timezone: 'UTC', serverTime: Date.now(), exchangeFilters: [], symbols: [MARKET.info],
        rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 }],
      });
    }
    if (method === 'GET' && pathname === '/api/v3/ticker/24hr') return json(this.#ticker());
    if (method === 'GET' && pathname === '/api/v3/klines') return json(this.#klines(params));
    throw new Error(`FakeBinance: endpoint no simulado ${method} ${pathname}`);
  }

  #createOrder(params) {
    this.onCreate?.(params);
    const failure = this.failNextCreate;
    this.failNextCreate = null;
    if (failure === 'timeout-before-create') throw timeoutError();

    const clientOrderId = params.get('newClientOrderId');
    if (this.orders.some((o) => o.clientOrderId === clientOrderId && ['NEW', 'PARTIALLY_FILLED'].includes(o.status))) {
      return error(-2010, 'Duplicate order sent.');
    }
    const order = this.#newOrder({
      side: params.get('side'), type: params.get('type'), quantity: Number(params.get('quantity')), clientOrderId,
      rest: this.restNextOrder,
    });
    this.restNextOrder = false;
    if (failure === 'timeout-after-create') throw timeoutError(); // creada, pero la respuesta se pierde
    return json({ ...this.#orderJson(order), fills: order.fills });
  }

  #newOrder({ side, type, quantity, price = null, clientOrderId, rest = false }) {
    const order = {
      orderId: this.nextOrderId++, clientOrderId, side, type, origQty: quantity, price,
      executedQty: 0, cummulativeQuoteQty: 0, status: 'NEW', time: Date.now(), fills: [],
    };
    this.orders.push(order);
    if (!rest && type === 'MARKET') {
      const qty = Math.floor((quantity * this.fillRatio) / STEP + 1e-9) * STEP;
      if (qty > 0) this.#fill(order, qty);
      order.status = qty + 1e-12 >= quantity ? 'FILLED' : 'EXPIRED'; // mercado sin liquidez suficiente
    }
    return order;
  }

  #fill(order, qty) {
    const { price } = this;
    const quote = qty * price;
    const commissionAsset = order.side === 'BUY' ? this.commissionAssetOnBuy : 'USDT';
    const commission = commissionAsset === 'BTC' ? qty * this.commission : quote * this.commission;
    const trade = {
      symbol: 'BTCUSDT', id: this.nextTradeId++, orderId: order.orderId, orderListId: -1,
      price: fmt(price), qty: fmt(qty), quoteQty: fmt(quote), commission: fmt(commission), commissionAsset,
      time: Date.now(), isBuyer: order.side === 'BUY', isMaker: false, isBestMatch: true,
    };
    this.trades.push(trade);
    order.fills.push({ price: trade.price, qty: trade.qty, commission: trade.commission, commissionAsset, tradeId: trade.id });
    order.executedQty += qty;
    order.cummulativeQuoteQty += quote;
    // saldos: la comisión se descuenta en su moneda
    const sign = order.side === 'BUY' ? 1 : -1;
    this.balances.BTC += sign * qty - (commissionAsset === 'BTC' ? commission : 0);
    this.balances.USDT += -sign * quote - (commissionAsset === 'USDT' ? commission : 0);
  }

  /** Velas de 1m con el formato de Binance; incluye la vela en curso, como la API real. */
  #klines(params) {
    const step = 60_000;
    const limit = Number(params.get('limit') ?? 500);
    const end = Math.min(Number(params.get('endTime') ?? Infinity), Date.now());
    const rows = [];
    let t = Math.max(Math.ceil(Number(params.get('startTime') ?? 0) / step) * step, this.historyStart);
    for (; t <= end && rows.length < limit; t += step) {
      const c = this.closeAt(t);
      rows.push([t, fmt(c), fmt(c * 1.001), fmt(c * 0.999), fmt(c), '1.00000000', t + step - 1, fmt(c), 10, '0.5', fmt(c / 2), '0']);
    }
    return rows;
  }

  #ticker() {
    const p = fmt(this.price);
    return {
      symbol: 'BTCUSDT', priceChange: '0', priceChangePercent: '0', weightedAvgPrice: p, prevClosePrice: p,
      lastPrice: p, lastQty: '0.001', bidPrice: p, bidQty: '1', askPrice: p, askQty: '1', openPrice: p,
      highPrice: p, lowPrice: p, volume: '100', quoteVolume: '8400000', openTime: Date.now() - 86_400_000,
      closeTime: Date.now(), firstId: 1, lastId: 100, count: 100,
    };
  }

  #orderJson(o) {
    return {
      symbol: 'BTCUSDT', orderId: o.orderId, orderListId: -1, clientOrderId: o.clientOrderId,
      price: fmt(o.price ?? 0), origQty: fmt(o.origQty), executedQty: fmt(o.executedQty),
      cummulativeQuoteQty: fmt(o.cummulativeQuoteQty), status: o.status, timeInForce: 'GTC', type: o.type,
      side: o.side, stopPrice: '0.00000000', icebergQty: '0.00000000', time: o.time, updateTime: o.time,
      isWorking: true, workingTime: o.time, origQuoteOrderQty: '0.00000000', selfTradePreventionMode: 'EXPIRE_MAKER',
      transactTime: o.time,
    };
  }
}
