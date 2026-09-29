/**
 * Cómo se muestran el estado del bot y el riesgo del día (funciones puras).
 */
import { describe, expect, it } from 'vitest';
import { DANGER_AT_PCT, WARN_AT_PCT, lossBar, markSourceLabel, nextUtcMidnight, pnlTone, positionsUsage } from '../../../panel/web/src/lib/risk-view.js';
import { dataFreshness, formatParams, haltLabel, stateExplanation, statusBadges } from '../../../panel/web/src/lib/status-view.js';

const status = (extra = {}) => ({
  state: 'running',
  killSwitch: { active: false, file: null },
  halt: { halted: false, code: null, reason: null },
  data: { known: true, stale: false, reason: null },
  ...extra,
});

describe('estado del bot', () => {
  it('etiqueta del proceso; kill switch o parada se agregan (pueden coexistir con "Corriendo")', () => {
    expect(statusBadges(status())).toEqual([{ label: 'Corriendo', tone: 'ok' }]);
    expect(statusBadges(status({ killSwitch: { active: true, file: { reason: 'manual' } } }))).toEqual([
      { label: 'Corriendo', tone: 'ok' },
      { label: 'Kill switch activo', tone: 'danger', title: 'manual' },
    ]);
    expect(statusBadges(status({ state: 'stopped', halt: { halted: true, code: 'DAILY_LOSS', reason: 'pérdida del día −20.5' } }))).toEqual([
      { label: 'Detenido', tone: 'neutral' },
      { label: 'Parada: pérdida diaria alcanzada', tone: 'danger', title: 'pérdida del día −20.5' },
    ]);
    // El kill switch tiene prioridad sobre la parada que él mismo guardó
    const both = statusBadges(status({ killSwitch: { active: true, file: null }, halt: { halted: true, code: 'KILL_SWITCH', reason: 'kill switch: x' } }));
    expect(both.map((b) => b.label)).toEqual(['Corriendo', 'Kill switch activo']);
  });

  it('"sin responder" y "nunca corrió" se explican; "corriendo" no necesita explicación', () => {
    expect(stateExplanation(status({ state: 'unresponsive' }))).toMatch(/más de dos intervalos.*cerrarse de golpe/);
    expect(stateExplanation(status({ state: 'never' }))).toMatch(/nunca corrió.*npm start/);
    expect(stateExplanation(status({ state: 'stopping' }))).toMatch(/No vende posiciones/);
    expect(stateExplanation(status())).toBeNull();
  });

  it('frescura de los datos: al día, desactualizados (con motivo) o desconocida sin el bot', () => {
    expect(dataFreshness(status())).toEqual({ label: 'Al día', tone: 'ok', detail: null });
    expect(dataFreshness(status({ data: { known: true, stale: true, reason: 'sin mensajes hace 90 s' } })))
      .toEqual({ label: 'Desactualizados', tone: 'danger', detail: 'sin mensajes hace 90 s: el bot no envía órdenes.' });
    expect(dataFreshness(status({ data: { known: false } })).label).toBe('Sin información');
  });

  it('parámetros y motivos de parada legibles', () => {
    expect(formatParams({ fast: 9, slow: 21 })).toBe('fast 9 · slow 21');
    expect(formatParams({})).toBe('sin parámetros');
    expect(formatParams(null)).toBe('sin parámetros');
    expect(haltLabel('KILL_SWITCH')).toBe('kill switch');
    expect(haltLabel('OTRO_CODIGO')).toBe('OTRO_CODIGO');
  });
});

describe('riesgo del día', () => {
  const risk = (total, lossLimit = 20) => ({
    total, lossLimit, remaining: Math.max(0, total + lossLimit), usedPct: Math.min(100, Math.max(0, (-total / lossLimit) * 100)), reached: total <= -lossLimit,
  });

  it('barra de pérdida: verde, amarilla desde el 50 % y roja desde el 80 % o al alcanzar el límite', () => {
    expect(lossBar(risk(-1.8345))).toMatchObject({ tone: 'ok', loss: 1.8345, inProfit: false });
    expect(lossBar(risk(-9.99)).tone).toBe('ok'); // 49,95 %
    expect(lossBar(risk(-10)).tone).toBe('warn'); // 50 %
    expect(lossBar(risk(-16)).tone).toBe('danger'); // 80 %
    expect(lossBar(risk(-25))).toMatchObject({ tone: 'danger', usedPct: 100, remaining: 0 });
    expect([WARN_AT_PCT, DANGER_AT_PCT]).toEqual([50, 80]);
  });

  it('con ganancia en el día: sin pérdida usada y margen mayor que el límite', () => {
    expect(lossBar(risk(5))).toMatchObject({ tone: 'ok', loss: 0, usedPct: 0, remaining: 25, inProfit: true });
  });

  it('color del PnL, posiciones contra el máximo y origen del precio', () => {
    expect([pnlTone(1), pnlTone(-1), pnlTone(0)]).toEqual(['ok', 'danger', 'neutral']);
    expect(positionsUsage(1, 1)).toEqual({ open: 1, max: 1, full: true, tone: 'warn' });
    expect(positionsUsage(0, 2)).toEqual({ open: 0, max: 2, full: false, tone: 'ok' });
    expect(markSourceLabel({ source: 'bot' })).toMatch(/bot/);
    expect(markSourceLabel({ source: 'candles' })).toMatch(/última vela/);
    expect(markSourceLabel(null)).toMatch(/precio de entrada/);
  });

  it('el día de riesgo se reinicia a las 00:00 UTC, sin importar la zona horaria de la PC', () => {
    expect(nextUtcMidnight(Date.parse('2026-09-29T23:59:59.999Z'))).toBe(Date.parse('2026-09-30T00:00:00.000Z'));
    expect(nextUtcMidnight(Date.parse('2026-09-30T00:00:00.000Z'))).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
    expect(nextUtcMidnight(Date.parse('2026-12-31T12:00:00.000Z'))).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });
});
