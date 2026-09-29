import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataHealth } from '../../src/data/data-health.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskCode, RiskManager } from '../../src/risk/risk-manager.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { BTC_USDT_MARKET as market, captureLogger, createClock, tempDir } from '../helpers.js';

const MIN = 60_000;
const candleAt = (iso) => ({ time: Date.parse(iso), open: 1, high: 1, low: 1, close: 1, volume: 1 });

let clock;
let health;
let lines;
beforeEach(async () => {
  clock = createClock('2026-09-28T12:00:30.000Z');
  const capture = await captureLogger();
  lines = capture.lines;
  health = new DataHealth({ timeframe: '1m', staleAfterMs: 60_000, now: clock.now, logger: capture.logger });
});

/** Estado "al día": latido reciente y la última vela cerrada (11:59) guardada. */
function makeFresh() {
  health.markCandle(candleAt('2026-09-28T11:59:00Z'));
  health.markHeartbeat();
}

describe('DataHealth: cuándo los datos están desactualizados', () => {
  it('al arrancar, sin datos → desactualizados', () => {
    expect(health.status()).toEqual({ stale: true, reason: 'todavía no llegan datos del exchange' });
  });

  it('con latido reciente y la última vela cerrada → al día', () => {
    makeFresh();
    expect(health.status()).toEqual({ stale: false, reason: null });
  });

  it('sin señales de vida por más de DATA_STALE_AFTER → desactualizados', () => {
    makeFresh();
    clock.advance(60_000);
    expect(health.isStale()).toBe(false); // justo en el límite todavía vale
    clock.advance(1);
    expect(health.status().reason).toMatch(/sin datos del exchange desde hace 60 s/);
  });

  it('llegan latidos (pings) pero falta la vela cerrada → desactualizados pasado el margen', () => {
    makeFresh(); // tiene la vela de 11:59
    const at = (iso) => { clock.set(iso); health.markHeartbeat(); return health.status(); };
    expect(at('2026-09-28T12:01:30.000Z').stale).toBe(false); // la de 12:00 cerró hace 30 s: dentro del margen
    expect(at('2026-09-28T12:02:00.000Z').stale).toBe(false); // justo 60 s
    expect(at('2026-09-28T12:02:00.500Z')).toEqual({
      stale: true,
      reason: 'falta la vela de 2026-09-28T12:00:00.000Z, cerrada hace 61 s', // se mide desde la PRIMERA que falta
    });
    health.markCandle(candleAt('2026-09-28T12:00:00Z')); // llega (p. ej. por el relleno REST)
    expect(health.isStale()).toBe(false); // la de 12:01 cerró hace 0.5 s
  });

  it('mientras se rellenan huecos → desactualizados, aunque todo lo demás esté bien', () => {
    makeFresh();
    health.setRecovering('rellenando velas perdidas durante la desconexión (42 s)');
    expect(health.status()).toEqual({ stale: true, reason: 'rellenando velas perdidas durante la desconexión (42 s)' });
    health.setRecovering(null);
    expect(health.isStale()).toBe(false);
  });

  it('avisa solo cuando cambia el estado (log + eventos)', () => {
    const onStale = vi.fn();
    const onFresh = vi.fn();
    health.on('stale', onStale);
    health.on('fresh', onFresh);
    health.check(); // arranque sin datos: aviso informativo
    makeFresh();
    health.check();
    health.check(); // sin cambio: sin aviso
    clock.advance(2 * MIN);
    health.check();
    health.check();
    clock.set('2026-09-28T12:02:40Z'); // vuelven los datos
    health.markCandle(candleAt('2026-09-28T12:01:00Z'));
    health.check();
    expect(onStale).toHaveBeenCalledTimes(2);
    expect(onFresh).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => /DESACTUALIZADOS/.test(l.msg))).toHaveLength(1);
    expect(lines.filter((l) => /al día nuevamente/.test(l.msg))).toHaveLength(2);
  });

  it('start() revisa periódicamente', () => {
    vi.useFakeTimers();
    const onStale = vi.fn();
    const h = new DataHealth({ timeframe: '1m', staleAfterMs: 5000, now: () => Date.now() });
    h.on('stale', onStale);
    h.markHeartbeat(Date.now());
    h.markCandle({ time: Math.floor(Date.now() / MIN) * MIN - MIN });
    h.start(1000);
    vi.advanceTimersByTime(4000);
    expect(onStale).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onStale).toHaveBeenCalledTimes(1);
    h.stop();
    vi.useRealTimers();
  });
});

describe('datos desactualizados → el gestor de riesgo bloquea órdenes nuevas', () => {
  let db;
  let tmp;
  beforeEach(async () => {
    db = openDatabase(':memory:');
    tmp = await tempDir();
  });
  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  const riskWith = (dataHealth) =>
    new RiskManager({
      store: new RiskStore(db, { env: 'testnet', mode: 'dry-run' }),
      killSwitch: new KillSwitch(path.join(tmp.dir, 'STOP')),
      limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 },
      feeRate: 0.001,
      slippageBps: 5,
      logger: { info() {}, warn() {}, error() {} },
      now: clock.now,
      dataHealth,
    });
  const buy = { symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.00059, price: 84_000 };
  const sell = { ...buy, side: 'sell' };

  it('compras y ventas bloqueadas mientras están desactualizados; se permiten al recuperarse', () => {
    const risk = riskWith(health);
    risk.recordEntry({ symbol: 'BTC/USDT', qty: 0.00059, price: 84_000 });

    const blocked = risk.checkOrder(sell, { market });
    expect(blocked).toMatchObject({ ok: false, code: RiskCode.STALE_DATA });
    expect(blocked.reason).toMatch(/datos de mercado desactualizados: todavía no llegan datos/);

    makeFresh();
    expect(risk.checkOrder(sell, { market }).ok).toBe(true);

    clock.advance(2 * MIN); // se corta el flujo de datos
    expect(risk.checkOrder(sell, { market }).code).toBe(RiskCode.STALE_DATA);
  });

  it('una compra también se bloquea', () => {
    expect(riskWith(health).checkOrder(buy, { market }).code).toBe(RiskCode.STALE_DATA);
  });

  it('sin monitor de datos (p. ej. en tests de riesgo), no bloquea', () => {
    expect(riskWith(undefined).checkOrder(buy, { market }).ok).toBe(true);
  });
});
