/**
 * Riesgo del día en el ámbito elegido: PnL con comisiones, cuánto falta para
 * el límite de pérdida diaria (barra) y posiciones abiertas contra el máximo.
 *
 * Los números los calcula el servidor con el MISMO RiskManager.dailyPnl() del
 * bot; aquí solo se muestran.
 */
import { Badge, Card, ErrorState, Loading, ProgressBar, Stat } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { useNow } from '../hooks/useNow.js';
import { ago, dateTime, pct, price, qty, usdt } from '../lib/format.js';
import { scopeLabel } from '../lib/labels.js';
import { lossBar, markSourceLabel, nextUtcMidnight, pnlTone, positionsUsage } from '../lib/risk-view.js';

export function RiskSection({ scope }) {
  const { data: risk, error, loading, reload } = useApi('/api/risk', scope, { refreshMs: 15_000 });

  let body;
  if (error && !risk) body = <ErrorState error={error} onRetry={reload} />;
  else if (loading || !risk) body = <Loading />;
  else body = <RiskBody risk={risk} />;

  return (
    <Card
      title="Riesgo del día"
      subtitle={`${scopeLabel(scope)} · día ${risk?.day ?? '—'} (UTC)`}
      className="span-7"
      actions={risk?.halt?.halted ? <Badge tone="danger">Parada activa</Badge> : null}
    >
      {body}
    </Card>
  );
}

function RiskBody({ risk }) {
  const now = useNow(30_000);
  const bar = lossBar(risk);
  const usage = positionsUsage(risk.openPositions, risk.maxOpenPositions);
  const reset = nextUtcMidnight(now);

  return (
    <div className="stack-lg">
      <div className="stats">
        <Stat label="PnL del día (neto)" value={usdt(risk.total, { sign: true })} tone={pnlTone(risk.total)} hint="con comisiones" />
        <Stat
          label="Realizado"
          value={usdt(risk.realized, { sign: true })}
          tone={pnlTone(risk.realized)}
          hint={`${risk.closedTrades} operación(es) cerrada(s) · comisiones ${usdt(risk.realizedFees)}`}
        />
        <Stat
          label="No realizado"
          value={usdt(risk.unrealized, { sign: true })}
          tone={pnlTone(risk.unrealized)}
          hint={risk.openPositions ? 'si se vendiera ahora' : 'sin posiciones abiertas'}
        />
      </div>

      <div className="meter">
        <div className="meter-head">
          <span className="meter-title">Límite de pérdida diaria</span>
          <span className={`meter-value tone-${bar.tone}`}>
            {risk.reached ? 'Límite alcanzado' : `Faltan ${usdt(bar.remaining)}`}
          </span>
        </div>
        <ProgressBar value={bar.usedPct} tone={bar.tone} label="Uso del límite de pérdida diaria" />
        <p className="meter-foot">
          {bar.inProfit
            ? `Vas ganando en el día: el margen hasta la parada (${usdt(bar.remaining)}) es el límite de ${usdt(risk.lossLimit)} más la ganancia.`
            : `Pérdida neta ${usdt(bar.loss)} de ${usdt(risk.lossLimit)} (${pct(bar.usedPct)}).`}
          {' '}Se reinicia a las 00:00 UTC ({dateTime(reset, { seconds: false })} hora local).
        </p>
      </div>

      <div className="meter">
        <div className="meter-head">
          <span className="meter-title">Posiciones abiertas</span>
          <span className={`meter-value tone-${usage.tone}`}>{usage.open} de {usage.max}</span>
        </div>
        <ProgressBar value={(usage.open / usage.max) * 100} tone={usage.tone} label="Posiciones abiertas contra el máximo" />
        {usage.full ? <p className="meter-foot">Máximo alcanzado: el bot no abrirá nuevas posiciones hasta cerrar alguna.</p> : null}
      </div>

      {risk.positions.length ? <Positions risk={risk} now={now} /> : null}

      <p className="fine-print">
        Límites {risk.limitsSource === 'bot' ? 'del bot en marcha' : 'del .env (el bot no ha corrido en este ámbito)'}:
        {' '}pérdida diaria máx. {usdt(risk.lossLimit)} · máx. por operación {usdt(risk.limits.maxTradeUsdt)} · posiciones máx. {risk.maxOpenPositions}.
        {risk.mark ? ` Precio para valorar: ${price(risk.mark.price)} (${markSourceLabel(risk.mark)}, ${dateTime(risk.mark.time)}).` : ''}
        {risk.missingPrices.length ? ` Sin precio actual para ${risk.missingPrices.join(', ')}: ${markSourceLabel(null)}.` : ''}
      </p>

      <details className="explain">
        <summary>¿Cómo se calcula?</summary>
        <ul className="list">
          <li><strong>Realizado:</strong> operaciones cerradas hoy (día UTC), restando la comisión de compra y la de venta.</li>
          <li><strong>No realizado:</strong> lo que se ganaría o perdería si se vendieran ahora las posiciones abiertas, restando la comisión estimada de venta. Se mide desde la entrada, aunque haya sido otro día (conservador).</li>
          <li>Si el total llega a −{usdt(risk.lossLimit)}, el bot hace una parada de emergencia: cancela órdenes pendientes y deja de operar (también bloquea las ventas). Reanudar es manual.</li>
          <li>Las ganancias del día compensan las pérdidas: se mide el neto.</li>
        </ul>
      </details>
    </div>
  );
}

function Positions({ risk, now }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">Posiciones abiertas</caption>
        <thead>
          <tr>
            <th>Par</th>
            <th className="num">Cantidad</th>
            <th className="num">Precio de entrada</th>
            <th className="num">Precio actual</th>
            <th className="num">No realizado</th>
            <th>Abierta</th>
          </tr>
        </thead>
        <tbody>
          {risk.positions.map((p) => (
            <tr key={p.id}>
              <td>{p.symbol}</td>
              <td className="num">{qty(p.qty)}</td>
              <td className="num">{price(p.entryPrice)}</td>
              <td className="num">{price(p.markPrice)}</td>
              <td className={`num tone-${pnlTone(p.unrealized)}`}>{usdt(p.unrealized, { sign: true, digits: 4 })}</td>
              <td title={dateTime(p.entryTime)}>{ago(now - Date.parse(p.entryTime))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
