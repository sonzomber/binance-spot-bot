/**
 * Cómo se muestran las órdenes y los logs (funciones puras).
 */
import { describe, expect, it } from 'vitest';
import { LOG_LEVELS, MAX_LOG_LINES, levelTone, lineKey, matchesLog, mergeLines } from '../../../panel/web/src/lib/logs-view.js';
import { ORDER_STATUSES, displayPrice, displayQty, orderStatus, pageLabel, rejection, sideLabel } from '../../../panel/web/src/lib/orders-view.js';

const order = (extra = {}) => ({
  status: 'filled', side: 'buy', amount: 0.0006, filledQty: 0.0006, avgFillPrice: 84_000, price: 83_990,
  rejectSource: null, rejectCode: null, rejectReason: null, ...extra,
});

describe('órdenes', () => {
  it('cada estado del bot tiene texto y color (los 7 de order-store)', () => {
    expect(ORDER_STATUSES.map((s) => s.id).sort()).toEqual(['canceled', 'expired', 'filled', 'open', 'partially_filled', 'pending', 'rejected']);
    expect(orderStatus('rejected')).toMatchObject({ label: 'Rechazada', tone: 'danger' });
    expect(orderStatus('filled')).toMatchObject({ label: 'Ejecutada', tone: 'ok' });
    expect(orderStatus('otro')).toMatchObject({ label: 'otro', tone: 'neutral' });
    expect([sideLabel('buy'), sideLabel('sell')]).toEqual(['Compra', 'Venta']);
  });

  it('precio: el promedio ejecutado si hubo ejecución; si no, el esperado', () => {
    expect(displayPrice(order())).toEqual({ value: 84_000, kind: 'ejecutado' });
    expect(displayPrice(order({ status: 'rejected', filledQty: 0, avgFillPrice: null }))).toEqual({ value: 83_990, kind: 'esperado' });
    expect(displayPrice(order({ filledQty: 0, avgFillPrice: null, price: null }))).toEqual({ value: null, kind: null });
  });

  it('cantidad: la ejecutada; en una parcial, "X de Y"', () => {
    expect(displayQty(order())).toEqual({ value: 0.0006, of: null });
    expect(displayQty(order({ status: 'partially_filled', filledQty: 0.0002 }))).toEqual({ value: 0.0002, of: 0.0006 });
    expect(displayQty(order({ status: 'rejected', filledQty: 0 }))).toEqual({ value: 0.0006, of: null });
  });

  it('motivo de rechazo: quién rechazó (riesgo sin enviar, o el exchange) y por qué, en palabras', () => {
    expect(rejection(order())).toBeNull();
    expect(rejection(order({ status: 'rejected', rejectSource: 'risk', rejectCode: 'MAX_POSITIONS', rejectReason: 'hay 1 y el máximo es 1' })))
      .toEqual({ who: 'Riesgo (no se envió)', code: 'MAX_POSITIONS', text: 'máximo de posiciones abiertas', reason: 'hay 1 y el máximo es 1' });
    expect(rejection(order({ status: 'rejected', rejectSource: 'exchange', rejectCode: 'NOT_CREATED', rejectReason: 'timeout' })))
      .toMatchObject({ who: 'Exchange', text: 'no llegó al exchange' });
    // Códigos del exchange (clases de ccxt) se muestran tal cual
    expect(rejection(order({ status: 'rejected', rejectSource: 'exchange', rejectCode: 'InsufficientFunds', rejectReason: 'x' })).text).toBe('InsufficientFunds');
  });

  it('cada código de rechazo del módulo de riesgo tiene su texto', async () => {
    const { RiskCode } = await import('../../../src/risk/risk-manager.js');
    const { REJECT_LABELS } = await import('../../../panel/web/src/lib/orders-view.js');
    const missing = Object.values(RiskCode).filter((code) => code !== 'OK' && !REJECT_LABELS[code]);
    expect(missing).toEqual([]);
  });

  it('paginación', () => {
    expect(pageLabel(0, 25, 60)).toBe('1–25 de 60');
    expect(pageLabel(50, 10, 60)).toBe('51–60 de 60');
    expect(pageLabel(0, 0, 0)).toBe('0 de 0');
  });
});

