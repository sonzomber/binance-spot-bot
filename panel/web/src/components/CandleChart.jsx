/**
 * Gráfico de velas con los indicadores de la estrategia y las marcas de
 * compra/venta.
 *
 * Usa lightweight-charts (Apache 2.0). Aviso de atribución (archivo NOTICE):
 *   TradingView Lightweight Charts™
 *   Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
 * El logo de atribución de la librería está desactivado porque inserta una
 * etiqueta <style> que la CSP del panel bloquea; en su lugar, la sección del
 * gráfico muestra un enlace a https://www.tradingview.com/ (lo que pide la licencia).
 *
 * El gráfico se crea una sola vez; los datos y los colores se actualizan sin
 * recrearlo (así no se pierde el zoom del usuario cuando llega una vela nueva).
 */
import { CandlestickSeries, ColorType, CrosshairMode, LineSeries, createChart, createSeriesMarkers } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { chartCandles, chartMarkers, lineData, tickLabel } from '../lib/chart-view.js';
import { dateTime, price } from '../lib/format.js';

const LINE_COLORS = ['fast', 'slow']; // colores de los indicadores, en orden

export function CandleChart({ chart, colors, onHover }) {
  const containerRef = useRef(null);
  const api = useRef(null); // { chart, candles, lines: Map, markers }
  const fittedFor = useRef(null);

  // Crear (una vez) y destruir.
  useEffect(() => {
    const instance = createChart(containerRef.current, {
      autoSize: true,
      layout: { attributionLogo: false, fontFamily: getComputedStyle(document.body).fontFamily }, // enlace propio: ver arriba
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: (time, type) => tickLabel(time, type) },
      localization: { timeFormatter: (time) => dateTime(time * 1000, { seconds: false }), priceFormatter: (p) => price(p) },
    });
    const candles = instance.addSeries(CandlestickSeries, { borderVisible: false, priceLineVisible: true });
    const markers = createSeriesMarkers(candles, []);
    api.current = { chart: instance, candles, markers, lines: new Map() };
    instance.subscribeCrosshairMove((param) => onHover?.(param.time ?? null));
    return () => {
      instance.remove();
      api.current = null;
    };
    // onHover es estable (useState del padre)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Colores del tema.
  useEffect(() => {
    const { chart: instance, candles, lines } = api.current;
    instance.applyOptions({
      layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    });
    candles.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
    [...lines.values()].forEach((line, i) => line.applyOptions({ color: colors[LINE_COLORS[i]] ?? colors.text }));
  }, [colors]);

  // Datos: velas, indicadores y marcas.
  useEffect(() => {
    const { chart: instance, candles, markers, lines } = api.current;
    candles.setData(chartCandles(chart.candles));
    const keys = chart.series.map((s) => s.key);
    for (const [key, line] of lines) {
      if (!keys.includes(key)) {
        instance.removeSeries(line);
        lines.delete(key);
      }
    }
    chart.series.forEach((s, i) => {
      if (!lines.has(s.key)) {
        lines.set(s.key, instance.addSeries(LineSeries, {
          color: colors[LINE_COLORS[i]] ?? colors.text, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }));
      }
      lines.get(s.key).setData(lineData(s.points));
    });
    markers.setMarkers(chartMarkers(chart.markers, colors));
    // Ajustar la vista solo la primera vez (o al cambiar de par/intervalo/cantidad): respeta el zoom del usuario.
    const view = `${chart.scope.env}|${chart.symbol}|${chart.timeframe}|${chart.candles.length > 0}`;
    if (fittedFor.current !== view) {
      instance.timeScale().fitContent();
      fittedFor.current = view;
    }
  }, [chart, colors]);

  return <div ref={containerRef} className="chart" aria-label={`Gráfico de velas de ${chart.symbol} ${chart.timeframe}`} role="img" />;
}
