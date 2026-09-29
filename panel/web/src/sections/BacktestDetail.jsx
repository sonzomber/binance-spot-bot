/**
 * Detalle de un backtest guardado: métricas, parámetros y período, curva de
 * capital contra "comprar y mantener", comparación ajuste/validación, grid
 * probado, operaciones y explicación de cada métrica.
 */
import { useState } from 'react';
import { EquityChart } from '../components/EquityChart.jsx';
import { Card, ErrorState, Loading, Stat } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { useThemeColors } from '../hooks/useThemeColors.js';
import { compareRows, gridRows, periodLabel, profitFactor, rejectionRows, segmentLabel, valueAt } from '../lib/backtest-view.js';
import { dateTime, number, pct, price, qty, usdt } from '../lib/format.js';
import { REJECT_LABELS } from '../lib/orders-view.js';
import { pnlTone } from '../lib/risk-view.js';
import { formatParams } from '../lib/status-view.js';

export function BacktestDetail({ runId, group }) {
  const { data: run, error, loading, reload } = useApi(runId ? `/api/backtests/${runId}` : null);

  let body;
  if (error && !run) body = <ErrorState error={error} onRetry={reload} />;
  else if (loading || !run) body = <Loading />;
  else body = <DetailBody run={run} group={group} />;

  return (
    <Card
      title={run ? `${segmentLabel(run.segment)} · ${formatParams(run.params)}` : 'Backtest'}
      subtitle={run ? `${run.strategy} · ${run.symbol} ${run.timeframe} · ${periodLabel(run.periodFrom, run.periodTo)} (UTC) · #${run.id}` : null}
      className="span-8"
    >
      {body}
    </Card>
  );
}

