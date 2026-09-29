/**
 * Reinicios: cada "sesión" abre la base de datos desde el ARCHIVO, como lo hace
 * el bot al arrancar, y la cierra al terminar. Nada vive en memoria entre sesiones.
 */
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskCode, RiskError, RiskManager } from '../../src/risk/risk-manager.js';
import { openDatabase } from '../../src/storage/db.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { BTC_USDT_MARKET as market, createClock, tempDir } from '../helpers.js';

const SYMBOL = 'BTC/USDT';
const noOrders = async () => [];
const buyOrder = { symbol: SYMBOL, side: 'buy', type: 'market', amount: 0.00059, price: 84_000 };

let tmp;
let clock;
beforeEach(async () => {
  tmp = await tempDir();
  clock = createClock('2026-09-28T10:00:00Z');
});
afterEach(() => tmp.cleanup());

/** Simula un arranque del bot: abre el archivo, usa el RiskManager y lo cierra. */
async function session(fn, { maxDailyLossUsdt = 20 } = {}) {
  const db = openDatabase(path.join(tmp.dir, 'bot.db'));
  try {
    const risk = new RiskManager({
      store: new RiskStore(db, { env: 'testnet', mode: 'dry-run' }),
      killSwitch: new KillSwitch(path.join(tmp.dir, 'STOP')),
      limits: { maxTradeUsdt: 50, maxDailyLossUsdt, maxOpenPositions: 1 },
      feeRate: 0.001,
      slippageBps: 5,
      logger: pino({ level: 'silent' }),
      now: clock.now,
    });
    return await fn(risk);
  } finally {
    db.close();
  }
}

function loss(risk, amount) {
  risk.recordEntry({ symbol: SYMBOL, qty: 1, price: 100 });
  risk.recordExit({ symbol: SYMBOL, qty: 1, price: 100 - amount });
}

describe('reinicio con estado guardado', () => {
  it('la pérdida del día se conserva: reiniciar NO resetea el límite diario', async () => {
    await session((risk) => loss(risk, 12)); // −12 de 20

    clock.advance(60 * 60 * 1000); // una hora después, mismo día UTC
    await session(async (risk) => {
      expect(risk.dailyPnl().realized).toBe(-12);
      loss(risk, 9); // −21 en total
      const result = await risk.enforceLimits({ cancelOpenOrders: noOrders });
      expect(result).toMatchObject({ halted: true, code: RiskCode.DAILY_LOSS });
    });
  });

  it('la parada se conserva: después de reiniciar el bot no arranca ni acepta órdenes', async () => {
    await session(async (risk) => {
      loss(risk, 25);
      await risk.enforceLimits({ cancelOpenOrders: noOrders });
    });

    await session((risk) => {
      expect(() => risk.assertCanStart()).toThrow(RiskError);
      expect(() => risk.assertCanStart()).toThrow(/detenido desde 2026-09-28T10:00:00\.000Z \(DAILY_LOSS\)/);
      expect(risk.checkOrder(buyOrder, { market }).code).toBe(RiskCode.HALTED);
    });
  });

  it('las posiciones abiertas se conservan (y siguen contando para MAX_OPEN_POSITIONS)', async () => {
    await session((risk) => risk.recordEntry({ symbol: SYMBOL, qty: 0.00059, price: 84_000, feeQuote: 0.05 }));

    await session((risk) => {
      const [position] = risk.store.openPositions();
      expect(position).toMatchObject({ symbol: SYMBOL, qty: 0.00059, entryFee: 0.05 });
      expect(risk.checkOrder(buyOrder, { market }).code).toBe(RiskCode.MAX_POSITIONS);
    });
  });

  it('un nuevo día UTC reinicia la pérdida del día, pero NO levanta la parada: requiere resume', async () => {
    await session(async (risk) => {
      loss(risk, 25);
      await risk.enforceLimits({ cancelOpenOrders: noOrders });
    });

    clock.set('2026-09-29T00:00:01Z');
    await session((risk) => {
      expect(risk.dailyPnl()).toMatchObject({ day: '2026-09-29', realized: 0 });
      expect(() => risk.assertCanStart()).toThrow(/detenido/);
      risk.resume({ by: 'test' });
    });

    await session((risk) => {
      expect(() => risk.assertCanStart()).not.toThrow();
      expect(risk.checkOrder(buyOrder, { market }).ok).toBe(true);
    });
  });

  it('el kill switch persiste entre reinicios hasta que se reanuda', async () => {
    await session((risk) => risk.killSwitch.activate('prueba de reinicio'));

    await session((risk) => {
      expect(() => risk.assertCanStart()).toThrow(/kill switch activo.*prueba de reinicio/);
      risk.resume();
    });

    await session((risk) => expect(() => risk.assertCanStart()).not.toThrow());
  });

  it('la bitácora registra la historia de paradas y reanudaciones', async () => {
    await session(async (risk) => {
      risk.killSwitch.activate('a');
      await risk.enforceLimits({ cancelOpenOrders: noOrders });
    });
    await session((risk) => risk.resume());
    await session((risk) => {
      const types = risk.store.recentEvents(10).map((e) => e.type).reverse();
      expect(types).toEqual(['HALT', 'RESUME']);
    });
  });
});
