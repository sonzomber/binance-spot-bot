/**
 * Backtests guardados: lista agrupada por corrida (un backtest con ajuste y
 * validación guarda dos resultados con el mismo grupo) y el detalle del
 * elegido: métricas, parámetros, período, curva de capital contra "comprar y
 * mantener", comparación ajuste/validación, grid y operaciones.
 *
 * Son datos históricos de PRODUCCIÓN leídos en solo lectura (entorno
 * production-readonly): no dependen del entorno elegido arriba para el bot.
 * La corrida elegida queda en la URL (#/backtests/ID).
 */
import { useEffect, useState } from 'react';
import { Card, Cmd, EmptyState, ErrorState, Loading } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { defaultRunId, periodLabel, runIdFromHash, segmentLabel } from '../lib/backtest-view.js';
import { dateTime, pct } from '../lib/format.js';
import { formatParams } from '../lib/status-view.js';
import { BacktestDetail } from './BacktestDetail.jsx';

export function BacktestsSection() {
  const { data, error, loading, reload } = useApi('/api/backtests', { limit: 50 });
  const [chosen, setChosen] = useState(() => runIdFromHash(globalThis.location?.hash));
  useEffect(() => {
    const onHash = () => setChosen(runIdFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const choose = (id) => { window.location.hash = `#/backtests/${id}`; };

  if (error && !data) return <Card title="Backtests guardados" className="span-12"><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading || !data) return <Card title="Backtests guardados" className="span-12"><Loading /></Card>;
  if (!data.groups.length) {
    return (
      <Card title="Backtests guardados" className="span-12">
        <EmptyState title="Todavía no hay backtests guardados">
          Corre uno con <Cmd>npm run backtest -- --from 2025-01-01 --to 2025-07-01 --split 2025-05-01</Cmd> y aparecerá aquí.
        </EmptyState>
      </Card>
    );
  }

  const runs = data.groups.flatMap((g) => g.runs);
  const selectedId = runs.some((r) => r.id === chosen) ? chosen : defaultRunId(data.groups);
  const group = data.groups.find((g) => g.runs.some((r) => r.id === selectedId));

  return (
    <>
      <Card title="Backtests guardados" subtitle="Datos históricos de producción (solo lectura)" className="span-4 backtest-list">
        <ul className="runs">
          {data.groups.map((g) => (
            <li key={g.groupId} className="run-group">
              <p className="run-group-head">
                <strong>{g.strategy}</strong> · {g.symbol} {g.timeframe}
                <span className="muted"> · {dateTime(g.createdAt, { seconds: false })}</span>
              </p>
              {g.runs.map((r) => (
                <button key={r.id} type="button" className={`run${r.id === selectedId ? ' is-on' : ''}`} aria-current={r.id === selectedId ? 'true' : undefined} onClick={() => choose(r.id)}>
                  <span className="run-title">{segmentLabel(r.segment)} <span className="muted">#{r.id}</span></span>
                  <span className={`run-pnl tone-${r.netPnl > 0 ? 'ok' : r.netPnl < 0 ? 'danger' : 'neutral'}`}>{pct(r.netPnlPct, { sign: true })}</span>
                  <span className="run-meta">{formatParams(r.params)} · {periodLabel(r.periodFrom, r.periodTo)} · {r.trades} op.</span>
                </button>
              ))}
            </li>
          ))}
        </ul>
      </Card>
      <BacktestDetail key={selectedId} runId={selectedId} group={group} />
    </>
  );
}
