/**
 * Datos del gráfico para lightweight-charts (funciones puras): tiempos en
 * segundos, marcas de compra/venta ordenadas, nombres de los indicadores,
 * etiquetas del eje en hora local y la leyenda.
 */
import { describe, expect, it } from 'vitest';
import { chartCandles, chartMarkers, legendFor, lineData, seriesLabel, tickLabel, toSeconds } from '../../../panel/web/src/lib/chart-view.js';

const MIN = 60_000;
const T = Date.parse('2026-09-29T15:00:00.000Z');
const colors = { buy: 'verde', sell: 'rojo' };

describe('datos para la librería', () => {
  it('velas e indicadores con tiempos en SEGUNDOS', () => {
    expect(chartCandles([{ time: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }]))
      .toEqual([{ time: T / 1000, open: 1, high: 2, low: 0.5, close: 1.5 }]);
    expect(lineData([{ time: T + MIN, value: 110.5 }])).toEqual([{ time: T / 1000 + 60, value: 110.5 }]);
    expect(toSeconds(1_500)).toBe(1);
  });

  it('marcas: compra ▲ debajo de la vela, venta ▼ encima, ordenadas por tiempo', () => {
    const markers = chartMarkers([
      { clientOrderId: 'v', side: 'sell', candleTime: T + 2 * MIN, executedAt: '2026-09-29T15:02:10.000Z' },
      { clientOrderId: 'c2', side: 'buy', candleTime: T, executedAt: '2026-09-29T15:00:40.000Z' },
      { clientOrderId: 'c1', side: 'buy', candleTime: T, executedAt: '2026-09-29T15:00:05.000Z' },
    ], colors);
    expect(markers).toEqual([
      { id: 'c1', time: T / 1000, position: 'belowBar', shape: 'arrowUp', color: 'verde', text: 'Compra' },
      { id: 'c2', time: T / 1000, position: 'belowBar', shape: 'arrowUp', color: 'verde', text: 'Compra' },
      { id: 'v', time: T / 1000 + 120, position: 'aboveBar', shape: 'arrowDown', color: 'rojo', text: 'Venta' },
    ]);
  });

  it('no modifica la lista original de marcas', () => {
    const original = [{ clientOrderId: 'b', side: 'sell', candleTime: T + MIN, executedAt: 'b' }, { clientOrderId: 'a', side: 'buy', candleTime: T, executedAt: 'a' }];
    chartMarkers(original, colors);
    expect(original.map((m) => m.clientOrderId)).toEqual(['b', 'a']);
  });

  it('nombres de los indicadores con los parámetros de la estrategia', () => {
    expect(seriesLabel('smaFast', { fast: 9, slow: 21 })).toBe('SMA 9 (rápida)');
    expect(seriesLabel('smaSlow', { fast: 9, slow: 21 })).toBe('SMA 21 (lenta)');
    expect(seriesLabel('smaFast', {})).toBe('SMA (rápida)');
    expect(seriesLabel('rsi', {})).toBe('rsi'); // indicador de otra estrategia: su nombre tal cual
  });
});

describe('atribución de lightweight-charts (licencia) sin romper la CSP', () => {
  it('el logo de la librería está desactivado (inserta un <style> que la CSP bloquea) y hay un enlace propio a TradingView', async () => {
    const fs = await import('node:fs');
    const read = (file) => fs.readFileSync(new URL(`../../../panel/web/src/${file}`, import.meta.url), 'utf8');
    const chart = read('components/CandleChart.jsx');
    expect(chart).toMatch(/attributionLogo: false/);
    expect(chart).toMatch(/TradingView Lightweight Charts™\s+\*\s+Copyright \(с\) 2025 TradingView, Inc\. https:\/\/www\.tradingview\.com\//); // aviso del NOTICE
    expect(read('sections/ChartSection.jsx')).toMatch(/<a className="attribution" href="https:\/\/www\.tradingview\.com\/"/);
  });
});

describe('eje de tiempo en hora local', () => {
  it('etiqueta según la escala (año, mes, día, hora, hora con segundos)', () => {
    const local = new Date(2026, 8, 29, 7, 5, 9); // 29-09-2026 07:05:09 hora LOCAL
    const s = local.getTime() / 1000;
    expect(tickLabel(s, 0)).toBe('2026');
    expect(tickLabel(s, 1)).toBe('09-2026');
    expect(tickLabel(s, 2)).toBe('29-09');
    expect(tickLabel(s, 3)).toBe('07:05');
    expect(tickLabel(s, 4)).toBe('07:05:09');
  });
});

describe('leyenda', () => {
  const chart = {
    candles: [
      { time: T, open: 100, high: 102, low: 99, close: 101 },
      { time: T + MIN, open: 101, high: 101, low: 97, close: 98 },
    ],
    series: [
      { key: 'smaFast', points: [{ time: T, value: 100.5 }, { time: T + MIN, value: 99.5 }] },
      { key: 'smaSlow', points: [{ time: T + MIN, value: 100 }] },
    ],
  };

  it('sin cursor: la última vela; con cursor: la vela apuntada, con su variación e indicadores', () => {
    expect(legendFor(chart, null)).toMatchObject({ time: T + MIN, close: 98, lines: [{ key: 'smaFast', value: 99.5 }, { key: 'smaSlow', value: 100 }] });
    expect(legendFor(chart, null).change).toBeCloseTo(((98 - 101) / 101) * 100, 9);
    const first = legendFor(chart, T / 1000);
    expect(first).toMatchObject({ time: T, open: 100, close: 101, lines: [{ key: 'smaFast', value: 100.5 }, { key: 'smaSlow', value: null }] });
    expect(first.change).toBeCloseTo(1, 9); // (101 − 100) / 100 = +1 %
  });

  it('sin velas no hay leyenda', () => {
    expect(legendFor({ candles: [], series: [] }, null)).toBeNull();
    expect(legendFor(null, null)).toBeNull();
  });
});
