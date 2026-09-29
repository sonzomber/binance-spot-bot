/**
 * Logs recientes del bot, del más nuevo al más viejo, con filtro por nivel
 * (info, aviso, error) y por ámbito. Las líneas "generales" (sin ámbito:
 * scripts, backtest, el panel) se pueden incluir o no.
 *
 * Al abrir se piden las últimas 200 al servidor; después llegan en vivo por
 * SSE y se filtran aquí con la misma regla. Los secretos ya vienen ocultos
 * (pino al escribir y el servidor del panel al enviar).
 */
import { useEffect, useState } from 'react';
import { Badge, Card, EmptyState, ErrorState, Loading } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { useLive } from '../hooks/live.jsx';
import { time } from '../lib/format.js';
import { scopeKey, scopeLabel } from '../lib/labels.js';
import { LOG_LEVELS, levelTone, matchesLog, mergeLines } from '../lib/logs-view.js';

export function LogsSection({ scope }) {
  const [levels, setLevels] = useState(['info', 'warn', 'error']);
  const [includeGeneral, setIncludeGeneral] = useState(true);
  const [paused, setPaused] = useState(false);
  const toggleLevel = (id) => setLevels((current) => (current.includes(id) ? current.filter((l) => l !== id) : [...current, id]));

  // Sin niveles elegidos no se pide nada (el servidor usaría todos por defecto).
  const { data, error, loading, reload } = useApi(levels.length ? '/api/logs' : null, {
    ...scope, levels, general: includeGeneral ? 1 : 0, limit: 200,
  }, { followDb: false });

  const filter = { scopeKey: scopeKey(scope), levels, includeGeneral };
  const [lines, setLines] = useState([]);
  const [pending, setPending] = useState([]);

  // Lo que devolvió el servidor (vienen de la más vieja a la más nueva).
  useEffect(() => {
    setLines(data ? mergeLines([], data.lines) : []);
    setPending([]);
  }, [data]);

  // Líneas nuevas en vivo, con el mismo filtro. En pausa se acumulan aparte.
  const { subscribeLogs } = useLive();
  const filterKey = JSON.stringify(filter);
  useEffect(() => subscribeLogs((incoming) => {
    const matching = incoming.filter((line) => matchesLog(line, filter));
    if (!matching.length) return;
    if (paused) setPending((p) => [...p, ...matching]);
    else setLines((shown) => mergeLines(shown, matching));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [subscribeLogs, filterKey, paused]);

  const resume = () => {
    setLines((shown) => mergeLines(shown, pending));
    setPending([]);
    setPaused(false);
  };

  const controls = (
    <div className="filters-row">
      <div className="chips" role="group" aria-label="Filtrar por nivel">
        {LOG_LEVELS.map((l) => (
          <button key={l.id} type="button" className={`chip chip-${l.tone}${levels.includes(l.id) ? ' is-on' : ''}`} aria-pressed={levels.includes(l.id)} onClick={() => toggleLevel(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={includeGeneral} onChange={(event) => setIncludeGeneral(event.target.checked)} />
        <span>Incluir generales</span>
      </label>
      <button type="button" className="button" onClick={paused ? resume : () => setPaused(true)}>
        {paused ? `Reanudar${pending.length ? ` (${pending.length} ${pending.length === 1 ? 'nueva' : 'nuevas'})` : ''}` : 'Pausar'}
      </button>
    </div>
  );

  let body;
  if (!levels.length) body = <EmptyState title="Elige al menos un nivel">Info, aviso o error.</EmptyState>;
  else if (error && !data) body = <ErrorState error={error} onRetry={reload} />;
  else if (loading || !data) body = <Loading />;
  else if (!data.exists) body = <EmptyState title="Todavía no hay archivo de log">Se crea cuando el bot (o un comando) escribe en {data.file}.</EmptyState>;
  else if (!lines.length) body = <EmptyState title="Sin líneas con estos filtros">Prueba incluir más niveles o las líneas generales.</EmptyState>;
  else body = <LogList lines={lines} />;

  return (
    <Card title="Logs recientes" subtitle={`${scopeLabel(scope)}${data?.file ? ` · ${data.file}` : ''}`} className="span-12" actions={controls}>
      {body}
    </Card>
  );
}

function LogList({ lines }) {
  return (
    <ol className="logs" aria-label="Líneas de log, de la más nueva a la más vieja">
      {lines.map((line, i) => (
        <li key={`${line.time}-${i}`} className={`log log-${levelTone(line.level)}`}>
          <span className="log-time" title={line.time}>{time(line.time)}</span>
          <Badge tone={levelTone(line.level)}>{line.levelName}</Badge>
          {line.scope ? null : <span className="log-general">general</span>}
          {line.data ? (
            <details className="log-details">
              <summary className="log-msg">{line.msg}</summary>
              <pre className="log-data">{JSON.stringify(line.data, null, 2)}</pre>
            </details>
          ) : <span className="log-msg">{line.msg}</span>}
        </li>
      ))}
    </ol>
  );
}
