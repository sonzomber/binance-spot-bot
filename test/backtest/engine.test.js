/**
 * Backtest con 16 velas donde todo se puede calcular a mano.
 *
 * Par sintético TEST/USDT: paso 0.001, tick 0.01, mínimo 1 USDT.
 * Estrategia sma-cross con fast=2, slow=3 (calienta con 4 velas).
 * Capital 20 USDT, comisión 0.1%, slippage 0 (salvo donde se indica).
 *
 *  i  apertura cierre  SMA2    SMA3     dif     señal al cierre
 *  0    100     100
 *  1    100      99    99.5
 *  2     99      98    98.5    99       -0.5
 *  3     98      97    97.5    98       -0.5
 *  4     97     101    99      98.667   +0.333  GOLDEN_CROSS → compra en la apertura de 5
 *  5    102     104   102.5   100.667   +1.833
 *  6    104     106   105     103.667   +1.333
 *  7    106     103   104.5   104.333   +0.167
 *  8    103      99   101     102.667   -1.667  DEATH_CROSS  → venta en la apertura de 9
 *  9    105      98    98.5   100       -1.5
 * 10     98      97    97.5    98       -0.5
 * 11     97     101    99      98.667   +0.333  GOLDEN_CROSS → compra en la apertura de 12
 * 12    102     104   102.5   100.667   +1.833
 * 13    104     102   103     102.333   +0.667
 * 14    102      99   100.5   101.667   -1.167  DEATH_CROSS  → venta en la apertura de 15
 * 15     98      97    98      99.333   -1.333
 *
 * Las aperturas de 5, 9, 12 y 15 difieren del cierre anterior a propósito: así se
 * comprueba que la orden se ejecuta a la APERTURA SIGUIENTE y no al cierre de la señal.
 */
import { describe, expect, it } from 'vitest';
import { BacktestError, runBacktest } from '../../src/backtest/engine.js';
import { buyAndHold, maxDrawdown, tradeStats } from '../../src/backtest/metrics.js';
import SmaCrossStrategy from '../../src/strategy/strategies/sma-cross.js';

const H = 3_600_000;
const T0 = Date.parse('2026-03-02T00:00:00Z');
const OPENS = [100, 100, 99, 98, 97, 102, 104, 106, 103, 105, 98, 97, 102, 104, 102, 98];
const CLOSES = [100, 99, 98, 97, 101, 104, 106, 103, 99, 98, 97, 101, 104, 102, 99, 97];
const candles = (opens = OPENS, closes = CLOSES) =>
  closes.map((close, i) => ({
    time: T0 + i * H, open: opens[i], close, high: Math.max(opens[i], close), low: Math.min(opens[i], close), volume: 1,
  }));

const MARKET = Object.freeze({
  symbol: 'TEST/USDT', base: 'TEST', quote: 'USDT', precision: { amount: 0.001, price: 0.01 },
  limits: { amount: { min: 0.001, max: 1000 }, price: { min: 0.01, max: 1e6 }, cost: { min: 1, max: 1e7 }, market: { max: 1000 } },
});

const run = (overrides = {}) => runBacktest({
  candles: candles(),
  from: T0,
  to: T0 + 16 * H,
  strategy: new SmaCrossStrategy({ fast: 2, slow: 3 }),
  market: MARKET,
  timeframe: '1h',
  capital: 20,
  feeRate: 0.001,
  slippageBps: 0,
  limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 1000, maxOpenPositions: 1 },
  ...overrides,
});

