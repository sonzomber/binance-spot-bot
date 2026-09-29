import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_ORDER_ID_PATTERN, newClientOrderId } from '../../src/lib/ids.js';
import { openDatabase } from '../../src/storage/db.js';
import { OrderStatus, OrderStore, OrderStoreError } from '../../src/storage/order-store.js';
import { createClock } from '../helpers.js';

const SCOPE = { env: 'testnet', mode: 'exchange' };
let db;
let clock;
let orders;
beforeEach(() => {
  db = openDatabase(':memory:');
  clock = createClock('2026-09-28T12:00:00.000Z');
  orders = new OrderStore(db, SCOPE, { now: clock.now });
});
afterEach(() => db.close());

const marketBuy = (clientOrderId = 'sbtx-1', extra = {}) => ({
  clientOrderId, symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.003, price: 84_000,
  strategy: 'sma-cross', signalCode: 'GOLDEN_CROSS', ...extra,
});

describe('clientOrderId', () => {
  it('cumple el formato de Binance y es único', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newClientOrderId(SCOPE)));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(CLIENT_ORDER_ID_PATTERN);
      expect(id.length).toBeLessThanOrEqual(36);
    }
  });

  it('su prefijo indica entorno y modo', () => {
    expect(newClientOrderId({ env: 'testnet', mode: 'dry-run' })).toMatch(/^sbtp-/);
    expect(newClientOrderId({ env: 'demo', mode: 'exchange' })).toMatch(/^sbdx-/);
  });
});

describe('ciclo de vida de una orden', () => {
  it('guarda todos los campos requeridos', () => {
    const order = orders.create(marketBuy());
    expect(order).toMatchObject({
      env: 'testnet',
      mode: 'exchange',
      clientOrderId: 'sbtx-1',
      exchangeOrderId: null,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount: 0.003,
      price: 84_000,
      status: OrderStatus.PENDING,
      filledQty: 0,
      feeQuote: 0,
      strategy: 'sma-cross',
      signalCode: 'GOLDEN_CROSS',
      createdAt: '2026-09-28T12:00:00.000Z',
      updatedAt: '2026-09-28T12:00:00.000Z',
      acceptedAt: null,
      closedAt: null,
      fills: [],
    });
  });

  it('pending → open (con ID de Binance) → partially_filled → filled', () => {
    orders.create(marketBuy());
    clock.advance(100);
    const accepted = orders.markAccepted('sbtx-1', { exchangeOrderId: 987654321 });
    expect(accepted).toMatchObject({ status: 'open', exchangeOrderId: '987654321', acceptedAt: '2026-09-28T12:00:00.100Z' });

    clock.advance(100);
    const first = orders.addFill('sbtx-1', { tradeId: 1, qty: 0.001, price: 84_000, feeAmount: 0.000001, feeCurrency: 'BTC', feeQuote: 0.084 });
    expect(first.order).toMatchObject({ status: 'partially_filled', filledQty: 0.001, closedAt: null });

    clock.advance(100);
    const second = orders.addFill('sbtx-1', { tradeId: 2, qty: 0.002, price: 84_030, feeAmount: 0.16806, feeCurrency: 'USDT', feeQuote: 0.16806 });
    const order = second.order;
    expect(order.status).toBe('filled');
    expect(order.filledQty).toBeCloseTo(0.003, 12);
    expect(order.filledQuote).toBeCloseTo(84 + 168.06, 9);
    expect(order.avgFillPrice).toBeCloseTo(84_020, 6); // promedio ponderado por cantidad
    expect(order.feeQuote).toBeCloseTo(0.25206, 9);
    expect(order.closedAt).toBe('2026-09-28T12:00:00.300Z');
    expect(order.fills).toEqual([
      { tradeId: '1', qty: 0.001, price: 84_000, feeAmount: 0.000001, feeCurrency: 'BTC', feeQuote: 0.084, time: '2026-09-28T12:00:00.200Z' },
      { tradeId: '2', qty: 0.002, price: 84_030, feeAmount: 0.16806, feeCurrency: 'USDT', feeQuote: 0.16806, time: '2026-09-28T12:00:00.300Z' },
    ]);
    expect(orders.getByExchangeId('987654321').clientOrderId).toBe('sbtx-1');
  });

  it('la misma ejecución (tradeId) no se cuenta dos veces', () => {
    orders.create(marketBuy());
    orders.markAccepted('sbtx-1', { exchangeOrderId: 1 });
    const fill = { tradeId: 'T-1', qty: 0.001, price: 84_000, feeQuote: 0.084 };
    expect(orders.addFill('sbtx-1', fill).duplicate).toBe(false);
    const again = orders.addFill('sbtx-1', fill); // p. ej. llega por WebSocket y por REST
    expect(again.duplicate).toBe(true);
    expect(again.order).toMatchObject({ filledQty: 0.001, feeQuote: 0.084, status: 'partially_filled' });
    expect(again.order.fills).toHaveLength(1);
  });

  it('rechaza ejecuciones que superan la cantidad pedida', () => {
    orders.create(marketBuy());
    orders.addFill('sbtx-1', { tradeId: 1, qty: 0.003, price: 84_000 });
    expect(() => orders.addFill('sbtx-1', { tradeId: 2, qty: 0.0001, price: 84_000 })).toThrow(/más que lo pedido/);
    expect(orders.get('sbtx-1').fills).toHaveLength(1); // la transacción se revirtió
  });

  it('cancelada con ejecución parcial: conserva lo ejecutado', () => {
    orders.create({ ...marketBuy(), type: 'limit', price: 83_000 });
    orders.markAccepted('sbtx-1', { exchangeOrderId: 5 });
    orders.addFill('sbtx-1', { tradeId: 1, qty: 0.001, price: 83_000 });
    const canceled = orders.markCanceled('sbtx-1');
    expect(canceled).toMatchObject({ status: 'canceled', filledQty: 0.001 });
    expect(canceled.closedAt).not.toBeNull();
    // una ejecución que ocurrió antes de cancelar pero llega tarde: suma, sin reabrir la orden
    const late = orders.addFill('sbtx-1', { tradeId: 2, qty: 0.001, price: 83_000 });
    expect(late.order).toMatchObject({ status: 'canceled', filledQty: 0.002 });
    expect(orders.markCanceled('sbtx-1').status).toBe('canceled'); // idempotente
  });

  it('transiciones inválidas', () => {
    orders.create(marketBuy());
    orders.addFill('sbtx-1', { tradeId: 1, qty: 0.003, price: 84_000 });
    expect(() => orders.markCanceled('sbtx-1')).toThrow(/no se puede cancelar .* está filled/);
    expect(() => orders.markAccepted('sbtx-1', { exchangeOrderId: 1 })).toThrow(/no se puede aceptar/);
    expect(() => orders.markRejected('sbtx-1', { reason: 'x' })).toThrow(/no se puede rechazar/);
    expect(() => orders.get('no-existe')).not.toThrow();
    expect(() => orders.markCanceled('no-existe')).toThrow(OrderStoreError);
  });

  it('clientOrderId duplicado → error claro', () => {
    orders.create(marketBuy());
    expect(() => orders.create(marketBuy())).toThrow(/clientOrderId duplicado: sbtx-1/);
  });
});

