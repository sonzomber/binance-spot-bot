import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskCode, RiskError, RiskManager } from '../../src/risk/risk-manager.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { BTC_USDT_MARKET as market, captureLogger, createClock, tempDir } from '../helpers.js';

const SYMBOL = 'BTC/USDT';
const cleanups = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** RiskManager con SQLite en memoria, reloj controlable y logger capturado. */
async function setup({
  limits = {},
  scope = { env: 'testnet', mode: 'dry-run' },
  feeRate = 0.001,
  slippageBps = 5,
  db,
  clock,
} = {}) {
  const tmp = await tempDir();
  const capture = await captureLogger();
  const database = db ?? openDatabase(':memory:');
  const theClock = clock ?? createClock();
  const risk = new RiskManager({
    store: new RiskStore(database, scope),
    killSwitch: new KillSwitch(path.join(tmp.dir, 'STOP')),
    limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1, ...limits },
    feeRate,
    slippageBps,
    logger: capture.logger,
    now: theClock.now,
  });
  cleanups.push(() => { if (!db) database.close(); tmp.cleanup(); });
  return { risk, db: database, clock: theClock, ...capture };
}

const order = (side, amount, price, type = 'market') => ({ symbol: SYMBOL, side, type, amount, price });

/** Registra una compra y su venta (operación completa). */
function roundTrip(risk, { qty, buy, sell, buyFee = 0, sellFee = 0 }) {
  risk.recordEntry({ symbol: SYMBOL, qty, price: buy, feeQuote: buyFee });
  return risk.recordExit({ symbol: SYMBOL, qty, price: sell, feeQuote: sellFee });
}

const noOrders = async () => [];