describe('backtest calculado a mano', () => {
  it('operaciones: al precio de APERTURA de la vela siguiente, con el tamaño que permite el capital', async () => {
    const r = await run();
    expect(r.decisions.map((d) => [d.side, d.signalTime.slice(11, 13), d.executedAt.slice(11, 13), d.price, d.status])).toEqual([
      ['buy', '04', '05', 102, 'filled'],
      ['sell', '08', '09', 105, 'filled'],
      ['buy', '11', '12', 102, 'filled'],
      ['sell', '14', '15', 98, 'filled'],
    ]);
    // Operación 1: presupuesto = min(capital 20, tope 50) = 20.
    //   cantidad = 20 / (102 × 1.001) = 0.19588… → paso 0.001 → 0.195
    //   costo = 0.195 × 102 = 19.89 + comisión 0.01989 = 19.90989 → quedan 0.09011 USDT
    //   venta: 0.195 × 105 = 20.475 − comisión 0.020475 = 20.454525
    //   PnL = 20.454525 − 19.90989 = +0.544635            efectivo: 20.544635
    // Operación 2: presupuesto = 20.544635 → 20.544635 / 102.102 = 0.20122 → 0.201
    //   costo = 0.201 × 102 = 20.502 + 0.020502 = 20.522502 → quedan 0.022133
    //   venta: 0.201 × 98 = 19.698 − 0.019698 = 19.678302
    //   PnL = 19.678302 − 20.522502 = −0.8442              efectivo final: 19.700435
    const [t1, t2] = r.tradesList;
    expect(t1).toMatchObject({ n: 1, entryPrice: 102, exitPrice: 105, qty: 0.195 });
    expect(t1.pnl).toBeCloseTo(0.544635, 9);
    expect(t1.fees).toBeCloseTo(0.01989 + 0.020475, 9);
    expect(t2).toMatchObject({ n: 2, entryPrice: 102, exitPrice: 98, qty: 0.201 });
    expect(t2.pnl).toBeCloseTo(-0.8442, 9);
    expect(t2.pnlPct).toBeCloseTo((-0.8442 / 20.522502) * 100, 9);
  });

  it('reporte: PnL neto, % ganadoras, promedios, profit factor, comisiones', async () => {
    const r = await run();
    expect(r.finalEquity).toBeCloseTo(19.700435, 9);
    expect(r.netPnl).toBeCloseTo(-0.299565, 9); // 0.544635 − 0.8442
    expect(r.netPnlPct).toBeCloseTo(-1.497825, 6); // −0.299565 / 20
    expect(r).toMatchObject({ trades: 2, wins: 1, losses: 1, winRatePct: 50, halts: 0, openPositionAtEnd: null });
    expect(r.avgWin).toBeCloseTo(0.544635, 9);
    expect(r.avgLoss).toBeCloseTo(-0.8442, 9);
    expect(r.profitFactor).toBeCloseTo(0.544635 / 0.8442, 9); // 0.6451
    expect(r.totalFees).toBeCloseTo(0.01989 + 0.020475 + 0.020502 + 0.019698, 9); // 0.080565
  });

  it('máximo drawdown sobre el capital a cada cierre', async () => {
    const r = await run();
    // Capital al cierre: vela 6 = 0.09011 + 0.195 × 106 = 20.76011 (máximo)
    //                    vela 8 = 0.09011 + 0.195 × 99  = 19.39511 (mínimo posterior)
    // drawdown = 20.76011 − 19.39511 = 1.365 → 1.365 / 20.76011 = 6.5751%
    // (después: 20.926133 → 19.700435 = 1.2257, menor)
    expect(r.maxDrawdown).toBeCloseTo(1.365, 9);
    expect(r.maxDrawdownPct).toBeCloseTo((1.365 / 20.76011) * 100, 6);
    expect(r.equity.map((p) => Math.round(p.value * 1e6) / 1e6).slice(0, 10)).toEqual([
      20, 20, 20, 20, 20, 20, 20.37011, 20.76011, 20.17511, 19.39511,
    ]);
  });

  it('comparación con comprar y mantener en el mismo período', async () => {
    const r = await run();
    // Compra a la apertura de la vela 0 (100): 20 / 100.1 = 0.1998 → 0.199; costo 19.9199; sobran 0.0801
    // Venta al cierre de la vela 15 (97): 0.199 × 97 = 19.303 × 0.999 = 19.283697 → capital 19.363797
    expect(r.buyAndHold).toMatchObject({ possible: true, qty: 0.199, entryPrice: 100, exitPrice: 97 });
    expect(r.buyAndHold.pnl).toBeCloseTo(-0.636203, 9);
    expect(r.buyAndHold.pnlPct).toBeCloseTo(-3.181015, 6);
    expect(r.vsBuyAndHold).toBeCloseTo(-0.299565 - -0.636203, 9); // la estrategia perdió menos: +0.336638
  });

  it('el slippage se paga en cada ejecución: compra más cara, venta más barata', async () => {
    const r = await run({ slippageBps: 50 }); // 0.5%
    const [t1] = r.tradesList;
    expect(t1.entryPrice).toBeCloseTo(102 * 1.005, 9);
    expect(t1.exitPrice).toBeCloseTo(105 * 0.995, 9);
  });
});

