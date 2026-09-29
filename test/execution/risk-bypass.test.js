/**
 * Intentos de enviar una orden SIN pasar por el gestor de riesgo. Todos deben fallar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafetyError } from '../../src/config/safety.js';
import { PaperVenue } from '../../src/execution/venues.js';
import { RiskBypassError, consumeApproval } from '../../src/risk/risk-manager.js';
import { MARKET } from '../support/fake-binance.js';
import { setupExecution } from '../support/execution-setup.js';

let ctx;
beforeEach(async () => {
  ctx = await setupExecution();
  ctx.reconciler.report = { ok: true, differences: [] };
});
afterEach(async () => ctx.cleanup());

const order = (extra = {}) => ({
  clientOrderId: 'sbtx-test-1', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.00059, price: 84_000, ...extra,
});
const approve = (o = order()) => ctx.risk.checkOrder(o, { market: MARKET }).approval;
const posts = () => ctx.fake.count('POST', '/api/v3/order');

describe('filtro de red: ninguna orden sale sin aprobación', () => {
  it('exchange.createOrder directo (sin clientOrderId propio) → bloqueado antes de salir', async () => {
    await expect(ctx.exchange.createOrder('BTC/USDT', 'market', 'buy', 0.00059)).rejects.toThrow(SafetyError);
    expect(posts()).toBe(0);
  });

  it('exchange.createOrder directo con un clientOrderId inventado → bloqueado', async () => {
    await expect(
      ctx.exchange.createOrder('BTC/USDT', 'market', 'buy', 0.00059, undefined, { newClientOrderId: 'inventado' }),
    ).rejects.toThrow(/sin aprobación del gestor de riesgo/);
    expect(posts()).toBe(0);
  });

  it('otros endpoints que crean órdenes (OCO, SOR, test) también se filtran', async () => {
    for (const path of ['order/oco', 'orderList/oco', 'sor/order', 'order/test']) {
      await expect(
        ctx.exchange.fetch(`https://testnet.binance.vision/api/v3/${path}`, 'POST', {}, 'symbol=BTCUSDT&newClientOrderId=x'),
      ).rejects.toThrow(SafetyError);
    }
    expect(ctx.fake.requests.filter(([m]) => m === 'POST')).toHaveLength(0);
  });

  it('la WebSocket API (otro canal para crear órdenes) está bloqueada', () => {
    expect(() => ctx.exchange.client('wss://ws-api.testnet.binance.vision/ws-api/v3')).toThrow(/WebSocket API bloqueada/);
  });

  it('cancelar y consultar no se filtran (no aumentan el riesgo)', async () => {
    ctx.fake.addExternalOrder({ clientOrderId: 'manual' });
    await expect(ctx.exchange.fetchOpenOrders('BTC/USDT')).resolves.toHaveLength(1);
    await expect(ctx.exchange.cancelAllOrders('BTC/USDT')).resolves.toHaveLength(1);
  });
});

describe('aprobaciones: auténticas, exactas y de un solo uso', () => {
  it('un objeto con la misma forma que una aprobación no sirve (no se puede fabricar)', () => {
    const forged = { ...approve(), issuedAt: Date.now() };
    expect(() => consumeApproval(forged, order())).toThrow(/sin aprobación auténtica/);
  });

  it('no sirve para una orden distinta de la aprobada', () => {
    expect(() => consumeApproval(approve(), order({ amount: 0.1 }))).toThrow(/no coincide con lo aprobado \(amount/);
    expect(() => consumeApproval(approve(), order({ side: 'sell' }))).toThrow(/side/);
    expect(() => consumeApproval(approve(), order({ clientOrderId: 'otro' }))).toThrow(/clientOrderId/);
  });

  it('se usa una sola vez', () => {
    const approval = approve();
    expect(consumeApproval(approval, order())).toBe(true);
    expect(() => consumeApproval(approval, order())).toThrow(/ya se usó/);
  });

  it('vence a los 30 s: hay que volver a evaluar el riesgo', () => {
    const approval = approve();
    expect(() => consumeApproval(approval, order(), { now: approval.issuedAt + 30_001 })).toThrow(/venció/);
  });

  it('no sirve en otro entorno o modo', () => {
    expect(() => consumeApproval(approve(), order(), { scope: { env: 'demo', mode: 'exchange' } })).toThrow(/otro entorno/);
  });

  it('una orden rechazada por el riesgo no trae aprobación', () => {
    ctx.risk.killSwitch.activate('prueba');
    const decision = ctx.risk.checkOrder(order(), { market: MARKET });
    expect(decision.ok).toBe(false);
    expect(decision.approval).toBeUndefined();
  });

  it('el envío real exige la aprobación: sin ella, el venue ni llega a la red', async () => {
    await expect(ctx.venue.place(order(), undefined)).rejects.toThrow(RiskBypassError);
    await expect(ctx.venue.place(order(), { ...approve() })).rejects.toThrow(RiskBypassError);
    expect(posts()).toBe(0);
  });

  it('el envío simulado (dry-run) exige lo mismo', async () => {
    const paper = new PaperVenue({ scope: { env: 'testnet', mode: 'dry-run' }, market: MARKET, feeRate: 0.001, slippageBps: 5 });
    await expect(paper.place(order(), undefined)).rejects.toThrow(RiskBypassError);
    await expect(paper.place(order(), approve())).rejects.toThrow(/otro entorno/); // aprobación de modo exchange
  });
});
