/**
 * Reconciliación al iniciar contra un Binance simulado: órdenes abiertas y saldos.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskCode } from '../../src/risk/risk-manager.js';
import { setupExecution } from '../support/execution-setup.js';

let ctx;
beforeEach(async () => { ctx = await setupExecution(); });
afterEach(async () => ctx.cleanup());

const types = (report) => report.differences.map((d) => d.type);

describe('antes de reconciliar no se opera', () => {
  it('el riesgo rechaza órdenes hasta que la reconciliación pase', async () => {
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'x' });
    expect(result).toMatchObject({ status: 'rejected', code: RiskCode.RECONCILIATION });
    expect(result.reason).toMatch(/todavía no se reconcilió/);
    expect(ctx.fake.count('POST', '/api/v3/order')).toBe(0);
  });
});

describe('sin diferencias', () => {
  it('primera vez: toma los saldos actuales como referencia y permite operar', async () => {
    const report = await ctx.reconciler.run();
    expect(report).toMatchObject({ ok: true, differences: [] });
    expect(ctx.balances.latest('BTC')).toMatchObject({ amount: 1, reason: 'referencia inicial' });
    expect(ctx.balances.latest('USDT')).toMatchObject({ amount: 10_000 });
    expect((await ctx.executor.submit({ side: 'buy', signalKey: 'a' })).status).toBe('filled');
  });

  it('después de operar, los saldos esperados (referencia + ejecuciones − comisiones) coinciden', async () => {
    await ctx.reconciler.run();
    await ctx.executor.submit({ side: 'buy', signalKey: 'b' });
    ctx.fake.price = 86_000;
    await ctx.executor.submit({ side: 'sell', signalKey: 's' });
    const report = await ctx.reconciler.run();
    expect(report.ok).toBe(true);
    expect(ctx.risk.store.recentEvents(1)[0]).toMatchObject({ type: 'RECONCILIATION', code: 'OK' });
  });

  it('una orden local que quedó a medias (corte) se resuelve consultando su estado real', async () => {
    await ctx.reconciler.run();
    ctx.fake.failNextCreate = 'timeout-after-create';
    ctx.fake.failQueries = true;
    const { order } = await ctx.executor.submit({ side: 'buy', signalKey: 'c' });
    expect(order.status).toBe('pending');

    ctx.fake.failQueries = false; // "reinicio": la red volvió
    const report = await ctx.reconciler.run();
    expect(report.ok).toBe(true);
    expect(report.resolved).toEqual([{ clientOrderId: order.clientOrderId, status: 'filled', found: true }]);
    expect(ctx.risk.store.openPositions()).toHaveLength(1);
  });
});

describe('diferencias: se registran y no se opera hasta resolverlas', () => {
  it('orden abierta en Binance que el bot no registró', async () => {
    await ctx.reconciler.run();
    const external = ctx.fake.addExternalOrder({ clientOrderId: 'web_manual_7' });
    const report = await ctx.reconciler.run();

    expect(types(report)).toEqual(['UNKNOWN_EXCHANGE_ORDER']);
    expect(report.differences[0]).toMatchObject({ exchangeOrderId: String(external.orderId) });
    expect(report.differences[0].detail).toMatch(/web_manual_7/);
    expect(ctx.logs.messages().join('\n')).toMatch(/No se operará hasta resolver las diferencias/);
    expect(ctx.risk.store.recentEvents(1)[0]).toMatchObject({ type: 'RECONCILIATION', code: 'DIFFERENCES' });

    const blocked = await ctx.executor.submit({ side: 'buy', signalKey: 'z' });
    expect(blocked).toMatchObject({ status: 'rejected', code: RiskCode.RECONCILIATION });
    expect(blocked.reason).toMatch(/1 diferencia\(s\) sin resolver/);
  });

  it('saldo que no coincide (p. ej. alguien operó a mano o el testnet reinició saldos)', async () => {
    await ctx.reconciler.run();
    ctx.fake.balances.BTC += 0.5; // cambio fuera del bot
    const report = await ctx.reconciler.run();
    expect(types(report)).toEqual(['BALANCE_MISMATCH']);
    expect(report.differences[0]).toMatchObject({ asset: 'BTC', expected: 1, actual: 1.5 });
    expect(ctx.risk.checkOrder(
      { clientOrderId: 'q', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.00059, price: 84_000 },
      { market: ctx.executor.market },
    ).code).toBe(RiskCode.RECONCILIATION);
  });

  it('orden registrada como abierta que ya no existe en Binance', async () => {
    await ctx.reconciler.run();
    ctx.orders.create({ clientOrderId: 'sbtx-perdida', symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.001, price: 50_000 });
    ctx.orders.markAccepted('sbtx-perdida', { exchangeOrderId: 99_999 });
    const report = await ctx.reconciler.run();
    expect(types(report)).toContain('LOCAL_ORDER_MISSING');
  });

  it('si no se puede consultar Binance, es una diferencia (no se asume nada)', async () => {
    await ctx.reconciler.run();
    ctx.orders.create({ clientOrderId: 'sbtx-x', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.001, price: 84_000 });
    ctx.fake.failQueries = true;
    const report = await ctx.reconciler.run();
    expect(types(report)).toContain('ORDER_UNRESOLVED');
  });
});

describe('resolución manual', () => {
  it('aceptar los saldos actuales como nueva referencia resuelve la diferencia de saldo', async () => {
    await ctx.reconciler.run();
    ctx.fake.balances.USDT = 25_000; // p. ej. reinicio mensual del testnet
    expect((await ctx.reconciler.run()).ok).toBe(false);

    await ctx.reconciler.acceptCurrentBalances('reinicio del testnet revisado');
    expect(ctx.balances.latest('USDT')).toMatchObject({ amount: 25_000, reason: 'reinicio del testnet revisado' });
    expect((await ctx.reconciler.run()).ok).toBe(true);
    expect((await ctx.executor.submit({ side: 'buy', signalKey: 'ok' })).status).toBe('filled');
  });

  it('cancelar la orden desconocida resuelve esa diferencia', async () => {
    await ctx.reconciler.run();
    const external = ctx.fake.addExternalOrder();
    expect((await ctx.reconciler.run()).ok).toBe(false);
    await ctx.exchange.cancelOrder(String(external.orderId), 'BTC/USDT');
    expect((await ctx.reconciler.run()).ok).toBe(true);
  });
});
