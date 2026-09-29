/**
 * Separación por entorno: la MISMA base de datos con datos de todos los
 * entornos y modos. Cada repositorio solo debe ver lo suyo, en consultas y reportes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utcDay } from '../../src/risk/pnl.js';
import { CandleStore } from '../../src/storage/candle-store.js';
import { openDatabase } from '../../src/storage/db.js';
import { OrderStore } from '../../src/storage/order-store.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { ALL_TRADING_SCOPES, ScopeError } from '../../src/storage/scope.js';

const H = 3_600_000;
const T0 = Date.parse('2026-09-28T00:00:00Z');
const NOW = Date.parse('2026-09-28T12:00:00Z');
const label = ({ env, mode }) => `${env}/${mode}`;

let db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

/** Llena los 4 ámbitos de trading con datos distintos (n órdenes, n posiciones cerradas…). */
function seedAllScopes() {
  ALL_TRADING_SCOPES.forEach((scope, i) => {
    const n = i + 1;
    const orders = new OrderStore(db, scope, { now: () => NOW });
    for (let k = 0; k < n; k++) {
      orders.create({ clientOrderId: `${label(scope)}-${k}`, symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.001, price: 84_000 });
    }
    orders.createRejected(
      { clientOrderId: `${label(scope)}-rej`, symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.001, price: 84_000 },
      { code: `CODE-${n}`, reason: 'r' },
    );
    // el MISMO ID de Binance en cada entorno (IDs de testnet y demo son independientes)
    orders.markAccepted(`${label(scope)}-0`, { exchangeOrderId: 12345 });

    const risk = new RiskStore(db, scope);
    const position = risk.insertPosition({ symbol: 'BTC/USDT', qty: 1, entryPrice: 100, entryFee: 0, entryCost: 100, entryTime: NOW });
    risk.closePosition(position.id, {
      exitQty: 1, exitPrice: 100 - n, exitFee: 0, exitProceeds: 100 - n, exitTime: NOW, exitDay: utcDay(NOW), realizedPnl: -n,
    });
    risk.insertPosition({ symbol: 'BTC/USDT', qty: n, entryPrice: 100, entryFee: 0, entryCost: 100 * n, entryTime: NOW });
    risk.addEvent({ time: NOW, type: 'TEST', message: label(scope) });
  });
}

describe('órdenes: consultas y reportes por entorno', () => {
  beforeEach(seedAllScopes);

  it.each(ALL_TRADING_SCOPES.map((scope, i) => [label(scope), scope, i + 1]))(
    '%s solo ve sus propias órdenes',
    (_name, scope, n) => {
      const orders = new OrderStore(db, scope);
      const all = orders.list();
      expect(all).toHaveLength(n + 1);
      expect(all.every((o) => o.env === scope.env && o.mode === scope.mode)).toBe(true);
      expect(orders.activeOrders()).toHaveLength(n);
      const report = orders.summary();
      expect(report).toMatchObject({ env: scope.env, mode: scope.mode, total: n + 1 });
      expect(report.rejections).toEqual([{ source: 'risk', code: `CODE-${n}`, count: 1 }]);
    },
  );

  it('una orden de otro entorno no se puede leer ni modificar', () => {
    const testnet = new OrderStore(db, { env: 'testnet', mode: 'exchange' });
    expect(testnet.get('demo/exchange-0')).toBeNull();
    expect(() => testnet.markCanceled('demo/exchange-0')).toThrow(/no existe la orden .* en testnet\/exchange/);
    expect(new OrderStore(db, { env: 'demo', mode: 'exchange' }).get('demo/exchange-0').status).toBe('open');
  });

  it('el mismo ID de Binance en dos entornos: cada uno encuentra el suyo', () => {
    for (const scope of ALL_TRADING_SCOPES) {
      expect(new OrderStore(db, scope).getByExchangeId(12345).clientOrderId).toBe(`${label(scope)}-0`);
    }
  });
});