// ---------------------------------------------------------------------------------
describe('límite: monto máximo por operación (MAX_TRADE_USDT)', () => {
  it('sizeBuy usa el presupuesto con margen para slippage y comisión, redondeando al paso', async () => {
    const { risk } = await setup();
    const size = risk.sizeBuy({ market, price: 84_000 });
    // 50 / (84 000 × 1.0005 × 1.001) = 0.000594… → 0.00059 (paso 0.00001)
    expect(size.amount).toBe(0.00059);
    expect(size.estimatedCost).toBeLessThanOrEqual(50);
    expect(risk.checkOrder(order('buy', size.amount, 84_000), { market }).ok).toBe(true);
  });

  it('rechaza una compra cuyo costo supera el máximo', async () => {
    const { risk } = await setup();
    const result = risk.checkOrder(order('buy', 0.0006, 84_000), { market });
    expect(result).toMatchObject({ ok: false, code: RiskCode.MAX_TRADE });
  });

  it('el costo incluye comisión y slippage: 50 USDT exactos de valor ya no caben', async () => {
    const { risk } = await setup();
    // 0.001 × 50 000 = 50.00 de valor, pero con 0.05% slippage y 0.1% comisión = 50.08
    const result = risk.checkOrder(order('buy', 0.001, 50_000), { market });
    expect(result.code).toBe(RiskCode.MAX_TRADE);
    expect(result.reason).toMatch(/50\.08 USDT/);
  });

  it('vender no está limitado por MAX_TRADE_USDT (cerrar posición reduce el riesgo)', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000, feeQuote: 0.05 });
    // el precio se duplicó: vender vale ~99 USDT > 50
    expect(risk.checkOrder(order('sell', 0.00059, 168_000), { market }).ok).toBe(true);
  });

  it('rechaza si el saldo libre no alcanza', async () => {
    const { risk } = await setup();
    const result = risk.checkOrder(order('buy', 0.00059, 84_000), { market, freeQuote: 10 });
    expect(result.code).toBe(RiskCode.INSUFFICIENT_BALANCE);
  });

  it('assertTradable: si MAX_TRADE_USDT no alcanza el mínimo del par, el bot no arranca', async () => {
    const { risk } = await setup({ limits: { maxTradeUsdt: 4 } });
    expect(() => risk.assertTradable(market, 84_000)).toThrow(RiskError);
    expect(() => risk.assertTradable(market, 84_000)).toThrow(/mínimo del par \(5 USDT\).*Sube MAX_TRADE_USDT/);
    const ok = await setup({ limits: { maxTradeUsdt: 50 } });
    expect(() => ok.risk.assertTradable(market, 84_000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------
describe('límite: máximo de posiciones abiertas (MAX_OPEN_POSITIONS)', () => {
  it('por defecto 1: con una posición abierta no se compra otra', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    const result = risk.checkOrder(order('buy', 0.00059, 84_000), { market });
    expect(result).toMatchObject({ ok: false, code: RiskCode.MAX_POSITIONS });
    expect(result.reason).toMatch(/hay 1 posición\(es\) abierta\(s\) y el máximo es 1/);
  });

  it('configurable: con 2 permite dos y rechaza la tercera; cerrar libera el cupo', async () => {
    const { risk } = await setup({ limits: { maxOpenPositions: 2 } });
    const buy = () => risk.checkOrder(order('buy', 0.00059, 84_000), { market });
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    expect(buy().ok).toBe(true);
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    expect(buy().code).toBe(RiskCode.MAX_POSITIONS);
    risk.recordExit({ symbol: SYMBOL, qty: 0.00059, price: 84_100 });
    expect(buy().ok).toBe(true);
  });

  it('las posiciones de un entorno/modo no cuentan en otro', async () => {
    const db = openDatabase(':memory:');
    cleanups.push(() => db.close());
    const dry = await setup({ db, scope: { env: 'testnet', mode: 'dry-run' } });
    const sent = await setup({ db, scope: { env: 'testnet', mode: 'exchange' } });
    const demo = await setup({ db, scope: { env: 'demo', mode: 'dry-run' } });
    dry.risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    expect(dry.risk.checkOrder(order('buy', 0.00059, 84_000), { market }).code).toBe(RiskCode.MAX_POSITIONS);
    expect(sent.risk.checkOrder(order('buy', 0.00059, 84_000), { market }).ok).toBe(true);
    expect(demo.risk.checkOrder(order('buy', 0.00059, 84_000), { market }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
describe('límite: filtros del par en Binance', () => {
  it('cantidad con más decimales que el paso', async () => {
    const { risk } = await setup();
    // 0.000405 BTC ≈ 34 USDT: cabe en MAX_TRADE_USDT, pero tiene 6 decimales
    const result = risk.checkOrder(order('buy', 0.000405, 84_000), { market });
    expect(result.code).toBe(RiskCode.MARKET_FILTER);
    expect(result.violations.join()).toMatch(/máx\. 5 decimales/);
  });

  it('valor de la orden bajo el mínimo (5 USDT)', async () => {
    const { risk } = await setup();
    const result = risk.checkOrder(order('buy', 0.00005, 84_000), { market });
    expect(result.code).toBe(RiskCode.MARKET_FILTER);
    expect(result.reason).toMatch(/mínimo del par \(5 USDT\)/);
  });

  it('precio límite con más decimales que el tick', async () => {
    const { risk } = await setup();
    const result = risk.checkOrder(order('buy', 0.00059, 84_000.005, 'limit'), { market });
    expect(result.code).toBe(RiskCode.MARKET_FILTER);
    expect(result.reason).toMatch(/máx\. 2 decimales/);
  });

  it('las ventas también deben cumplir los filtros', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    expect(risk.checkOrder(order('sell', 0.000585, 84_000), { market }).code).toBe(RiskCode.MARKET_FILTER);
  });
});

// ---------------------------------------------------------------------------------
describe('ventas en Spot: solo se vende lo que se tiene', () => {
  it('sin posición abierta → NO_POSITION', async () => {
    const { risk } = await setup();
    expect(risk.checkOrder(order('sell', 0.00059, 84_000), { market }).code).toBe(RiskCode.NO_POSITION);
  });

  it('más de lo que tiene la posición → EXCEEDS_POSITION', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    expect(risk.checkOrder(order('sell', 0.0006, 84_000), { market }).code).toBe(RiskCode.EXCEEDS_POSITION);
  });

  it('sizeSell redondea hacia abajo al paso (si la comisión se cobró en BTC)', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059 * 0.999, price: 84_000, feeQuote: 0.05 });
    expect(risk.sizeSell({ market }).amount).toBe(0.00058);
  });
});

describe('órdenes mal formadas', () => {
  it.each([
    [{ ...order('buy', 0.00059, 84_000), side: 'short' }],
    [{ ...order('buy', 0.00059, 84_000), type: 'stop' }],
    [order('buy', NaN, 84_000)],
    [order('buy', 0.00059, 0)],
    [{ ...order('buy', 0.00059, 84_000), symbol: 'ETH/USDT' }],
    [null],
  ])('%j → INVALID_ORDER', async (bad) => {
    const { risk } = await setup();
    expect(risk.checkOrder(bad, { market }).code).toBe(RiskCode.INVALID_ORDER);
  });
});

// ---------------------------------------------------------------------------------
describe('límite: pérdida máxima diaria (comisiones incluidas)', () => {
  it('las comisiones cuentan: −0.40 de precio + 0.90 de comisiones supera un límite de 1 USDT', async () => {
    const { risk } = await setup({ limits: { maxDailyLossUsdt: 1 } });
    // compra 0.01 BTC a 50 000 (comisión 0.50) y vende a 49 960 (comisión 0.4996)
    roundTrip(risk, { qty: 0.01, buy: 50_000, sell: 49_960, buyFee: 0.5, sellFee: 0.4996 });
    const daily = risk.dailyPnl();
    expect(daily.realized).toBeCloseTo(-1.3996, 6);
    expect(daily.realizedFees).toBeCloseTo(0.9996, 6);
    const result = await risk.enforceLimits({ cancelOpenOrders: noOrders });
    expect(result).toMatchObject({ halted: true, code: RiskCode.DAILY_LOSS });
  });

  it('sin comisiones esa misma operación NO habría alcanzado el límite', async () => {
    const { risk } = await setup({ limits: { maxDailyLossUsdt: 1 } });
    roundTrip(risk, { qty: 0.01, buy: 50_000, sell: 49_960 });
    expect((await risk.enforceLimits({ cancelOpenOrders: noOrders })).halted).toBe(false);
  });

  it('alcanzar exactamente el límite detiene el bot', async () => {
    const { risk } = await setup({ limits: { maxDailyLossUsdt: 20 } });
    roundTrip(risk, { qty: 1, buy: 100, sell: 80 }); // −20.00
    expect((await risk.enforceLimits({ cancelOpenOrders: noOrders })).halted).toBe(true);
  });

  it('se mide el neto del día: las ganancias compensan las pérdidas', async () => {
    const { risk } = await setup({ limits: { maxDailyLossUsdt: 20 } });
    roundTrip(risk, { qty: 1, buy: 100, sell: 110 }); // +10
    roundTrip(risk, { qty: 1, buy: 100, sell: 75 }); // −25
    const daily = risk.dailyPnl();
    expect(daily.total).toBeCloseTo(-15, 9);
    expect(daily.closedTrades).toBe(2);
    expect((await risk.enforceLimits({ cancelOpenOrders: noOrders })).halted).toBe(false);
  });

  it('las pérdidas no realizadas (posición abierta) también cuentan', async () => {
    const { risk } = await setup({ limits: { maxDailyLossUsdt: 20 } });
    risk.recordEntry({ symbol: SYMBOL, qty: 0.01, price: 50_000, feeQuote: 0.5 }); // costo 500.50
    // a 48 000: 480 − 0.1% = 479.52 → −20.98
    const result = await risk.enforceLimits({ markPrices: { [SYMBOL]: 48_000 }, cancelOpenOrders: noOrders });
    expect(result).toMatchObject({ halted: true, code: RiskCode.DAILY_LOSS });
    expect(result.reason).toMatch(/no realizada -20\.98 USDT/);
  });

  it('checkOrder rechaza nuevas órdenes si la pérdida del día ya alcanzó el límite', async () => {
    const { risk } = await setup({ limits: { maxDailyLossUsdt: 20 } });
    roundTrip(risk, { qty: 1, buy: 100, sell: 79 });
    expect(risk.checkOrder(order('buy', 0.00059, 84_000), { market }).code).toBe(RiskCode.DAILY_LOSS);
  });

  it('el día es UTC: una pérdida de las 23:59:59.999 UTC no cuenta al día siguiente', async () => {
    const clock = createClock('2026-09-28T23:59:59.999Z');
    const { risk } = await setup({ clock, limits: { maxDailyLossUsdt: 20 } });
    roundTrip(risk, { qty: 1, buy: 100, sell: 90 }); // −10 el día 28
    expect(risk.dailyPnl()).toMatchObject({ day: '2026-09-28', realized: -10 });
    clock.set('2026-09-29T00:00:00.000Z');
    expect(risk.dailyPnl()).toMatchObject({ day: '2026-09-29', realized: 0 });
    roundTrip(risk, { qty: 1, buy: 100, sell: 85 }); // −15 el día 29: no suma el −10 de ayer
    expect((await risk.enforceLimits({ cancelOpenOrders: noOrders })).halted).toBe(false);
  });

  it('sin precio de mercado, lo no realizado cuenta al menos las comisiones', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.01, price: 50_000, feeQuote: 0.5 });
    const daily = risk.dailyPnl();
    expect(daily.missingPrices).toEqual([SYMBOL]);
    expect(daily.unrealized).toBeCloseTo(-1, 9); // −0.50 de entrada −0.50 de salida estimada
  });
});

// ---------------------------------------------------------------------------------
describe('parada de emergencia', () => {
  it('guarda la parada ANTES de cancelar, cancela las órdenes pendientes y registra el motivo', async () => {
    const { risk, messages, lines } = await setup({ limits: { maxDailyLossUsdt: 20 } });
    roundTrip(risk, { qty: 1, buy: 100, sell: 70 });
    const cancelOpenOrders = vi.fn(async () => {
      expect(risk.haltState().halted).toBe(true); // ya estaba guardada
      return [{ id: 'a' }, { id: 'b' }];
    });

    const result = await risk.enforceLimits({ cancelOpenOrders });

    expect(cancelOpenOrders).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ halted: true, code: RiskCode.DAILY_LOSS, cancelled: [{ id: 'a' }, { id: 'b' }] });
    expect(risk.haltState()).toMatchObject({ halted: true, code: RiskCode.DAILY_LOSS });
    expect(risk.haltState().reason).toMatch(/pérdida del día 2026-09-28 UTC: -30\.00 USDT/);
    // el motivo queda en el log con nivel error
    const alert = lines.find((l) => l.msg.startsWith('PARADA DE EMERGENCIA'));
    expect(alert).toMatchObject({ level: 50, code: RiskCode.DAILY_LOSS });
    expect(messages()).toContain('Órdenes pendientes canceladas: 2');
    expect(messages().join()).toMatch(/npm run resume/);
  });

  it('después de la parada no se aceptan órdenes nuevas, ni compras ni ventas', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000 });
    await risk.emergencyStop({ code: RiskCode.KILL_SWITCH, reason: 'prueba', cancelOpenOrders: noOrders });
    expect(risk.checkOrder(order('buy', 0.00059, 84_000), { market }).code).toBe(RiskCode.HALTED);
    expect(risk.checkOrder(order('sell', 0.00059, 84_000), { market }).code).toBe(RiskCode.HALTED);
  });

  it('si cancelar falla, igual queda detenido y lo registra para revisión manual', async () => {
    const { risk, messages } = await setup();
    const result = await risk.emergencyStop({
      code: RiskCode.KILL_SWITCH,
      reason: 'prueba',
      cancelOpenOrders: async () => { throw new Error('exchange no responde'); },
    });
    expect(result.halted).toBe(true);
    expect(result.cancelError.message).toBe('exchange no responde');
    expect(risk.haltState().halted).toBe(true);
    expect(risk.store.recentEvents(1)[0]).toMatchObject({ type: 'CANCEL_FAILED', message: 'exchange no responde' });
    expect(messages().join()).toMatch(/revísalas manualmente/);
  });

  it('es idempotente: una segunda parada conserva el motivo original', async () => {
    const { risk } = await setup();
    await risk.emergencyStop({ code: RiskCode.DAILY_LOSS, reason: 'primero', cancelOpenOrders: noOrders });
    const second = await risk.emergencyStop({ code: RiskCode.KILL_SWITCH, reason: 'segundo', cancelOpenOrders: noOrders });
    expect(second).toMatchObject({ code: RiskCode.DAILY_LOSS, reason: 'primero' });
    expect(risk.haltState().reason).toBe('primero');
  });

  it('exige una función para cancelar órdenes', async () => {
    const { risk } = await setup();
    await expect(risk.emergencyStop({ code: 'X', reason: 'y' })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------
describe('kill switch', () => {
  it('con el archivo presente se rechaza toda orden nueva', async () => {
    const { risk } = await setup();
    risk.killSwitch.activate('revisión manual');
    const result = risk.checkOrder(order('buy', 0.00059, 84_000), { market });
    expect(result).toMatchObject({ ok: false, code: RiskCode.KILL_SWITCH });
    expect(result.reason).toMatch(/revisión manual/);
  });

  it('enforceLimits lo detecta: guarda la parada, cancela órdenes y registra el motivo', async () => {
    const { risk, lines } = await setup();
    risk.killSwitch.activate('noticia inesperada');
    const cancelOpenOrders = vi.fn(async () => [{ id: 'x' }]);
    const result = await risk.enforceLimits({ cancelOpenOrders });
    expect(result).toMatchObject({ halted: true, code: RiskCode.KILL_SWITCH });
    expect(cancelOpenOrders).toHaveBeenCalledTimes(1);
    expect(risk.haltState()).toMatchObject({ halted: true, reason: 'kill switch: noticia inesperada' });
    expect(lines.some((l) => l.level === 50 && l.msg.includes('noticia inesperada'))).toBe(true);
  });

  it('una parada guardada por otro proceso (npm run kill) también detiene al bot en ejecución', async () => {
    const { risk } = await setup();
    risk.store.setHalt({ code: RiskCode.KILL_SWITCH, reason: 'desde otra terminal', time: Date.now() });
    const cancelOpenOrders = vi.fn(noOrders);
    const result = await risk.enforceLimits({ cancelOpenOrders });
    expect(result).toMatchObject({ halted: true, reason: 'desde otra terminal' });
    expect(cancelOpenOrders).toHaveBeenCalled();
  });

  it('con el kill switch activo el bot no arranca', async () => {
    const { risk } = await setup();
    risk.killSwitch.activate('mantenimiento');
    expect(() => risk.assertCanStart()).toThrow(/kill switch activo.*mantenimiento.*npm run resume/);
  });
});

// ---------------------------------------------------------------------------------
describe('reanudación manual', () => {
  it('después del kill switch: borra la parada y el archivo, y lo registra', async () => {
    const { risk } = await setup();
    risk.killSwitch.activate('prueba');
    await risk.enforceLimits({ cancelOpenOrders: noOrders });

    const result = risk.resume({ by: 'test' });

    expect(result).toMatchObject({ resumed: true, previous: { halted: true, code: RiskCode.KILL_SWITCH } });
    expect(risk.killSwitch.isActive()).toBe(false);
    expect(risk.haltState().halted).toBe(false);
    expect(risk.store.recentEvents(1)[0]).toMatchObject({ type: 'RESUME', message: 'Reanudado manualmente (test)' });
    expect(() => risk.assertCanStart()).not.toThrow();
    expect(risk.checkOrder(order('buy', 0.00059, 84_000), { market }).ok).toBe(true);
  });

  it('después de la pérdida máxima: se niega el mismo día UTC y lo permite desde las 00:00 UTC', async () => {
    const clock = createClock('2026-09-28T15:00:00Z');
    const { risk } = await setup({ clock, limits: { maxDailyLossUsdt: 20 } });
    roundTrip(risk, { qty: 1, buy: 100, sell: 75 });
    await risk.enforceLimits({ cancelOpenOrders: noOrders });

    expect(() => risk.resume()).toThrow(/Podrás reanudar desde 2026-09-29T00:00:00\.000Z \(00:00 UTC\)/);
    expect(risk.haltState().halted).toBe(true);

    clock.set('2026-09-29T00:00:00.000Z');
    expect(risk.resume().resumed).toBe(true);
  });

  it('el día UTC no reanuda solo: sin `npm run resume` sigue detenido', async () => {
    const clock = createClock('2026-09-28T15:00:00Z');
    const { risk } = await setup({ clock });
    roundTrip(risk, { qty: 1, buy: 100, sell: 75 });
    await risk.enforceLimits({ cancelOpenOrders: noOrders });
    clock.set('2026-09-30T12:00:00Z');
    expect(() => risk.assertCanStart()).toThrow(/detenido/);
    expect(risk.checkOrder(order('buy', 0.00059, 84_000), { market }).code).toBe(RiskCode.HALTED);
  });

  it('si no estaba detenido, no hace nada', async () => {
    const { risk } = await setup();
    expect(risk.resume()).toMatchObject({ resumed: false });
  });
});

// ---------------------------------------------------------------------------------
describe('ventas parciales (la posición refleja lo realmente vendido)', () => {
  it('vender una parte deja la posición abierta con el resto y registra la parte vendida', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 1, price: 100, feeQuote: 1 }); // costo 101
    const closed = risk.recordExit({ symbol: SYMBOL, qty: 0.4, price: 110, feeQuote: 0.44 });
    expect(closed).toMatchObject({ status: 'closed', qty: 0.4 });
    expect(closed.entryCost).toBeCloseTo(40.4, 9); // 40% del costo
    expect(closed.realizedPnl).toBeCloseTo(0.4 * 110 - 0.44 - 40.4, 9);
    const [open] = risk.store.openPositions();
    expect(open.qty).toBeCloseTo(0.6, 12);
    expect(open.entryCost).toBeCloseTo(60.6, 9);
    expect(open.entryFee).toBeCloseTo(0.6, 9);
  });

  it('un resto menor que lo vendible (dust) cierra la posición completa', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.00058941, price: 84_000 });
    risk.recordExit({ symbol: SYMBOL, qty: 0.00058, price: 84_000, dustQty: 0.00001 });
    expect(risk.store.openPositions()).toHaveLength(0);
  });

  it('vender más de lo que tiene la posición es un error de registro', async () => {
    const { risk } = await setup();
    risk.recordEntry({ symbol: SYMBOL, qty: 0.001, price: 84_000 });
    expect(() => risk.recordExit({ symbol: SYMBOL, qty: 0.002, price: 84_000 })).toThrow(/solo tenía 0.001/);
  });
});

