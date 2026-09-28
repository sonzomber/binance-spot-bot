import { afterEach, describe, expect, it } from 'vitest';
import { entryCost, exitProceeds, nextUtcMidnight, unrealizedPnl, utcDay } from '../../src/risk/pnl.js';

describe('día UTC', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('el día cambia a las 00:00:00.000 UTC', () => {
    expect(utcDay(Date.parse('2026-09-28T23:59:59.999Z'))).toBe('2026-09-28');
    expect(utcDay(Date.parse('2026-09-29T00:00:00.000Z'))).toBe('2026-09-29');
  });

  it('no depende de la zona horaria de la PC', () => {
    // 22:00 en UTC−3 ya es el día siguiente en UTC
    const instant = Date.parse('2026-09-28T22:00:00-03:00');
    for (const tz of ['America/Santiago', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = tz;
      expect(utcDay(instant)).toBe('2026-09-29');
    }
  });

  it('nextUtcMidnight', () => {
    expect(new Date(nextUtcMidnight(Date.parse('2026-09-28T13:45:00Z'))).toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(new Date(nextUtcMidnight(Date.parse('2026-12-31T23:59:59Z'))).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('PnL con comisiones', () => {
  it('costo de entrada = cantidad × precio + comisión', () => {
    expect(entryCost({ qty: 0.01, price: 50_000, feeQuote: 0.5 })).toBe(500.5);
  });

  it('ingreso de salida = cantidad × precio − comisión', () => {
    expect(exitProceeds({ qty: 0.01, price: 50_000, feeQuote: 0.5 })).toBe(499.5);
  });

  it('una subida de 0.1% se convierte en pérdida al pagar 0.1% de comisión por lado', () => {
    const cost = entryCost({ qty: 0.01, price: 50_000, feeQuote: 0.5 }); // 500.50
    const proceeds = exitProceeds({ qty: 0.01, price: 50_050, feeQuote: 0.5005 }); // 499.9995
    expect(proceeds - cost).toBeCloseTo(-0.5005, 6);
  });

  it('comisión cobrada en la moneda base: el resultado es el mismo', () => {
    // Compra 0.01 BTC a 50 000 y paga 0.1% en BTC: recibe 0.00999 BTC, gastó 500 USDT.
    const qtyHeld = 0.01 * (1 - 0.001);
    const feeQuote = 0.01 * 0.001 * 50_000; // 0.5 USDT equivalentes
    expect(entryCost({ qty: qtyHeld, price: 50_000, feeQuote })).toBeCloseTo(500, 9);
  });

  it('no realizado descuenta la comisión estimada de venta', () => {
    const position = { qty: 0.01, entryCost: 500.5 };
    // vender ahora a 51 000: 510 − 0.1% = 509.49 → +8.99
    expect(unrealizedPnl(position, 51_000, 0.001)).toBeCloseTo(8.99, 9);
    // al mismo precio de entrada ya se pierde por comisiones (entrada + salida)
    expect(unrealizedPnl(position, 50_000, 0.001)).toBeCloseTo(-1, 9);
  });
});