describe('riesgo: posiciones, PnL, paradas y eventos por entorno', () => {
  beforeEach(seedAllScopes);

  it.each(ALL_TRADING_SCOPES.map((scope, i) => [label(scope), scope, i + 1]))(
    '%s solo ve su PnL, sus posiciones y sus eventos',
    (_name, scope, n) => {
      const risk = new RiskStore(db, scope);
      expect(risk.realizedForDay(utcDay(NOW))).toEqual({ pnl: -n, fees: 0, trades: 1 });
      expect(risk.openPositions().map((p) => p.qty)).toEqual([n]);
      expect(risk.recentEvents().map((e) => e.message)).toEqual([label(scope)]);
    },
  );

  it('una parada en un entorno no detiene a los demás', () => {
    new RiskStore(db, { env: 'demo', mode: 'exchange' }).setHalt({ code: 'DAILY_LOSS', reason: 'demo perdió', time: NOW });
    const halted = ALL_TRADING_SCOPES.filter((scope) => new RiskStore(db, scope).getHaltState().halted);
    expect(halted.map(label)).toEqual(['demo/exchange']);
  });

  it('haltAll (kill switch) detiene todos; reanudar uno no reanuda los demás', () => {
    expect(RiskStore.haltAll(db, { code: 'KILL_SWITCH', reason: 'kill', time: NOW })).toBe(4);
    new RiskStore(db, { env: 'testnet', mode: 'dry-run' }).clearHalt({ time: NOW, message: 'resume' });
    const halted = ALL_TRADING_SCOPES.filter((scope) => new RiskStore(db, scope).getHaltState().halted);
    expect(halted.map(label)).toEqual(['testnet/exchange', 'demo/dry-run', 'demo/exchange']);
  });

  it('una posición de otro entorno no se puede cerrar', () => {
    const demo = new RiskStore(db, { env: 'demo', mode: 'dry-run' });
    const [demoPosition] = demo.openPositions();
    const testnet = new RiskStore(db, { env: 'testnet', mode: 'dry-run' });
    expect(() =>
      testnet.closePosition(demoPosition.id, {
        exitQty: 1, exitPrice: 1, exitFee: 0, exitProceeds: 1, exitTime: NOW, exitDay: '2026-09-28', realizedPnl: 0,
      }),
    ).toThrow(/no existe en este ámbito/);
    expect(demo.openPositions()).toHaveLength(1);
  });
});

describe('velas: por entorno de datos', () => {
  const candle = (h, close) => ({ time: T0 + h * H, open: close, high: close, low: close, close, volume: 1 });

  it('las velas del testnet no se mezclan con las de producción (solo lectura)', () => {
    const prod = new CandleStore(db, { env: 'production-readonly' });
    const testnet = new CandleStore(db, { env: 'testnet' });
    prod.upsert('BTC/USDT', '1h', [candle(0, 84_000), candle(1, 84_100)], { now: NOW });
    // misma clave (par, intervalo, hora) en otro entorno: NO es duplicado
    expect(testnet.upsert('BTC/USDT', '1h', [candle(0, 60_000)], { now: NOW }).inserted).toBe(1);

    const range = { from: T0, to: T0 + 2 * H };
    expect(prod.get('BTC/USDT', '1h', range).map((c) => c.close)).toEqual([84_000, 84_100]);
    expect(testnet.get('BTC/USDT', '1h', range).map((c) => c.close)).toEqual([60_000]);
  });

  it('las velas de otro entorno no tapan huecos', () => {
    const prod = new CandleStore(db, { env: 'production-readonly' });
    new CandleStore(db, { env: 'testnet' }).upsert('BTC/USDT', '1h', [candle(1, 60_000)], { now: NOW });
    prod.upsert('BTC/USDT', '1h', [candle(0, 84_000), candle(2, 84_200)], { now: NOW });
    const report = prod.findGaps('BTC/USDT', '1h', { from: T0, to: T0 + 3 * H });
    expect(report).toMatchObject({ env: 'production-readonly', missing: 1 });
  });
});

describe('entornos inválidos', () => {
  it.each(['production-readonly', 'mainnet', undefined])('no hay órdenes ni riesgo en el entorno %s', (env) => {
    expect(() => new OrderStore(db, { env, mode: 'exchange' })).toThrow(ScopeError);
    expect(() => new RiskStore(db, { env, mode: 'exchange' })).toThrow(ScopeError);
  });

  it('modo inválido', () => {
    expect(() => new OrderStore(db, { env: 'testnet', mode: 'live' })).toThrow(/modo inválido/);
  });

  it.each(['mainnet', 'production', ''])('no hay velas del entorno "%s"', (env) => {
    expect(() => new CandleStore(db, { env })).toThrow(ScopeError);
  });
});
