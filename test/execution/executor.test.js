/**
 * Ejecutor contra un Binance simulado por HTTP, pasando por el cliente ccxt real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskCode } from '../../src/risk/risk-manager.js';
import { setupExecution } from '../support/execution-setup.js';

let ctx;
beforeEach(async () => {
  ctx = await setupExecution();
  ctx.reconciler.report = { ok: true, differences: [] }; // reconciliada (se prueba aparte)
});
afterEach(async () => ctx.cleanup());

const POST_ORDER = ['POST', '/api/v3/order'];
const posts = () => ctx.fake.count(...POST_ORDER);
const openPositions = () => ctx.risk.store.openPositions();

describe('flujo normal', () => {
  it('compra: registra "pending" ANTES de enviar, luego ejecuciones, comisión y posición', async () => {
    let statusWhenSent;
    ctx.fake.onCreate = (params) => {
      statusWhenSent = ctx.orders.get(params.get('newClientOrderId'))?.status;
    };

    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'sma-cross:BTC/USDT:1:BUY', strategy: 'sma-cross', signalCode: 'GOLDEN_CROSS' });

    expect(statusWhenSent).toBe('pending'); // ya estaba guardada cuando llegó a "Binance"
    expect(result.status).toBe('filled');
    const order = result.order;
    expect(order).toMatchObject({
      env: 'testnet', mode: 'exchange', side: 'buy', type: 'market', amount: 0.00059,
      exchangeOrderId: '1000', filledQty: 0.00059, avgFillPrice: 84_000, signalKey: 'sma-cross:BTC/USDT:1:BUY',
    });
    expect(order.clientOrderId).toMatch(/^sbtx-/);
    expect(order.fills).toHaveLength(1);
    expect(order.fills[0]).toMatchObject({ feeCurrency: 'BTC', feeAmount: 0.00000059 });
    expect(order.feeQuote).toBeCloseTo(0.00000059 * 84_000, 9); // comisión en BTC valorada en USDT

    // La posición es lo que realmente quedó: lo ejecutado menos la comisión cobrada en BTC.
    const [position] = openPositions();
    expect(position.qty).toBeCloseTo(0.00059 - 0.00000059, 12);
    expect(position.entryCost).toBeCloseTo(0.00059 * 84_000, 9); // USDT que realmente salieron
    expect(position.entryOrderId).toBe(order.id);
  });

  it('venta: cierra la posición con la cantidad ejecutada y el PnL incluye comisiones', async () => {
    await ctx.executor.submit({ side: 'buy', signalKey: 'b' });
    ctx.fake.price = 85_000;
    const result = await ctx.executor.submit({ side: 'sell', signalKey: 's' });
    expect(result.status).toBe('filled');
    expect(result.order.amount).toBe(0.00058); // posición 0.00058941 → paso 0.00001 (el resto es "dust")
    expect(openPositions()).toHaveLength(0);
    const { realized, closedTrades } = ctx.risk.dailyPnl();
    expect(closedTrades).toBe(1);
    // 0.00058 × 85 000 − 0.1% − 0.00059 × 84 000 = 49.2507 − 49.56
    expect(realized).toBeCloseTo(0.00058 * 85_000 * 0.999 - 0.00059 * 84_000, 6);
  });
});

describe('timeouts: consultar por clientOrderId en lugar de reenviar', () => {
  it('timeout con la orden SÍ creada: la encuentra, registra su ejecución y la posición; no reenvía', async () => {
    ctx.fake.failNextCreate = 'timeout-after-create';
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'k1' });

    expect(posts()).toBe(1); // un solo envío
    expect(ctx.fake.count('GET', '/api/v3/order')).toBe(1); // consulta por clientOrderId
    expect(ctx.fake.count('GET', '/api/v3/myTrades')).toBe(1); // y sus ejecuciones
    expect(ctx.executor.sleep).toHaveBeenCalledWith(6000); // esperó a que venciera la ventana de Binance
    expect(result.status).toBe('filled');
    expect(result.order.fills).toHaveLength(1);
    expect(openPositions()).toHaveLength(1);
    expect(ctx.logs.messages().join('\n')).toMatch(/no se reenvía/);
  });

  it('timeout con la orden NO creada: la marca como no creada; no reenvía ni abre posición', async () => {
    ctx.fake.failNextCreate = 'timeout-before-create';
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'k2' });

    expect(posts()).toBe(1);
    expect(ctx.fake.orders).toHaveLength(0);
    expect(result.status).toBe('not_created');
    expect(result.order).toMatchObject({ status: 'rejected', rejectSource: 'exchange', rejectCode: 'NOT_CREATED' });
    expect(openPositions()).toHaveLength(0);
  });

  it('si tampoco se puede consultar: queda "pending" y bloquea nuevas órdenes hasta resolverla', async () => {
    ctx.fake.failNextCreate = 'timeout-after-create';
    ctx.fake.failQueries = true;
    const first = await ctx.executor.submit({ side: 'buy', signalKey: 'k3' });
    expect(first.status).toBe('unknown');
    expect(first.order.status).toBe('pending');

    const second = await ctx.executor.submit({ side: 'buy', signalKey: 'k4' });
    expect(second).toMatchObject({ status: 'rejected', code: RiskCode.ORDER_IN_FLIGHT });
    expect(posts()).toBe(1);

    // Vuelve la red: la reconciliación la resuelve (sí se había creado).
    ctx.fake.failQueries = false;
    const resolved = await ctx.executor.resolveActive();
    expect(resolved).toEqual([{ clientOrderId: first.order.clientOrderId, status: 'filled', found: true }]);
    expect(openPositions()).toHaveLength(1);
  });
});

describe('reenvío duplicado bloqueado', () => {
  it('la misma señal dos veces produce UNA sola orden', async () => {
    const signal = { side: 'buy', signalKey: 'sma-cross:BTC/USDT:1790000000000:BUY' };
    const first = await ctx.executor.submit(signal);
    const second = await ctx.executor.submit(signal);
    expect(first.status).toBe('filled');
    expect(second).toMatchObject({ status: 'rejected', code: RiskCode.DUPLICATE_SIGNAL });
    expect(second.reason).toMatch(new RegExp(`ya generó la orden ${first.order.clientOrderId}`));
    expect(posts()).toBe(1);
  });

  it('dos envíos simultáneos: el segundo espera y es rechazado (no hay carreras)', async () => {
    const [a, b] = await Promise.all([
      ctx.executor.submit({ side: 'buy', signalKey: 'x' }),
      ctx.executor.submit({ side: 'buy', signalKey: 'x' }),
    ]);
    expect([a.status, b.status]).toEqual(['filled', 'rejected']);
    expect(posts()).toBe(1);
  });

  it('reenviar un clientOrderId ya enviado, directamente con ccxt, lo bloquea el filtro de red', async () => {
    const { order } = await ctx.executor.submit({ side: 'buy', signalKey: 'y' });
    await expect(
      ctx.exchange.createOrder('BTC/USDT', 'market', 'buy', 0.00059, undefined, { newClientOrderId: order.clientOrderId }),
    ).rejects.toThrow(/reenvío bloqueado/);
    expect(posts()).toBe(1);
  });
});

describe('ejecuciones parciales', () => {
  it('compra ejecutada al 60%: la posición refleja lo realmente ejecutado', async () => {
    ctx.fake.fillRatio = 0.6;
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'p1' });
    expect(result.order).toMatchObject({ status: 'expired', amount: 0.00059, filledQty: 0.00035 });
    const [position] = openPositions();
    expect(position.qty).toBeCloseTo(0.00035 * 0.999, 12); // menos la comisión en BTC
    expect(ctx.logs.messages().join('\n')).toMatch(/Ejecución parcial: se ejecutó 0.00035 de 0.00059/);
  });

  it('venta ejecutada al 50%: la posición sigue abierta con lo que queda', async () => {
    ctx.fake.commissionAssetOnBuy = 'USDT'; // posición redonda para ver bien la división
    await ctx.executor.submit({ side: 'buy', signalKey: 'b' });
    expect(openPositions()[0].qty).toBe(0.00059);

    ctx.fake.fillRatio = 0.5;
    const sell = await ctx.executor.submit({ side: 'sell', signalKey: 's' });
    expect(sell.order).toMatchObject({ status: 'expired', filledQty: 0.00029 });

    const [remaining] = openPositions();
    expect(remaining.qty).toBeCloseTo(0.0003, 12);
    expect(remaining.entryCost).toBeCloseTo((0.00059 * 84_000 * 1.001) * (0.0003 / 0.00059), 9);
    expect(ctx.risk.dailyPnl().closedTrades).toBe(1); // la parte vendida es una operación cerrada
  });

  it('aplicar dos veces la misma orden no duplica la posición (idempotente)', async () => {
    const { order } = await ctx.executor.submit({ side: 'buy', signalKey: 'i' });
    ctx.orders.db.prepare("UPDATE orders SET status = 'open' WHERE id = ?").run(order.id); // simula un reproceso
    await ctx.executor.resolveActive();
    expect(openPositions()).toHaveLength(1);
  });
});

describe('rechazo por riesgo: la orden se registra y nunca sale', () => {
  it('con el bot detenido', async () => {
    ctx.risk.store.setHalt({ code: 'DAILY_LOSS', reason: 'prueba', time: Date.now() });
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'r1' });
    expect(result).toMatchObject({ status: 'rejected', code: RiskCode.HALTED });
    expect(result.order).toMatchObject({ status: 'rejected', rejectSource: 'risk', rejectCode: 'HALTED', signalKey: 'r1' });
    expect(posts()).toBe(0);
  });

  it('por máximo de posiciones abiertas', async () => {
    await ctx.executor.submit({ side: 'buy', signalKey: 'a' });
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'b' });
    expect(result.code).toBe(RiskCode.MAX_POSITIONS);
    expect(posts()).toBe(1);
  });

  it('rechazo del exchange (fondos insuficientes): registrado con su código, sin posición', async () => {
    const originalFetch = ctx.fake.fetch;
    ctx.exchange.fetchImplementation = async (url, init) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ code: -2010, msg: 'Account has insufficient balance for requested action.' }), { status: 400 })
        : originalFetch(url, init);
    const result = await ctx.executor.submit({ side: 'buy', signalKey: 'f' });
    // ccxt traduce el -2010 de Binance a su error InsufficientFunds; el texto original queda en el motivo
    expect(result.order).toMatchObject({ status: 'rejected', rejectSource: 'exchange', rejectCode: 'InsufficientFunds' });
    expect(result.order.rejectReason).toMatch(/insufficient balance/);
    expect(openPositions()).toHaveLength(0);
  });

  it('una venta sin posición no genera orden', async () => {
    const result = await ctx.executor.submit({ side: 'sell', signalKey: 'v' });
    expect(result.status).toBe('skipped');
    expect(ctx.orders.list()).toHaveLength(0);
  });
});

describe('parada de emergencia', () => {
  it('cancela en Binance las órdenes abiertas y registra su estado final', async () => {
    ctx.fake.restNextOrder = true; // queda abierta sin ejecutarse
    const { order } = await ctx.executor.submit({ side: 'buy', signalKey: 'o' });
    expect(order.status).toBe('open');
    const result = await ctx.risk.emergencyStop({ code: 'KILL_SWITCH', reason: 'prueba', cancelOpenOrders: () => ctx.executor.cancelAll() });
    expect(result.cancelled).toHaveLength(1);
    expect(ctx.orders.get(order.clientOrderId).status).toBe('canceled');
    expect(ctx.fake.count('DELETE', '/api/v3/openOrders')).toBe(1);
  });
});