describe('logs', () => {
  const line = (level, scope, msg = 'x', time = '2026-09-29T12:00:00.000Z') => ({ time, level, levelName: 'info', msg, scope, data: null });
  const filter = { scopeKey: 'testnet/dry-run', levels: ['info', 'warn', 'error'], includeGeneral: true };

  it('mismo filtro que el servidor: ámbito elegido + generales; nunca otro ámbito', () => {
    expect(matchesLog(line(30, 'testnet/dry-run'), filter)).toBe(true);
    expect(matchesLog(line(30, null), filter)).toBe(true);
    expect(matchesLog(line(30, null), { ...filter, includeGeneral: false })).toBe(false);
    expect(matchesLog(line(30, 'demo/exchange'), filter)).toBe(false);
    expect(matchesLog(line(30, 'testnet/exchange'), filter)).toBe(false);
  });

  it('por nivel: "error" incluye fatal; debug y trace nunca en la vista', () => {
    const onlyErrors = { ...filter, levels: ['error'] };
    expect(matchesLog(line(50, null), onlyErrors)).toBe(true);
    expect(matchesLog(line(60, null), onlyErrors)).toBe(true);
    expect(matchesLog(line(40, null), onlyErrors)).toBe(false);
    expect(matchesLog(line(20, null), filter)).toBe(false);
    expect(LOG_LEVELS.map((l) => l.id)).toEqual(['info', 'warn', 'error']);
    expect([levelTone(60), levelTone(50), levelTone(40), levelTone(30), levelTone(20)]).toEqual(['danger', 'danger', 'warn', 'info', 'neutral']);
  });

  it('mergeLines: la más nueva primero, sin duplicados (REST y SSE) y con un máximo', () => {
    const a = line(30, null, 'a', 't1');
    const b = line(30, null, 'b', 't2');
    const c = line(40, null, 'c', 't3');
    const shown = mergeLines([], [a, b]); // del servidor, de la más vieja a la más nueva
    expect(shown.map((l) => l.msg)).toEqual(['b', 'a']);
    expect(mergeLines(shown, [b, c]).map((l) => l.msg)).toEqual(['c', 'b', 'a']); // b ya estaba
    expect(mergeLines([], [a, a]).length).toBe(1);
    const many = Array.from({ length: MAX_LOG_LINES + 10 }, (_, i) => line(30, null, `m${i}`, `t${i}`));
    const capped = mergeLines([], many);
    expect(capped).toHaveLength(MAX_LOG_LINES);
    expect(capped[0].msg).toBe(`m${MAX_LOG_LINES + 9}`); // se conservan las más nuevas
  });

  it('el filtro del navegador da lo mismo que el del servidor en todas las combinaciones', async () => {
    const { createLogFilter } = await import('../../../panel/server/log-reader.js');
    const scopes = ['testnet/dry-run', 'testnet/exchange', 'demo/dry-run', 'demo/exchange', null];
    const levelSets = [['info'], ['warn'], ['error'], ['info', 'warn'], ['warn', 'error'], ['info', 'warn', 'error']];
    for (const levels of levelSets) {
      for (const includeGeneral of [true, false]) {
        const server = createLogFilter({ scope: { env: 'testnet', mode: 'dry-run' }, levels, includeGeneral });
        for (const level of [10, 20, 30, 40, 50, 60]) {
          for (const scope of scopes) {
            const l = line(level, scope);
            expect(matchesLog(l, { scopeKey: 'testnet/dry-run', levels, includeGeneral }), `${levels} ${includeGeneral} ${level} ${scope}`).toBe(server(l));
          }
        }
      }
    }
  });

  it('dos líneas iguales en todo menos los datos no se confunden', () => {
    expect(lineKey({ ...line(30, null), data: { n: 1 } })).not.toBe(lineKey({ ...line(30, null), data: { n: 2 } }));
  });
});
