/**
 * Dry-run: el MISMO flujo que las órdenes reales (riesgo → registro → ejecución →
 * posición), con comisión y slippage simulados, registrado con modo "dry-run".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { RiskCode } from '../../src/risk/risk-manager.js';
import { setupExecution } from '../support/execution-setup.js';
import { testEnv } from '../helpers.js';

let ctx;
beforeEach(async () => {
  ctx = await setupExecution({ mode: 'dry-run' });
  ctx.reconciler.report = { ok: true, differences: [] };
});
afterEach(async () => ctx.cleanup());

describe('dry-run', () => {
  it('está activado por defecto', () => {
    expect(loadConfig(testEnv()).dryRun).toBe(true);
    expect(loadConfig(testEnv()).mode).toBe('dry-run');
  });

  it('una compra simulada pasa por el riesgo, se registra como dry-run, con slippage y comisión', async () => {
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'd1' });
    expect(result.status).toBe('filled');
    const { order } = result;
    expect(order).toMatchObject({ env: 'testnet', mode: 'dry-run', exchangeOrderId: `paper-${order.clientOrderId}` });
    expect(order.clientOrderId).toMatch(/^sbtp-/); // "p" de paper
    const fillPrice = 84_000 * (1 + 5 / 10_000); // comprando se paga el slippage
    expect(order.avgFillPrice).toBeCloseTo(fillPrice, 9);
    expect(order.feeQuote).toBeCloseTo(0.00059 * fillPrice * 0.001, 12);
    expect(order.fills[0]).toMatchObject({ feeCurrency: 'USDT' });
    const [position] = ctx.risk.store.openPositions();
    expect(position).toMatchObject({ mode: 'dry-run', qty: 0.00059 });
    expect(position.entryCost).toBeCloseTo(0.00059 * fillPrice * 1.001, 9);
    expect(ctx.fake.requests).toEqual([]); // nada llegó a Binance
  });

  it('ida y vuelta al mismo precio: se pierde exactamente slippage + comisiones', async () => {
    await ctx.executor.submit({ side: 'buy', signalKey: 'b' });
    await ctx.executor.submit({ side: 'sell', signalKey: 's' });
    const buy = 84_000 * 1.0005;
    const sell = 84_000 * 0.9995;
    const expected = 0.00059 * sell * 0.999 - 0.00059 * buy * 1.001;
    expect(ctx.risk.dailyPnl().realized).toBeCloseTo(expected, 9);
    expect(expected).toBeLessThan(0);
  });

  it('los rechazos del riesgo también se registran en dry-run', async () => {
    ctx.risk.killSwitch.activate('prueba');
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'k' });
    expect(result.order).toMatchObject({ mode: 'dry-run', status: 'rejected', rejectCode: RiskCode.KILL_SWITCH });
  });

  it('duplicados bloqueados igual que con órdenes reales', async () => {
    await ctx.executor.submit({ side: 'buy', signalKey: 'same' });
    expect((await ctx.executor.submit({ side: 'buy', signalKey: 'same' })).code).toBe(RiskCode.DUPLICATE_SIGNAL);
  });

  it('ejecución parcial simulada: la posición refleja lo ejecutado', async () => {
    ctx.venue.fillRatio = 0.5;
    const { order } = await ctx.executor.submit({ side: 'buy', signalKey: 'p' });
    expect(order).toMatchObject({ status: 'expired', filledQty: 0.00029 });
    expect(ctx.risk.store.openPositions()[0].qty).toBe(0.00029);
  });

  it('una orden simulada que quedó "pending" (corte a mitad) se resuelve como no ejecutada', async () => {
    ctx.orders.create({ clientOrderId: 'sbtp-colgada', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.00059, price: 84_000 });
    const report = await ctx.reconciler.run();
    expect(report.ok).toBe(true);
    expect(ctx.orders.get('sbtp-colgada')).toMatchObject({ status: 'rejected', rejectCode: 'NOT_CREATED' });
  });

  it('los datos dry-run y los enviados al exchange nunca se mezclan', async () => {
    await ctx.executor.submit({ side: 'buy', signalKey: 'mix' });
    const live = await setupExecution({ mode: 'exchange', db: ctx.db });
    live.reconciler.report = { ok: true, differences: [] };
    expect(live.orders.list()).toHaveLength(0);
    expect(live.risk.store.openPositions()).toHaveLength(0);
    // la misma señal en el otro modo NO es un duplicado
    expect((await live.executor.submit({ side: 'buy', signalKey: 'mix' })).status).toBe('filled');
    await live.cleanup();
  });
});
