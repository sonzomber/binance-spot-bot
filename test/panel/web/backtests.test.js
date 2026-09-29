/**
 * Cómo se muestran los backtests guardados (funciones puras).
 */
import { describe, expect, it } from 'vitest';
import {
  compareRows, defaultRunId, equityLine, gridRows, periodLabel, profitFactor, rejectionRows, runIdFromHash, segmentLabel, valueAt,
} from '../../../panel/web/src/lib/backtest-view.js';

const H = 3_600_000;
const T = Date.parse('2025-05-01T00:00:00.000Z');

describe('textos', () => {
  it('segmentos y período (días UTC; el fin es exclusivo)', () => {
    expect([segmentLabel('full'), segmentLabel('train'), segmentLabel('validation')]).toEqual(['Período completo', 'Ajuste', 'Validación']);
    expect(periodLabel('2025-01-01T00:00:00.000Z', '2025-05-01T00:00:00.000Z')).toBe('2025-01-01 → 2025-05-01');
  });

  it('profit factor: sin operaciones "—"; sin pérdidas "∞"; verde desde 1', () => {
    expect(profitFactor(null, 0)).toEqual({ text: '—', tone: 'neutral' });
    expect(profitFactor(null, 3)).toEqual({ text: '∞ (sin pérdidas)', tone: 'ok' });
    expect(profitFactor(0.8767, 78)).toEqual({ text: '0.88', tone: 'danger' });
    expect(profitFactor(1, 10)).toEqual({ text: '1.00', tone: 'ok' });
  });

  it('rechazos del riesgo, de más a menos frecuentes', () => {
    expect(rejectionRows({ STALE_DATA: 1, MAX_POSITIONS: 5 })).toEqual([{ code: 'MAX_POSITIONS', count: 5 }, { code: 'STALE_DATA', count: 1 }]);
    expect(rejectionRows(undefined)).toEqual([]);
  });
});

describe('curva de capital', () => {
  it('tiempos en segundos y estrictamente crecientes (un punto repetido se reemplaza)', () => {
    expect(equityLine([{ time: T, value: 20 }, { time: T + H, value: 19.8 }, { time: T + H, value: 19.7 }, { time: T + 2 * H, value: 19.9 }])).toEqual([
      { time: T / 1000, value: 20 },
      { time: (T + H) / 1000, value: 19.7 },
      { time: (T + 2 * H) / 1000, value: 19.9 },
    ]);
    expect(equityLine([{ time: T + H, value: 1 }, { time: T, value: 2 }])).toEqual([{ time: (T + H) / 1000, value: 1 }]); // fuera de orden: se descarta
    expect(equityLine(null)).toEqual([]);
  });

  it('valor en un instante: el último punto en o antes (curva escalonada)', () => {
    const points = [{ time: T, value: 20 }, { time: T + 2 * H, value: 21 }];
    expect(valueAt(points, T / 1000 - 1)).toBeNull();
    expect(valueAt(points, T / 1000)).toBe(20);
    expect(valueAt(points, (T + H) / 1000)).toBe(20);
    expect(valueAt(points, (T + 2 * H) / 1000)).toBe(21);
    expect(valueAt(points, (T + 9 * H) / 1000)).toBe(21);
  });
});

describe('gráfico de la curva de capital', () => {
  it('igual que el de velas: sin el logo que rompe la CSP (enlace propio), y la rueda desplaza la página', async () => {
    const fs = await import('node:fs');
    const read = (file) => fs.readFileSync(new URL(`../../../panel/web/src/${file}`, import.meta.url), 'utf8');
    const chart = read('components/EquityChart.jsx');
    expect(chart).toMatch(/attributionLogo: false/);
    expect(chart).toMatch(/handleScroll: \{ mouseWheel: false/);
    expect(chart).toMatch(/handleScale: \{ mouseWheel: false/);
    expect(read('sections/BacktestDetail.jsx')).toMatch(/<a className="attribution" href="https:\/\/www\.tradingview\.com\/"/);
  });
});

describe('selección y comparación', () => {
  const groups = [
    { groupId: 'nuevo', runs: [{ id: 3, segment: 'train' }, { id: 4, segment: 'validation' }] },
    { groupId: 'viejo', runs: [{ id: 1, segment: 'full' }] },
  ];

  it('la corrida elegida sale de la URL (#/backtests/ID)', () => {
    expect(runIdFromHash('#/backtests/12')).toBe(12);
    expect(runIdFromHash('#/backtests')).toBeNull();
    expect(runIdFromHash('#/backtests/abc')).toBeNull();
    expect(runIdFromHash('#/bot')).toBeNull();
    expect(runIdFromHash('#/bot/12')).toBeNull(); // números en otra pestaña no eligen corrida
    expect(runIdFromHash('#/backtests/12x')).toBeNull();
    expect(runIdFromHash(undefined)).toBeNull();
  });

  it('por defecto: la validación del grupo más reciente; si no hay, su última corrida', () => {
    expect(defaultRunId(groups)).toBe(4);
    expect(defaultRunId([groups[1]])).toBe(1);
    expect(defaultRunId([])).toBeNull();
  });

  it('comparación ajuste vs. validación solo con dos o más corridas en el grupo', () => {
    const runs = [
      { id: 1, segment: 'train', netPnlPct: -6.79, trades: 78, winRatePct: 34.6, profitFactor: 0.88, maxDrawdownPct: 24.9, buyAndHoldPnl: 0.07, vsBuyAndHold: -1.42 },
      { id: 2, segment: 'validation', netPnlPct: -5.39, trades: 39, winRatePct: 28.2, profitFactor: 0.76, maxDrawdownPct: 16.1, buyAndHoldPnl: 2.66, vsBuyAndHold: -3.74 },
    ];
    expect(compareRows(runs).map((r) => [r.segment, r.netPnlPct, r.vsBuyAndHold])).toEqual([['Ajuste', -6.79, -1.42], ['Validación', -5.39, -3.74]]);
    expect(compareRows([runs[0]])).toBeNull();
    expect(compareRows(undefined)).toBeNull();
  });

  it('grid: la primera combinación (la de mayor PnL en el ajuste) es la elegida', () => {
    const rows = gridRows([{ params: { fast: 12, slow: 21 }, netPnl: -1.36 }, { params: { fast: 9, slow: 21 }, netPnl: -1.79 }]);
    expect(rows.map((r) => r.chosen)).toEqual([true, false]);
    expect(gridRows(null)).toEqual([]);
  });
});