describe('sin sesgo de futuro', () => {
  it('lo que pasa DESPUÉS de una señal no cambia la señal ni cuándo se ejecuta', async () => {
    const closes = [...CLOSES];
    closes[5] = 150; // vela 5 disparada: no puede afectar la decisión tomada al cierre de la 4
    const r = await run({ candles: candles(OPENS, closes) });
    expect(r.decisions[0]).toMatchObject({ side: 'buy', signalTime: new Date(T0 + 4 * H).toISOString(), price: 102 });
    expect(r.tradesList[0]).toMatchObject({ entryPrice: 102, qty: 0.195 });
  });

  it('una señal en la última vela no se ejecuta (no hay apertura siguiente)', async () => {
    const r = await run({ to: T0 + 15 * H }); // termina en la vela 14, que da DEATH_CROSS
    expect(r.unexecutedFinalSignal).toEqual({ time: new Date(T0 + 14 * H).toISOString(), action: 'SELL' });
    expect(r.openPositionAtEnd).toMatchObject({ qty: 0.201, markPrice: 99 });
  });

  it('las velas previas al período solo calientan los indicadores', async () => {
    // Período desde la vela 5: la señal de la vela 4 (fuera del período) no se opera.
    const r = await run({ from: T0 + 5 * H });
    expect(r.decisions[0]).toMatchObject({ side: 'sell', status: 'skipped' }); // sin posición
    expect(r.decisions.filter((d) => d.status === 'filled')).toHaveLength(2); // solo la 2ª operación
    expect(r.period.from).toBe(new Date(T0 + 5 * H).toISOString());
  });
});

describe('capital, filtros y límites de riesgo (los mismos módulos que en vivo)', () => {
  it('MAX_TRADE_USDT menor que el capital limita el tamaño', async () => {
    const r = await run({ limits: { maxTradeUsdt: 10, maxDailyLossUsdt: 1000, maxOpenPositions: 1 } });
    expect(r.tradesList[0].qty).toBe(0.097); // 10 / 102.102 = 0.0979 → 0.097
  });

  it('capital menor que el mínimo del par: no corre y explica por qué', async () => {
    await expect(run({ capital: 0.5 })).rejects.toThrow(BacktestError);
    await expect(run({ capital: 0.5 })).rejects.toThrow(/capital de 0.5 USDT no se puede comprar TEST\/USDT/);
  });

  it('pérdida diaria: el riesgo detiene la operación como en vivo y la reanuda a las 00:00 UTC', async () => {
    // Velas desde las 14:00: la vela 10 empieza a las 00:00 del día siguiente.
    const start = Date.parse('2026-03-02T14:00:00Z');
    const shifted = candles().map((c, i) => ({ ...c, time: start + i * H }));
    const r = await run({
      candles: shifted, from: start, to: start + 16 * H,
      limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 0.1, maxOpenPositions: 1 },
    });
    // Día 1, cierre de la vela 8 (99): la posición pierde 0.195 × 99 × 0.999 − 19.90989 = −0.62 < −0.1 → parada.
    // La venta de la apertura de la vela 9 se RECHAZA: detenido, no se envían órdenes (ni ventas).
    expect(r.decisions[1]).toMatchObject({ side: 'sell', status: 'rejected', code: 'HALTED' });
    // Día 2: se reanuda a las 00:00, pero la posición abierta sigue perdiendo y, con la regla
    // conservadora (lo no realizado cuenta desde la entrada, aunque sea de ayer), vuelve a
    // alcanzar el límite al cierre de la vela 10 → segunda parada.
    expect(r.halts).toBe(2);
    // La compra de la vela 12 ni siquiera se intenta: el capital está en la posición (cantidad 0).
    expect(r.decisions.slice(2).map((d) => [d.side, d.status, d.code])).toEqual([
      ['buy', 'skipped', null],
      ['sell', 'rejected', 'HALTED'],
    ]);
    // Consecuencia: la posición queda atrapada hasta el final del período.
    expect(r.openPositionAtEnd).toMatchObject({ qty: 0.195, entryPrice: 102 });
  });
});

describe('reproducible', () => {
  it('mismas velas y parámetros → exactamente el mismo resultado', async () => {
    const a = await run({ slippageBps: 5 });
    const b = await run({ slippageBps: 5 });
    expect(b).toEqual(a);
  });
});

describe('métricas (funciones puras)', () => {
  it('tradeStats', () => {
    expect(tradeStats([{ pnl: 3 }, { pnl: -1 }, { pnl: 1 }, { pnl: -2 }])).toMatchObject({
      trades: 4, wins: 2, losses: 2, winRatePct: 50, avgWin: 2, avgLoss: -1.5, profitFactor: 4 / 3,
    });
    expect(tradeStats([{ pnl: 1 }]).profitFactor).toBeNull(); // sin pérdidas: no definido
    expect(tradeStats([])).toMatchObject({ trades: 0, winRatePct: null, profitFactor: null });
  });

  it('maxDrawdown', () => {
    expect(maxDrawdown([100, 120, 90, 130, 117])).toMatchObject({ maxDrawdown: 30, maxDrawdownPct: 25, peak: 120, trough: 90 });
    expect(maxDrawdown([100, 101, 102])).toMatchObject({ maxDrawdown: 0 });
  });

  it('buyAndHold no es posible si el capital no alcanza el mínimo', () => {
    expect(buyAndHold({ firstOpen: 100, lastClose: 100, capital: 0.5, feeRate: 0.001, slippageBps: 0, market: MARKET }).possible).toBe(false);
  });
});
