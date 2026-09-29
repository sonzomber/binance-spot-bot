/**
 * Estado del bot en el ámbito elegido: corriendo, detenido, sin responder o
 * en kill switch; entorno y modo; estrategia y parámetros; si los datos están
 * al día; última vela procesada y último heartbeat.
 *
 * Se vuelve a pedir cada 5 s (además de cada cambio en la base): "sin
 * responder" aparece justamente cuando el bot deja de escribir.
 */
import { Badge, Card, Cmd, ErrorState, KeyValue, Loading } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { useNow } from '../hooks/useNow.js';
import { ago, dateTime, price } from '../lib/format.js';
import { ENV_LABELS, MODE_HINTS, MODE_LABELS, scopeLabel } from '../lib/labels.js';
import { dataFreshness, formatParams, haltLabel, stateExplanation, statusBadges } from '../lib/status-view.js';

const since = (iso, now) => (iso ? ago(now - Date.parse(iso)) : null);

export function StatusSection({ scope }) {
  const { data: status, error, loading, reload } = useApi('/api/status', scope, { refreshMs: 5000 });
  const now = useNow(1000);

  let body;
  if (error && !status) body = <ErrorState error={error} onRetry={reload} />;
  else if (loading || !status) body = <Loading />;
  else body = <StatusBody status={status} now={now} />;

  return (
    <Card title="Estado del bot" subtitle={scopeLabel(scope)} className="span-5" actions={status ? <Badges status={status} /> : null}>
      {body}
    </Card>
  );
}

function Badges({ status }) {
  return statusBadges(status).map((b) => <Badge key={b.label} tone={b.tone} dot={b.tone === 'ok'} title={b.title}>{b.label}</Badge>);
}

function StatusBody({ status, now }) {
  const bot = status.bot;
  const explanation = stateExplanation(status);
  const data = dataFreshness(status);

  return (
    <div className="stack">
      {explanation ? <p className="note">{explanation}</p> : null}
      {status.halt?.halted ? (
        <p className="note note-danger">
          Parada guardada: {status.halt.reason ?? haltLabel(status.halt.code)}. Desde {dateTime(status.halt.haltedAt)}.
          {' '}El bot no opera en este ámbito hasta reanudarlo con <Cmd>npm run resume</Cmd>.
        </p>
      ) : null}

      <KeyValue
        items={[
          { label: 'Entorno', value: ENV_LABELS[status.scope.env] },
          { label: 'Modo', value: MODE_LABELS[status.scope.mode], hint: MODE_HINTS[status.scope.mode] },
          bot && { label: 'Estrategia', value: bot.strategy, hint: formatParams(bot.params) },
          bot && { label: 'Par e intervalo', value: `${bot.symbol} · ${bot.timeframe}` },
          bot && { label: 'Datos de mercado', value: <Badge tone={data.tone}>{data.label}</Badge>, hint: data.detail },
          bot && {
            label: 'Última vela procesada',
            value: bot.lastCandle ? dateTime(bot.lastCandle) : 'ninguna todavía',
            hint: bot.lastCandle ? `inicio de la vela · ${since(bot.lastCandle, now)}` : null,
          },
          bot && {
            label: 'Último heartbeat',
            value: bot.heartbeatAt ? dateTime(bot.heartbeatAt) : '—',
            hint: bot.heartbeatAt ? `${since(bot.heartbeatAt, now)} · se registra cada ${Math.round(bot.heartbeatMs / 1000)} s` : null,
          },
          bot?.price && { label: 'Último precio', value: price(bot.price), hint: bot.priceTime ? since(bot.priceTime, now) : null },
          bot && { label: 'Arrancó', value: dateTime(bot.startedAt), hint: `PID ${bot.pid}` },
          bot?.stoppedAt && {
            label: 'Se detuvo',
            value: dateTime(bot.stoppedAt),
            hint: `${bot.stopReason ?? 'sin motivo'}${bot.exitCode ? ` · código de salida ${bot.exitCode}` : ''}`,
          },
          !bot?.stoppedAt && bot?.stopReason && status.state === 'stopping' && { label: 'Motivo del apagado', value: bot.stopReason },
        ]}
      />
    </div>
  );
}
