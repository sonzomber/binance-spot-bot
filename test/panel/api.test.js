/**
 * API del panel: lo que muestra y cómo se comporta sin datos.
 * Los datos se crean con los stores reales del bot (ver support.js).
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelDatabase } from '../../panel/server/database.js';
import { backtestCommand } from '../../src/backtest/command.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { BotStatusStore } from '../../src/storage/bot-status-store.js';
import { migrate, openDatabase } from '../../src/storage/db.js';
import { MIGRATIONS } from '../../src/storage/migrations.js';
import { OrderStore } from '../../src/storage/order-store.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { createStrategy } from '../../src/strategy/registry.js';
import { MIN, OTHER_SCOPE, SCOPE, riskFor, seedCandles, seedFilledOrder, seedRunningBot, setupPanel } from './support.js';

const NOW = Date.parse('2026-09-29T12:00:30.000Z');
const q = (scope) => `env=${scope.env}&mode=${scope.mode}`;

let ctx;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

// ---------------------------------------------------------------------------------
describe('sin bot o sin datos: se informa claramente (no pantallas vacías ni errores)', () => {
  it('sin base de datos: meta lo explica, los datos responden 503 con el motivo; al aparecer la base, funciona', async () => {
    ctx = await setupPanel({ createDb: false, now: NOW });
    const meta = await ctx.get('/api/meta');
    expect(meta.status).toBe(200);
    expect(meta.json.database).toMatchObject({ state: 'missing', message: expect.stringMatching(/Todavía no existe la base de datos .*arranca el bot/) });
    expect(meta.json.defaultScope).toEqual(SCOPE); // del .env
    expect(meta.json.resumeHint).toMatch(/npm run resume/);

    const status = await ctx.get(`/api/status?${q(SCOPE)}`);
    expect(status.status).toBe(503);
    expect(status.json.database.state).toBe('missing');

    // El log tampoco existe todavía: lista vacía, no error
    expect((await ctx.get('/api/logs')).json).toMatchObject({ exists: false, lines: [] });

    // El bot arranca y crea la base: el panel la toma sin reiniciarse
    openDatabase(ctx.files.dbPath).close();
    expect((await ctx.get('/api/meta')).json.database.state).toBe('ok');
    expect((await ctx.get(`/api/status?${q(SCOPE)}`)).json.state).toBe('never');
  });

  it('base en versión anterior: lo explica y NO la migra (el panel nunca escribe)', async () => {
    ctx = await setupPanel({ createDb: false, now: NOW });
    const old = new Database(ctx.files.dbPath);
    migrate(old, MIGRATIONS.slice(0, 4));
    old.close();

    const meta = await ctx.get('/api/meta');
    expect(meta.json.database).toMatchObject({ state: 'outdated', version: 4, message: expect.stringMatching(/versión 4 .*necesita la 5.*copia de seguridad/) });
    expect((await ctx.get(`/api/orders?${q(SCOPE)}`)).status).toBe(503);
    await ctx.panel.close(); // suelta el archivo antes de revisarlo
    const check = new Database(ctx.files.dbPath, { readonly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(4);
    check.close();
  });

  it('un ámbito donde el bot nunca corrió: todo vacío pero válido', async () => {
    ctx = await setupPanel({ now: NOW });
    const status = (await ctx.get(`/api/status?${q(OTHER_SCOPE)}`)).json;
    expect(status).toMatchObject({ state: 'never', bot: null, data: { known: false }, killSwitch: { active: false }, halt: { halted: false } });
    const risk = (await ctx.get(`/api/risk?${q(OTHER_SCOPE)}`)).json;
    expect(risk).toMatchObject({ total: 0, realized: 0, unrealized: 0, positions: [], openPositions: 0, mark: null, limitsSource: 'env', remaining: 20, usedPct: 0 });
    expect((await ctx.get(`/api/candles?${q(OTHER_SCOPE)}`)).json).toMatchObject({ candles: [], series: [], markers: [], source: 'env' });
    expect((await ctx.get(`/api/orders?${q(OTHER_SCOPE)}`)).json).toMatchObject({ total: 0, orders: [] });
    expect((await ctx.get('/api/backtests')).json).toEqual({ groups: [] });
  });
});

// ---------------------------------------------------------------------------------
describe('estado del bot', () => {
  it('corriendo: estrategia, parámetros, datos al día, último heartbeat y última vela', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => seedRunningBot(c, SCOPE, { heartbeatAgoMs: 5000 }) });
    const status = (await ctx.get(`/api/status?${q(SCOPE)}`)).json;
    expect(status).toMatchObject({
      scope: SCOPE,
      state: 'running',
      bot: {
        pid: 1234, strategy: 'sma-cross', params: { fast: 2, slow: 4 }, symbol: 'BTC/USDT', timeframe: '1m',
        heartbeatAt: new Date(NOW - 5000).toISOString(), heartbeatAgeMs: 5000,
        lastCandle: new Date(NOW - 2 * MIN).toISOString(), price: 84_000,
      },
      data: { known: true, stale: false },
      killSwitch: { active: false },
    });
    // El ámbito por defecto es el del último estado guardado
    expect((await ctx.get('/api/meta')).json.defaultScope).toEqual(SCOPE);
  });

  it('reloj del bot (sincronizado con Binance) apenas adelantado al de la PC: edad 0, no negativa', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => seedRunningBot(c, SCOPE, { heartbeatAgoMs: -178 }) });
    expect((await ctx.get(`/api/status?${q(SCOPE)}`)).json).toMatchObject({ state: 'running', bot: { heartbeatAgeMs: 0 } });
  });

  it('sin heartbeat por más de 2 intervalos: "unresponsive" (p. ej. el proceso se cerró de golpe)', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => seedRunningBot(c, SCOPE, { heartbeatAgoMs: 3 * MIN }) });
    const status = (await ctx.get(`/api/status?${q(SCOPE)}`)).json;
    expect(status.state).toBe('unresponsive');
    expect(status.data.known).toBe(false); // la frescura solo la sabe el bot en marcha
  });

  it('detenido: con el motivo y el código de salida', async () => {
    ctx = await setupPanel({
      now: NOW,
      seed: (c) => seedRunningBot(c).stopped({ time: NOW - MIN, reason: 'Ctrl+C', exitCode: 0 }),
    });
    expect((await ctx.get(`/api/status?${q(SCOPE)}`)).json).toMatchObject({ state: 'stopped', bot: { stopReason: 'Ctrl+C', exitCode: 0 } });
  });

  it('kill switch: el archivo STOP y la parada guardada se muestran (con motivo)', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => seedRunningBot(c) });
    new KillSwitch(ctx.files.killSwitchFile).activate('mantenimiento', NOW);
    new RiskStore(ctx.writer, SCOPE).setHalt({ code: 'KILL_SWITCH', reason: 'kill switch: mantenimiento', time: NOW });
    const status = (await ctx.get(`/api/status?${q(SCOPE)}`)).json;
    expect(status.killSwitch).toEqual({ active: true, file: { reason: 'mantenimiento', createdAt: new Date(NOW).toISOString() } });
    expect(status.halt).toMatchObject({ halted: true, code: 'KILL_SWITCH' });
    expect((await ctx.get('/api/meta')).json.killSwitch).toMatchObject({ active: true, reason: 'mantenimiento' });
  });
});

// ---------------------------------------------------------------------------------
describe('riesgo del día (mismo cálculo que el bot)', () => {
  function seedDay(c) {
    seedRunningBot(c, SCOPE, { price: 83_500 });
    const risk = riskFor(c);
    // Operación cerrada hoy: compra 0.001 a 84 000 (comisión 0.084) y venta a 83 000 (comisión 0.083)
    risk.recordEntry({ symbol: 'BTC/USDT', qty: 0.001, price: 84_000, feeQuote: 0.084, time: NOW - 50 * MIN });
    risk.recordExit({ symbol: 'BTC/USDT', qty: 0.001, price: 83_000, feeQuote: 0.083, time: NOW - 40 * MIN });
    // Posición abierta: 0.001 a 84 000 (comisión 0.084)
    risk.recordEntry({ symbol: 'BTC/USDT', qty: 0.001, price: 84_000, feeQuote: 0.084, time: NOW - 30 * MIN });
  }

  it('PnL con comisiones, lo que falta para el límite y posiciones vs. máximo (calculado a mano)', async () => {
    ctx = await setupPanel({ now: NOW, seed: seedDay });
    const risk = (await ctx.get(`/api/risk?${q(SCOPE)}`)).json;
    // realizado    = (83 − 0.083) − (84 + 0.084)       = −1.167
    // no realizado = 0.001 × 83 500 × 0.999 − 84.084   = 83.4165 − 84.084 = −0.6675
    // total        = −1.8345 → faltan 20 − 1.8345 = 18.1655 USDT (9.1725% del límite usado)
    expect(risk.day).toBe('2026-09-29');
    expect(risk.realized).toBeCloseTo(-1.167, 9);
    expect(risk.realizedFees).toBeCloseTo(0.167, 9);
    expect(risk.closedTrades).toBe(1);
    expect(risk.unrealized).toBeCloseTo(-0.6675, 9);
    expect(risk.total).toBeCloseTo(-1.8345, 9);
    expect(risk.remaining).toBeCloseTo(18.1655, 9);
    expect(risk.usedPct).toBeCloseTo(9.1725, 9);
    expect(risk).toMatchObject({
      lossLimit: 20, reached: false, limitsSource: 'bot', openPositions: 1, maxOpenPositions: 1,
      mark: { price: 83_500, source: 'bot' },
    });
    expect(risk.positions[0]).toMatchObject({ qty: 0.001, entryPrice: 84_000, markPrice: 83_500 });
    expect(risk.positions[0].unrealized).toBeCloseTo(-0.6675, 9);
  });

  it('coincide exactamente con RiskManager.dailyPnl() del bot', async () => {
    ctx = await setupPanel({ now: NOW, seed: seedDay });
    const risk = (await ctx.get(`/api/risk?${q(SCOPE)}`)).json;
    const bot = riskFor(ctx).dailyPnl({ 'BTC/USDT': 83_500 });
    expect({ realized: risk.realized, unrealized: risk.unrealized, total: risk.total, day: risk.day })
      .toEqual({ realized: bot.realized, unrealized: bot.unrealized, total: bot.total, day: bot.day });
  });

  it('los límites son los del bot en marcha; sin estado del bot, los del .env', async () => {
    ctx = await setupPanel({ now: NOW, env: { MAX_DAILY_LOSS_USDT: '5' }, seed: (c) => seedRunningBot(c) });
    expect((await ctx.get(`/api/risk?${q(SCOPE)}`)).json).toMatchObject({ lossLimit: 20, limitsSource: 'bot' });
    expect((await ctx.get(`/api/risk?${q(OTHER_SCOPE)}`)).json).toMatchObject({ lossLimit: 5, limitsSource: 'env' });
  });

  it('pérdida en el límite: reached, 100% usado y 0 restante', async () => {
    ctx = await setupPanel({
      now: NOW,
      seed: (c) => {
        seedRunningBot(c);
        const risk = riskFor(c);
        risk.recordEntry({ symbol: 'BTC/USDT', qty: 1, price: 100, time: NOW - 10 * MIN });
        risk.recordExit({ symbol: 'BTC/USDT', qty: 1, price: 75, time: NOW - 5 * MIN }); // −25 > 20
      },
    });
    expect((await ctx.get(`/api/risk?${q(SCOPE)}`)).json).toMatchObject({ total: -25, reached: true, usedPct: 100, remaining: 0 });
  });

  it('precio para valorar: el más reciente entre el del bot y el cierre de la última vela', async () => {
    ctx = await setupPanel({
      now: NOW,
      seed: (c) => {
        seedRunningBot(c, SCOPE, { heartbeatAgoMs: 3 * MIN, price: 83_000 }); // precio viejo del bot
        seedCandles(c, 'testnet', [83_800, 83_900]); // la última cerró hace 30 s
      },
    });
    expect((await ctx.get(`/api/risk?${q(SCOPE)}`)).json.mark).toMatchObject({ price: 83_900, source: 'candles' });
  });
});

// ---------------------------------------------------------------------------------
describe('los datos de distintos entornos nunca se mezclan', () => {
  function seedTwoScopes(c) {
    seedFilledOrder(c, SCOPE, { id: 't-buy', side: 'buy', qty: 0.001, price: 84_000, fee: 0.084, time: NOW - 5 * MIN });
    seedFilledOrder(c, OTHER_SCOPE, { id: 'd-buy', side: 'buy', qty: 0.002, price: 84_100, fee: 0.168, time: NOW - 4 * MIN });
    new OrderStore(c.writer, OTHER_SCOPE, { now: () => NOW }).createRejected(
      { clientOrderId: 'd-rej', symbol: 'BTC/USDT', side: 'sell', type: 'market', amount: 0.002 },
      { code: 'NO_POSITION', reason: 'no hay posición para vender' },
    );
    riskFor(c, OTHER_SCOPE).recordEntry({ symbol: 'BTC/USDT', qty: 0.002, price: 84_100, time: NOW - 4 * MIN });
  }

  it('órdenes y posiciones de demo no aparecen en testnet (ni al revés)', async () => {
    ctx = await setupPanel({ now: NOW, seed: seedTwoScopes });
    const testnet = (await ctx.get(`/api/orders?${q(SCOPE)}`)).json;
    const demo = (await ctx.get(`/api/orders?${q(OTHER_SCOPE)}`)).json;
    expect(testnet.orders.map((o) => o.clientOrderId)).toEqual(['t-buy']);
    expect(demo.orders.map((o) => o.clientOrderId)).toEqual(['d-rej', 'd-buy']);
    expect(demo.byStatus).toMatchObject({ filled: 1, rejected: 1 });
    expect(testnet.byStatus).toMatchObject({ filled: 1, rejected: 0 });
    expect((await ctx.get(`/api/risk?${q(SCOPE)}`)).json.openPositions).toBe(0);
    expect((await ctx.get(`/api/risk?${q(OTHER_SCOPE)}`)).json.openPositions).toBe(1);
    const meta = (await ctx.get('/api/meta')).json;
    expect(meta.scopes.filter((s) => s.orders > 0).map((s) => [`${s.env}/${s.mode}`, s.orders])).toEqual([['testnet/dry-run', 1], ['demo/exchange', 2]].sort().reverse());
  });

  it('ámbitos inválidos → 400 (producción nunca tiene datos de trading)', async () => {
    ctx = await setupPanel({ now: NOW });
    for (const query of ['env=production-readonly&mode=dry-run', 'env=mainnet&mode=exchange', 'env=testnet&mode=real', 'env=testnet']) {
      const res = await ctx.get(`/api/orders?${query}`);
      expect(res.status, query).toBe(400);
    }
    expect((await ctx.get('/api/orders?env=testnet&env=demo&mode=dry-run')).status).toBe(400); // parámetro repetido
  });
});

// ---------------------------------------------------------------------------------
describe('tabla de órdenes con filtros', () => {
  function seedOrders(c) {
    seedFilledOrder(c, SCOPE, { id: 'sma-1-buy', side: 'buy', qty: 0.001, price: 84_000, fee: 0.084, time: NOW - 9 * MIN });
    seedFilledOrder(c, SCOPE, { id: 'sma-2-sell', side: 'sell', qty: 0.001, price: 84_500, fee: 0.0845, time: NOW - 7 * MIN });
    new OrderStore(c.writer, SCOPE, { now: () => NOW - 5 * MIN }).createRejected(
      { clientOrderId: 'sma-3_buy%', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.001, price: 84_600 },
      { code: 'STALE_DATA', reason: 'datos desactualizados' },
    );
  }

  it('columnas: estado, lado, precio, cantidad, comisión, clientOrderId y motivo de rechazo', async () => {
    ctx = await setupPanel({ now: NOW, seed: seedOrders });
    const { orders, total } = (await ctx.get(`/api/orders?${q(SCOPE)}`)).json;
    expect(total).toBe(3);
    expect(orders[0]).toMatchObject({
      clientOrderId: 'sma-3_buy%', status: 'rejected', side: 'buy', price: 84_600, amount: 0.001,
      rejectSource: 'risk', rejectCode: 'STALE_DATA', rejectReason: 'datos desactualizados', filledQty: 0, feeQuote: 0,
    });
    expect(orders[1]).toMatchObject({ clientOrderId: 'sma-2-sell', status: 'filled', side: 'sell', filledQty: 0.001, avgFillPrice: 84_500, feeQuote: 0.0845, fills: 1 });
  });

  it('filtros por estado, lado y clientOrderId (con % y _ tomados literalmente), y paginación', async () => {
    ctx = await setupPanel({ now: NOW, seed: seedOrders });
    const ids = async (query) => (await ctx.get(`/api/orders?${q(SCOPE)}&${query}`)).json.orders.map((o) => o.clientOrderId);
    expect(await ids('status=rejected')).toEqual(['sma-3_buy%']);
    expect(await ids('status=filled,rejected&side=buy')).toEqual(['sma-3_buy%', 'sma-1-buy']);
    expect(await ids('side=sell')).toEqual(['sma-2-sell']);
    expect(await ids('q=2-se')).toEqual(['sma-2-sell']);
    expect(await ids('q=%25')).toEqual(['sma-3_buy%']); // "%" literal, no comodín
    expect(await ids('q=_')).toEqual(['sma-3_buy%']); // "_" literal, no comodín
    expect(await ids('limit=1&offset=1')).toEqual(['sma-2-sell']);
    const page = (await ctx.get(`/api/orders?${q(SCOPE)}&status=filled&limit=1`)).json;
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 0 });
  });

  it('valores fuera de la lista blanca → 400', async () => {
    ctx = await setupPanel({ now: NOW, seed: seedOrders });
    const injection = `status=${encodeURIComponent("filled';DROP TABLE orders;--")}`;
    for (const query of ['status=borrada', injection, 'side=both', 'limit=0', 'limit=999', 'offset=-1', `q=${'x'.repeat(65)}`]) {
      expect((await ctx.get(`/api/orders?${q(SCOPE)}&${query}`)).status, query).toBe(400);
    }
    expect((await ctx.get(`/api/orders?${q(SCOPE)}`)).json.total).toBe(3); // nada se tocó
  });
});

// ---------------------------------------------------------------------------------
describe('gráfico: velas, indicadores de la estrategia y marcas de compra/venta', () => {
  const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];

  it('los indicadores son los que reporta la propia estrategia con la ventana del bot', async () => {
    const history = Array.from({ length: 20 }, (_, i) => 100 + i); // 100 … 119
    ctx = await setupPanel({ now: NOW, seed: (c) => { seedRunningBot(c); seedCandles(c, 'testnet', history); } });
    const chart = (await ctx.get(`/api/candles?${q(SCOPE)}&limit=10`)).json;
    expect(chart).toMatchObject({ symbol: 'BTC/USDT', timeframe: '1m', stepMs: MIN, source: 'bot', strategy: { id: 'sma-cross', params: { fast: 2, slow: 4 }, error: null } });
    expect(chart.candles.map((c) => c.close)).toEqual(history.slice(-10));
    const series = Object.fromEntries(chart.series.map((s) => [s.key, s.points]));
    // Última vela: SMA2 = (118 + 119) / 2 = 118.5; SMA4 = (116 + 117 + 118 + 119) / 4 = 117.5
    expect(series.smaFast.at(-1)).toEqual({ time: chart.candles.at(-1).time, value: 118.5 });
    expect(series.smaSlow.at(-1)).toEqual({ time: chart.candles.at(-1).time, value: 117.5 });
    // Las 10 velas visibles tienen valor: se leyeron velas extra hacia atrás para calentar …
    expect(series.smaSlow).toHaveLength(10);
    // … y cada valor es el que devuelve strategy.evaluate() con las últimas `lookback` velas
    const strategy = await createStrategy('sma-cross', { fast: 2, slow: 4 });
    const all = history.map((close, i) => ({ time: chart.candles.at(-1).time - (history.length - 1 - i) * MIN, open: close, high: close, low: close, close, volume: 1 }));
    const expected = [];
    for (let i = 10; i < 20; i++) expected.push(strategy.evaluate(all.slice(Math.max(0, i + 1 - strategy.lookback), i + 1)).indicators.smaSlow);
    expect(series.smaSlow.map((p) => p.value)).toEqual(expected);
  });

  it('con poca historia, las primeras velas no tienen indicador (la estrategia aún se calienta)', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => { seedRunningBot(c); seedCandles(c, 'testnet', closes); } });
    const chart = (await ctx.get(`/api/candles?${q(SCOPE)}&limit=10`)).json;
    // 12 velas en total: las visibles 3.ª y 4.ª tienen solo 3 y 4 velas detrás; sma-cross 2/4 necesita 5
    const slow = chart.series.find((s) => s.key === 'smaSlow').points;
    expect(slow).toHaveLength(8);
    expect(slow[0].time).toBe(chart.candles[2].time);
  });

  it('marcas: órdenes ejecutadas en la vela de su ejecución; las rechazadas y las fuera de rango no', async () => {
    ctx = await setupPanel({
      now: NOW,
      seed: (c) => {
        seedRunningBot(c);
        const candles = seedCandles(c, 'testnet', closes);
        seedFilledOrder(c, SCOPE, { id: 'dentro', side: 'buy', qty: 0.001, price: 108, fee: 0.1, time: candles.at(-3).time + 20_000 });
        seedFilledOrder(c, SCOPE, { id: 'fuera', side: 'sell', qty: 0.001, price: 90, fee: 0.1, time: candles[0].time - 60 * MIN });
        new OrderStore(c.writer, SCOPE, { now: () => candles.at(-2).time }).createRejected(
          { clientOrderId: 'rechazada', symbol: 'BTC/USDT', side: 'sell', type: 'market', amount: 0.001 },
          { code: 'NO_POSITION', reason: 'x' },
        );
        seedFilledOrder(c, OTHER_SCOPE, { id: 'otro-ambito', side: 'buy', qty: 0.001, price: 109, fee: 0.1, time: candles.at(-2).time + 1000 });
      },
    });
    const chart = (await ctx.get(`/api/candles?${q(SCOPE)}&limit=10`)).json;
    expect(chart.markers).toEqual([
      expect.objectContaining({ clientOrderId: 'dentro', side: 'buy', price: 108, qty: 0.001, candleTime: chart.candles.at(-3).time }),
    ]);
  });

  it('las velas de otro entorno no se usan (el caché es por entorno)', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => { seedRunningBot(c); seedCandles(c, 'demo', closes); } });
    expect((await ctx.get(`/api/candles?${q(SCOPE)}`)).json.candles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
describe('backtests guardados', () => {
  const H = 3_600_000;
  const T0 = Date.parse('2025-01-01T00:00:00Z');
  const priceAt = (t) => 84_000 + 3000 * Math.sin((t - T0) / (37 * H)) + 800 * Math.sin((t - T0) / (5 * H));
  const client = {
    fetchMarket: vi.fn(async () => ({
      symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', precision: { amount: 0.00001, price: 0.01 },
      limits: { amount: { min: 0.00001, max: 9000 }, price: { min: 0.01, max: 1e6 }, cost: { min: 5, max: 9e6 }, market: { max: 100 } },
    })),
    fetchCandles: vi.fn(async (_s, _tf, { from, to }) => {
      const out = [];
      for (let t = from; t < to; t += H) {
        const open = priceAt(t - H);
        const close = priceAt(t);
        out.push({ time: t, open, close, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, volume: 1 });
      }
      return out;
    }),
  };
  const from = T0 + 50 * H;
  const split = from + 40 * 24 * H;
  const to = from + 60 * 24 * H;

  async function withBacktest() {
    ctx = await setupPanel({ now: NOW });
    const result = await backtestCommand({
      symbol: 'BTC/USDT', timeframe: '1h', from, to, split, strategyId: 'sma-cross', params: { fast: 9, slow: 21 },
      capital: 20, feeRate: 0.001, slippageBps: 5, limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 },
    }, { db: ctx.writer, client, csvDir: ctx.tmp.dir, now: () => Date.parse('2025-06-01T00:00:00Z') });
    return result;
  }

  it('lista agrupada: ajuste + validación con parámetros, período y métricas principales', async () => {
    const result = await withBacktest();
    const { groups } = (await ctx.get('/api/backtests')).json;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ groupId: result.groupId, strategy: 'sma-cross', symbol: 'BTC/USDT', timeframe: '1h', dataEnv: 'production-readonly' });
    expect(groups[0].runs.map((r) => r.segment)).toEqual(['train', 'validation']);
    const [train] = result.segments;
    expect(groups[0].runs[0]).toMatchObject({
      params: { fast: 9, slow: 21 }, periodFrom: new Date(from).toISOString(), periodTo: new Date(split).toISOString(),
      capital: 20, hasEquity: true, netPnl: train.report.netPnl, trades: train.report.trades,
      buyAndHoldPnl: train.report.buyAndHold.pnl, vsBuyAndHold: train.report.vsBuyAndHold,
    });
  });

  it('detalle: métricas, operaciones, curva de capital y comprar y mantener (misma función del reporte)', async () => {
    const result = await withBacktest();
    const [train] = result.segments;
    const detail = (await ctx.get(`/api/backtests/${train.runId}`)).json;
    expect(detail).toMatchObject({ segment: 'train', params: { fast: 9, slow: 21 }, equitySource: 'candles', buyHoldNote: null });
    expect(detail.metrics).toMatchObject({ netPnl: train.report.netPnl, maxDrawdown: train.report.maxDrawdown, profitFactor: train.report.profitFactor });
    expect(detail.trades).toHaveLength(train.report.trades);
    expect(detail.group.map((g) => g.segment)).toEqual(['train', 'validation']);

    // Curva: capital inicial al inicio del período, luego un punto al CIERRE de cada vela
    expect(detail.equity).toHaveLength(40 * 24 + 1);
    expect(detail.equity[0]).toEqual({ time: from, value: 20 });
    expect(detail.equity[1].time).toBe(from + H);
    expect(detail.equity.at(-1).time).toBe(split);
    expect(detail.equity.map((p) => p.value)).toEqual(train.report.equity.map((p) => p.value));

    // Comprar y mantener: mismo inicio, y su último punto ES el del reporte
    expect(detail.buyHold).toHaveLength(detail.equity.length);
    expect(detail.buyHold[0]).toEqual({ time: from, value: 20 });
    expect(detail.buyHold.at(-1).value).toBe(train.report.buyAndHold.finalEquity);
  });

  it('guardado antes de la v5 (sin curva): curva por operación, marcada como tal', async () => {
    const result = await withBacktest();
    const [train] = result.segments;
    ctx.writer.prepare('DELETE FROM backtest_equity WHERE run_id = ?').run(train.runId);
    const detail = (await ctx.get(`/api/backtests/${train.runId}`)).json;
    expect(detail.equitySource).toBe('trades');
    expect(detail.equity).toHaveLength(train.report.trades + 1);
    const sum = train.report.tradesList.reduce((s, t) => s + t.pnl, 20);
    expect(detail.equity.at(-1).value).toBeCloseTo(sum, 9);
    expect((await ctx.get('/api/backtests')).json.groups[0].runs[0].hasEquity).toBe(false);
  });

  it('si las velas ya no están en el caché, no hay curva de comprar y mantener pero se explica', async () => {
    const result = await withBacktest();
    ctx.writer.prepare("DELETE FROM candles WHERE env = 'production-readonly'").run();
    const detail = (await ctx.get(`/api/backtests/${result.segments[0].runId}`)).json;
    expect(detail.buyHold).toBeNull();
    expect(detail.buyHoldNote).toMatch(/ya no están en el caché/);
    expect(detail.equity.length).toBeGreaterThan(0); // la curva de la estrategia sí
  });

  it('id inexistente → 404; id inválido → 400', async () => {
    ctx = await setupPanel({ now: NOW });
    expect((await ctx.get('/api/backtests/999')).status).toBe(404);
    expect((await ctx.get('/api/backtests/abc')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------
describe('la conexión del panel es de solo lectura', () => {
  it('SQLite rechaza cualquier escritura por la conexión del panel', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => seedRunningBot(c) });
    // Una conexión igual a la del panel (la del servidor es interna).
    const panelDb = new PanelDatabase(ctx.files.dbPath);
    try {
      expect(() => panelDb.read((db) => db.prepare("UPDATE bot_status SET state = 'stopped'").run())).toThrow(/readonly|read-only|query_only/i);
      expect(new BotStatusStore(ctx.writer, SCOPE).get().state).toBe('running');
    } finally {
      panelDb.close();
    }
  });

  it('leer mientras el bot escribe no lo bloquea (WAL)', async () => {
    ctx = await setupPanel({ now: NOW, seed: (c) => seedRunningBot(c) });
    const panelDb = new PanelDatabase(ctx.files.dbPath);
    try {
      panelDb.read(() => {
        // Dentro de una transacción de lectura del panel, el "bot" escribe sin esperar.
        const started = Date.now();
        new BotStatusStore(ctx.writer, SCOPE).heartbeat({ time: NOW, lastCandle: NOW - MIN, price: 1, priceTime: NOW });
        expect(Date.now() - started).toBeLessThan(500);
      });
    } finally {
      panelDb.close();
    }
    expect(fs.existsSync(ctx.files.dbPath)).toBe(true);
  });
});