describe('reglas de idempotencia y reconciliación en checkOrder', () => {
  const withId = (side = 'buy') => ({ ...order(side, 0.00059, 84_000), clientOrderId: 'sbtp-1' });

  it('aprueba con una aprobación de un solo uso solo si la orden trae clientOrderId', async () => {
    const { risk } = await setup();
    expect(risk.checkOrder(withId(), { market }).approval).toMatchObject({ clientOrderId: 'sbtp-1', amount: 0.00059 });
    expect(risk.checkOrder(order('buy', 0.00059, 84_000), { market }).approval).toBeNull();
  });

  it('señal duplicada → DUPLICATE_SIGNAL', async () => {
    const { risk } = await setup();
    const result = risk.checkOrder(withId(), { market, duplicateOf: { clientOrderId: 'sbtp-0', status: 'filled' } });
    expect(result).toMatchObject({ ok: false, code: RiskCode.DUPLICATE_SIGNAL });
  });

  it('orden sin terminar en el par → ORDER_IN_FLIGHT', async () => {
    const { risk } = await setup();
    expect(risk.checkOrder(withId(), { market, activeOrders: 1 }).code).toBe(RiskCode.ORDER_IN_FLIGHT);
  });

  it('reconciliación pendiente → RECONCILIATION', async () => {
    const { risk } = await setup();
    risk.reconciliation = { status: () => ({ ok: false, reason: '2 diferencia(s) sin resolver' }) };
    const result = risk.checkOrder(withId(), { market });
    expect(result).toMatchObject({ ok: false, code: RiskCode.RECONCILIATION });
    expect(result.reason).toMatch(/2 diferencia/);
  });
});