describe('órdenes rechazadas (también se registran)', () => {
  it('rechazada por el gestor de riesgo: nunca se envió, con código y motivo', () => {
    const order = orders.createRejected(marketBuy('sbtx-r'), {
      code: 'MAX_TRADE',
      reason: 'costo estimado 50.47 USDT supera MAX_TRADE_USDT=50',
    });
    expect(order).toMatchObject({
      status: 'rejected',
      rejectSource: 'risk',
      rejectCode: 'MAX_TRADE',
      rejectReason: 'costo estimado 50.47 USDT supera MAX_TRADE_USDT=50',
      exchangeOrderId: null,
      closedAt: '2026-09-28T12:00:00.000Z',
    });
  });

  it('rechazada por el exchange', () => {
    orders.create(marketBuy());
    const order = orders.markRejected('sbtx-1', { code: '-2010', reason: 'Account has insufficient balance' });
    expect(order).toMatchObject({ status: 'rejected', rejectSource: 'exchange', rejectCode: '-2010' });
  });

  it('una orden rechazada no puede tener ejecuciones', () => {
    orders.createRejected(marketBuy(), { code: 'HALTED', reason: 'bot detenido' });
    expect(() => orders.addFill('sbtx-1', { tradeId: 1, qty: 0.001, price: 1 })).toThrow(/fue rechazada/);
  });

  it('la base de datos exige el motivo de un rechazo', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO orders (env, mode, client_order_id, symbol, side, type, amount, status, created_at, updated_at)
           VALUES ('testnet', 'exchange', 'x', 'BTC/USDT', 'buy', 'market', 1, 'rejected', 't', 't')`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });
});

describe('consultas y reportes', () => {
  it('activeOrders: solo las vivas (las que una parada debe cancelar)', () => {
    orders.create(marketBuy('a'));
    orders.create(marketBuy('b'));
    orders.markAccepted('b', { exchangeOrderId: 2 });
    orders.create(marketBuy('c'));
    orders.addFill('c', { tradeId: 1, qty: 0.001, price: 84_000 });
    orders.create(marketBuy('d'));
    orders.addFill('d', { tradeId: 1, qty: 0.003, price: 84_000 });
    orders.createRejected(marketBuy('e'), { code: 'X', reason: 'y' });
    expect(orders.activeOrders().map((o) => [o.clientOrderId, o.status])).toEqual([
      ['a', 'pending'], ['b', 'open'], ['c', 'partially_filled'],
    ]);
  });

  it('summary: por estado, volumen, comisiones y motivos de rechazo, dentro del rango', () => {
    orders.create(marketBuy('a'));
    orders.addFill('a', { tradeId: 1, qty: 0.003, price: 84_000, feeQuote: 0.252 });
    orders.createRejected(marketBuy('b'), { code: 'MAX_TRADE', reason: 'r' });
    orders.createRejected(marketBuy('c'), { code: 'MAX_TRADE', reason: 'r' });
    clock.set('2026-09-29T01:00:00Z'); // otro día
    orders.create(marketBuy('d'));

    const day = orders.summary({ from: Date.parse('2026-09-28T00:00:00Z'), to: Date.parse('2026-09-29T00:00:00Z') });
    expect(day).toMatchObject({ env: 'testnet', mode: 'exchange', total: 3, filledQuote: 252, fees: 0.252 });
    expect(day.byStatus).toMatchObject({ filled: 1, rejected: 2, pending: 0 });
    expect(day.rejections).toEqual([{ source: 'risk', code: 'MAX_TRADE', count: 2 }]);
    expect(orders.summary().total).toBe(4); // sin rango: todas
    expect(orders.list({ from: Date.parse('2026-09-29T00:00:00Z') }).map((o) => o.clientOrderId)).toEqual(['d']);
  });
});
