/**
 * Gráfico del ámbito elegido: velas CERRADAS guardadas por el bot (las mismas
 * que ve la estrategia), sus medias móviles y las compras/ventas ejecutadas.
 *
 * Las medias no se calculan aparte: son los indicadores que reportó la propia
 * estrategia en cada vela, con la misma ventana que usa el bot.
 */
import { useState } from 'react';
import { CandleChart } from '../components/CandleChart.jsx';
import { Card, Cmd, EmptyState, ErrorState, Loading } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { useThemeColors } from '../hooks/useThemeColors.js';
import { LIMIT_OPTIONS, legendFor, seriesLabel } from '../lib/chart-view.js';
import { dateTime, pct, price, qty } from '../lib/format.js';
import { ENV_LABELS, scopeLabel } from '../lib/labels.js';

export function ChartSection({ scope }) {
  const [limit, setLimit] = useState(300);
  const { data: chart, error, loading, reload } = useApi('/api/candles', { ...scope, limit });

  const limitSelect = (
    <label className="inline-select">
      <span>Velas</span>
      <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
        {LIMIT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );

  let body;
  if (error && !chart) body = <ErrorState error={error} onRetry={reload} />;
  else if (loading || !chart) body = <Loading />;
  else if (!chart.candles.length) {
    body = (
      <EmptyState title={`No hay velas guardadas de ${chart.symbol} ${chart.timeframe} en ${ENV_LABELS[scope.env]}`}>
        El bot guarda las velas cerradas mientras corre (y al arrancar descarga las necesarias). Arráncalo con <Cmd>npm start</Cmd>.
      </EmptyState>
    );
  } else body = <ChartBody chart={chart} />;

  return (
    <Card
      title="Gráfico"
      subtitle={chart ? `${chart.symbol} · ${chart.timeframe} · ${scopeLabel(scope)}` : scopeLabel(scope)}
      className="span-12"
      actions={limitSelect}
    >
      {body}
    </Card>
  );
}

function ChartBody({ chart }) {
  const colors = useThemeColors();
  const [hover, setHover] = useState(null);
  const legend = legendFor(chart, hover);
  const params = chart.strategy.params ?? {};
  const buys = chart.markers.filter((m) => m.side === 'buy').length;
  const sells = chart.markers.length - buys;
  const last = chart.candles.at(-1);

  return (
    <div className="stack">
      <div className="legend" aria-live="off">
        {legend ? (
          <>
            <span className="legend-time">{dateTime(legend.time, { seconds: false })}</span>
            <span>A <strong>{price(legend.open)}</strong></span>
            <span>Máx <strong>{price(legend.high)}</strong></span>
            <span>Mín <strong>{price(legend.low)}</strong></span>
            <span>C <strong>{price(legend.close)}</strong></span>
            <span className={legend.change >= 0 ? 'tone-ok' : 'tone-danger'}>{pct(legend.change, { sign: true })}</span>
            {legend.lines.map((line, i) => (
              <span key={line.key} className="legend-line">
                <span className="swatch" data-color={i === 0 ? 'fast' : 'slow'} aria-hidden="true" />
                {seriesLabel(line.key, params)} <strong>{price(line.value)}</strong>
              </span>
            ))}
          </>
        ) : null}
      </div>

      <CandleChart chart={chart} colors={colors} onHover={setHover} />

      <div className="chart-foot">
        <span className="legend-line"><span className="marker-up" aria-hidden="true">▲</span> Compra ({buys})</span>
        <span className="legend-line"><span className="marker-down" aria-hidden="true">▼</span> Venta ({sells})</span>
        {chart.series.map((s, i) => (
          <span key={s.key} className="legend-line">
            <span className="swatch" data-color={i === 0 ? 'fast' : 'slow'} aria-hidden="true" /> {seriesLabel(s.key, params)}
          </span>
        ))}
        {/* Atribución que pide la licencia de lightweight-charts (ver CandleChart.jsx). */}
        <a className="attribution" href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
          Gráfico: TradingView Lightweight Charts™
        </a>
      </div>

      <p className="fine-print">
        {chart.candles.length} velas cerradas de {ENV_LABELS[chart.scope.env]} (las mismas que ve la estrategia; la vela en curso no se muestra).
        {' '}Última: {dateTime(last.time, { seconds: false })}, cerró a las {dateTime(last.time + chart.stepMs, { seconds: false }).slice(11)}.
        {' '}Estrategia {chart.strategy.id}{chart.source === 'env' ? ' (del .env: el bot no ha corrido en este ámbito)' : ''}.
        {chart.strategy.error ? ` No se pudieron calcular los indicadores: ${chart.strategy.error}.` : ''}
        {chart.markers.length ? ` Última orden ejecutada: ${chart.markers.at(-1).side === 'buy' ? 'compra' : 'venta'} de ${qty(chart.markers.at(-1).qty)} a ${price(chart.markers.at(-1).price)}.` : ' Sin órdenes ejecutadas en este rango.'}
      </p>
    </div>
  );
}