function DetailBody({ run, group }) {
  const m = run.metrics;
  const pf = profitFactor(m.profitFactor, m.trades);
  const bh = m.buyAndHold;
  const colors = useThemeColors();
  const [hover, setHover] = useState(null);
  const at = hover ?? (run.equity.length ? Math.floor(run.equity.at(-1).time / 1000) : null);
  const comparison = compareRows(group?.runs);
  const grid = gridRows(run.settings.grid);
  const rejections = rejectionRows(m.rejections);

  return (
    <div className="stack-lg">
      <p className="fine-print">
        Capital inicial {usdt(run.capital)} · comisión {pct(run.feeRate * 100, { digits: 2 })} por operación · slippage {number(run.slippageBps, { digits: 0 })} bps ·
        {' '}{m.period.candles} velas · guardado el {dateTime(run.createdAt, { seconds: false })}.
        {run.settings.limits ? ` Límites de riesgo: ${usdt(run.settings.limits.maxTradeUsdt)} por operación, pérdida diaria ${usdt(run.settings.limits.maxDailyLossUsdt)}, ${run.settings.limits.maxOpenPositions} posición(es).` : ''}
      </p>

      <div className="stats stats-wide">
        <Stat label="Resultado neto" value={usdt(m.netPnl, { sign: true, digits: 4 })} tone={pnlTone(m.netPnl)} hint={`${pct(m.netPnlPct, { sign: true })} · capital final ${usdt(m.finalEquity, { digits: 4 })}`} />
        <Stat label="Comprar y mantener" value={bh?.possible ? usdt(bh.pnl, { sign: true, digits: 4 }) : '—'} tone={bh?.possible ? pnlTone(bh.pnl) : 'neutral'} hint={bh?.possible ? pct(bh.pnlPct, { sign: true }) : bh?.reason} />
        <Stat label="Estrategia vs. comprar y mantener" value={m.vsBuyAndHold === null ? '—' : usdt(m.vsBuyAndHold, { sign: true, digits: 4 })} tone={m.vsBuyAndHold === null ? 'neutral' : pnlTone(m.vsBuyAndHold)} hint="diferencia en USDT" />
        <Stat label="Operaciones" value={m.trades} hint={`${m.wins} ganadoras · ${m.losses} perdedoras`} />
        <Stat label="% ganadoras" value={m.winRatePct === null ? '—' : pct(m.winRatePct, { digits: 1 })} hint={`prom. ${usdt(m.avgWin, { sign: true, digits: 4 })} / ${usdt(m.avgLoss, { sign: true, digits: 4 })}`} />
        <Stat label="Profit factor" value={pf.text} tone={pf.tone} hint="ganancias ÷ pérdidas" />
        <Stat label="Máximo drawdown" value={pct(m.maxDrawdownPct, { digits: 2 })} tone={m.maxDrawdownPct > 20 ? 'danger' : m.maxDrawdownPct > 10 ? 'warn' : 'neutral'} hint={`${usdt(m.maxDrawdown, { digits: 4 })} desde ${usdt(m.peak, { digits: 2 })}`} />
        <Stat label="Comisiones pagadas" value={usdt(m.totalFees, { digits: 4 })} hint={m.netPnl < 0 && m.totalFees > 0 ? `${pct((m.totalFees / Math.abs(m.netPnl)) * 100, { digits: 0 })} de la pérdida` : null} />
      </div>

      <div className="stack">
        <div className="legend">
          <span className="legend-time">{at === null ? '—' : dateTime(at * 1000, { seconds: false })}</span>
          <span className="legend-line"><span className="swatch" data-color="fast" aria-hidden="true" /> Estrategia <strong>{usdt(valueAt(run.equity, at), { digits: 4 })}</strong></span>
          {run.buyHold ? <span className="legend-line"><span className="swatch swatch-dashed" data-color="slow" aria-hidden="true" /> Comprar y mantener <strong>{usdt(valueAt(run.buyHold, at), { digits: 4 })}</strong></span> : null}
        </div>
        <EquityChart equity={run.equity} buyHold={run.buyHold} capital={run.capital} colors={colors} onHover={setHover} steps={run.equitySource === 'trades'} />
        <div className="chart-foot">
          <span className="muted">
            {run.equitySource === 'trades'
              ? 'Curva por operación cerrada: este backtest se guardó antes de que se registrara la curva completa (vuelve a correrlo para verla vela a vela).'
              : `Curva vela a vela (${run.equityPoints} puntos${run.equityPoints > run.equity.length ? `, se muestran ${run.equity.length}` : ''}).`}
            {run.buyHoldNote ? ` Comprar y mantener: ${run.buyHoldNote}.` : ''}
          </span>
          <a className="attribution" href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Gráfico: TradingView Lightweight Charts™</a>
        </div>
      </div>

      {comparison ? (
        <div className="stack">
          <h3 className="subhead">Ajuste vs. validación</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Período</th><th className="num">Resultado</th><th className="num">Operaciones</th><th className="num">% ganadoras</th><th className="num">Profit factor</th><th className="num">Máx. drawdown</th><th className="num">vs. comprar y mantener</th></tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.id} className={row.id === run.id ? 'is-open' : undefined}>
                    <td>{row.segment}</td>
                    <td className={`num tone-${pnlTone(row.netPnlPct)}`}>{pct(row.netPnlPct, { sign: true })}</td>
                    <td className="num">{row.trades}</td>
                    <td className="num">{row.winRatePct === null ? '—' : pct(row.winRatePct, { digits: 1 })}</td>
                    <td className="num">{profitFactor(row.profitFactor, row.trades).text}</td>
                    <td className="num">{pct(row.maxDrawdownPct)}</td>
                    <td className={`num tone-${row.vsBuyAndHold === null ? 'neutral' : pnlTone(row.vsBuyAndHold)}`}>{row.vsBuyAndHold === null ? '—' : usdt(row.vsBuyAndHold, { sign: true, digits: 4 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine-print">La validación usa datos que NO se usaron para elegir los parámetros: es la prueba honesta. Si empeora mucho respecto del ajuste, los parámetros probablemente estaban sobreajustados.</p>
        </div>
      ) : null}

      {grid.length ? (
        <div className="stack">
          <h3 className="subhead">Combinaciones probadas en el ajuste</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Parámetros</th><th className="num">Resultado</th><th className="num">Operaciones</th><th className="num">Profit factor</th><th /></tr></thead>
              <tbody>
                {grid.map((row) => (
                  <tr key={JSON.stringify(row.params)} className={row.chosen ? 'is-open' : undefined}>
                    <td>{formatParams(row.params)}</td>
                    <td className={`num tone-${pnlTone(row.netPnl)}`}>{usdt(row.netPnl, { sign: true, digits: 4 })}</td>
                    <td className="num">{row.trades}</td>
                    <td className="num">{profitFactor(row.profitFactor, row.trades).text}</td>
                    <td>{row.chosen ? <strong>elegida</strong> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {m.halts || rejections.length || m.openPositionAtEnd || m.unexecutedFinalSignal ? (
        <ul className="list fine-print">
          {m.halts ? <li>El límite de pérdida diaria detuvo la estrategia {m.halts} {m.halts === 1 ? 'vez' : 'veces'} (se reanuda sola a las 00:00 UTC en la simulación).</li> : null}
          {rejections.length ? <li>Señales rechazadas por el riesgo: {rejections.map((r) => `${REJECT_LABELS[r.code] ?? r.code} (${r.count})`).join(', ')}.</li> : null}
          {m.openPositionAtEnd ? <li>Terminó con una posición abierta de {qty(m.openPositionAtEnd.qty)}: se valoró como si se vendiera al último cierre ({price(m.openPositionAtEnd.markPrice)}).</li> : null}
          {m.unexecutedFinalSignal ? <li>La última señal ({m.unexecutedFinalSignal.action}) llegó en la última vela: no hubo vela siguiente para ejecutarla.</li> : null}
        </ul>
      ) : null}

      <details className="explain">
        <summary>Operaciones ({run.trades.length})</summary>
        {run.trades.length ? (
          <div className="table-wrap table-scroll">
            <table className="table">
              <thead><tr><th className="num">#</th><th>Entrada</th><th className="num">Precio</th><th>Salida</th><th className="num">Precio</th><th className="num">Cantidad</th><th className="num">Comisiones</th><th className="num">Resultado</th></tr></thead>
              <tbody>
                {run.trades.map((t) => (
                  <tr key={t.n}>
                    <td className="num">{t.n}</td>
                    <td>{dateTime(t.entryTime, { seconds: false })}</td>
                    <td className="num">{price(t.entryPrice)}</td>
                    <td>{dateTime(t.exitTime, { seconds: false })}</td>
                    <td className="num">{price(t.exitPrice)}</td>
                    <td className="num">{qty(t.qty)}</td>
                    <td className="num">{usdt(t.fees, { digits: 4 })}</td>
                    <td className={`num tone-${pnlTone(t.pnl)}`}>{usdt(t.pnl, { sign: true, digits: 4 })} <span className="muted">({pct(t.pnlPct, { sign: true })})</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">Sin operaciones cerradas.</p>}
      </details>

      <details className="explain">
        <summary>¿Cómo leer estas métricas?</summary>
        <ul className="list">
          <li><strong>Resultado neto:</strong> cuánto ganó o perdió el capital, con comisiones y slippage. Una posición abierta al final se valora como si se vendiera.</li>
          <li><strong>Comprar y mantener:</strong> comprar al inicio del período y no hacer nada más. Es la referencia mínima: una estrategia que no la supera no aporta.</li>
          <li><strong>% ganadoras:</strong> por sí solo engaña. Con pocas ganadoras grandes y muchas perdedoras chicas se puede ganar; con muchas ganadoras chicas y una pérdida enorme, perder.</li>
          <li><strong>Profit factor:</strong> ganancias brutas ÷ pérdidas brutas. Mayor que 1 gana más de lo que pierde; menor que 1, pierde.</li>
          <li><strong>Máximo drawdown:</strong> la peor caída del capital desde un máximo hasta un mínimo posterior. Mide cuánto "dolor" habría que aguantar.</li>
          <li><strong>Comisiones:</strong> con muchas operaciones pequeñas pueden comerse todo el resultado.</li>
        </ul>
      </details>
    </div>
  );
}
