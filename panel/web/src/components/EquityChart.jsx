/**
 * Curva de capital de un backtest contra "comprar y mantener", con una línea
 * en el capital inicial. Misma librería que el gráfico de velas (ver la
 * atribución en CandleChart.jsx: el enlace a TradingView se muestra en la sección).
 */
import { ColorType, CrosshairMode, LineSeries, LineStyle, LineType, createChart } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { equityLine } from '../lib/backtest-view.js';
import { tickLabel } from '../lib/chart-view.js';
import { dateTime, number } from '../lib/format.js';

/**
 * @param {object} props
 * @param {boolean} [props.steps] curva por operación: el capital solo cambia al cerrar cada una (escalones)
 */
export function EquityChart({ equity, buyHold, capital, colors, onHover, steps = false }) {
  const containerRef = useRef(null);
  const api = useRef(null);

  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { attributionLogo: false, fontFamily: getComputedStyle(document.body).fontFamily },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: (time, type) => tickLabel(time, type) },
      localization: { timeFormatter: (time) => dateTime(time * 1000, { seconds: false }), priceFormatter: (p) => number(p, { digits: 2 }) },
    });
    const strategy = chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: 'Estrategia' });
    const benchmark = chart.addSeries(LineSeries, { lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: 'Comprar y mantener' });
    api.current = { chart, strategy, benchmark, capitalLine: null };
    chart.subscribeCrosshairMove((param) => onHover?.(param.time ?? null));
    return () => {
      chart.remove();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const { chart, strategy, benchmark } = api.current;
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    });
    strategy.applyOptions({ color: colors.fast });
    benchmark.applyOptions({ color: colors.slow });
  }, [colors]);

  useEffect(() => {
    const current = api.current;
    current.strategy.applyOptions({ lineType: steps ? LineType.WithSteps : LineType.Simple });
    current.strategy.setData(equityLine(equity));
    current.benchmark.setData(equityLine(buyHold ?? []));
    if (current.capitalLine) current.strategy.removePriceLine(current.capitalLine);
    current.capitalLine = current.strategy.createPriceLine({
      price: capital, color: colors.text, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Capital inicial',
    });
    current.chart.timeScale().fitContent();
  }, [equity, buyHold, capital, colors.text, steps]);

  return <div ref={containerRef} className="chart chart-equity" role="img" aria-label="Curva de capital de la estrategia y de comprar y mantener" />;
}
