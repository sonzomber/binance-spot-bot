/**
 * Órdenes del ámbito elegido, con filtros por estado, lado y clientOrderId,
 * y paginación. Incluye las que el riesgo rechazó sin enviarlas, con el motivo:
 * el historial muestra no solo lo que el bot hizo, sino lo que intentó y por qué no pudo.
 *
 * Los filtros los aplica el servidor (SQL parametrizado, solo de este ámbito).
 */
import { Fragment, useState } from 'react';
import { Badge, Card, EmptyState, ErrorState, KeyValue, Loading } from '../components/ui.jsx';
import { useApi } from '../hooks/useApi.js';
import { useDebounced } from '../hooks/useDebounced.js';
import { dateTime, price, qty, usdt } from '../lib/format.js';
import { scopeLabel } from '../lib/labels.js';
import { ORDER_STATUSES, PAGE_SIZE, SIDES, displayPrice, displayQty, orderStatus, pageLabel, rejection, sideLabel } from '../lib/orders-view.js';

export function OrdersSection({ scope }) {
  const [statuses, setStatuses] = useState([]);
  const [side, setSide] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const q = useDebounced(search.trim(), 300);

  const { data, error, loading, reload } = useApi('/api/orders', {
    ...scope, status: statuses, side, q: q || null, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  });

  // Cualquier cambio de filtro vuelve a la primera página.
  const toggleStatus = (id) => {
    setStatuses((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));
    setPage(0);
  };
  const chooseSide = (id) => { setSide(id); setPage(0); };
  const typeSearch = (text) => { setSearch(text); setPage(0); };
  const filtered = statuses.length > 0 || side !== null || q !== '';

  return (
    <Card title="Órdenes" subtitle={scopeLabel(scope)} className="span-12">
      <div className="stack">
        <div className="filters">
          <div className="chips" role="group" aria-label="Filtrar por estado">
            {ORDER_STATUSES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chip chip-${s.tone}${statuses.includes(s.id) ? ' is-on' : ''}`}
                aria-pressed={statuses.includes(s.id)}
                onClick={() => toggleStatus(s.id)}
              >
                {s.label}
                <span className="chip-count">{data?.byStatus?.[s.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="filters-row">
            <div className="segmented" role="group" aria-label="Filtrar por lado">
              {SIDES.map((s) => (
                <button key={String(s.id)} type="button" className={side === s.id ? 'is-on' : ''} aria-pressed={side === s.id} onClick={() => chooseSide(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
            <label className="search">
              <span className="visually-hidden">Buscar por clientOrderId</span>
              <input type="search" value={search} maxLength={64} placeholder="Buscar clientOrderId…" onChange={(event) => typeSearch(event.target.value)} />
            </label>
          </div>
        </div>

        {error && !data ? <ErrorState error={error} onRetry={reload} />
          : loading || !data ? <Loading />
            : data.total === 0 ? (
              <EmptyState title={filtered ? 'Ninguna orden coincide con los filtros' : 'Todavía no hay órdenes en este ámbito'}>
                {filtered ? 'Quita algún filtro para ver más.' : 'Aparecen aquí cuando la estrategia da una señal (incluidas las que el riesgo rechaza, con el motivo).'}
              </EmptyState>
            ) : <OrdersTable data={data} page={page} onPage={setPage} />}
      </div>
    </Card>
  );
}

function OrdersTable({ data, page, onPage }) {
  const [open, setOpen] = useState(null);
  const pages = Math.ceil(data.total / PAGE_SIZE);

  return (
    <>
      <div className="table-wrap">
        <table className="table table-orders">
          <caption className="visually-hidden">Órdenes</caption>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Lado</th>
              <th>Estado</th>
              <th className="num">Cantidad</th>
              <th className="num">Precio</th>
              <th className="num">Comisión</th>
              <th>clientOrderId</th>
              <th>Motivo de rechazo</th>
              <th><span className="visually-hidden">Detalle</span></th>
            </tr>
          </thead>
          <tbody>
            {data.orders.map((o) => {
              const status = orderStatus(o.status);
              const p = displayPrice(o);
              const amount = displayQty(o);
              const rej = rejection(o);
              const expanded = open === o.id;
              return (
                <Fragment key={o.id}>
                  <tr className={expanded ? 'is-open' : undefined}>
                    <td title={dateTime(o.createdAt, { utc: true })}>{dateTime(o.createdAt)}</td>
                    <td><span className={`side side-${o.side}`}>{sideLabel(o.side)}</span></td>
                    <td><Badge tone={status.tone}>{status.label}</Badge></td>
                    <td className="num">{qty(amount.value)}{amount.of ? <span className="muted"> de {qty(amount.of)}</span> : null}</td>
                    <td className="num" title={p.kind ? `precio ${p.kind}` : undefined}>
                      {price(p.value)}{p.kind === 'esperado' ? <span className="muted"> esp.</span> : null}
                    </td>
                    <td className="num">{o.feeQuote > 0 ? usdt(o.feeQuote, { digits: 4 }) : '—'}</td>
                    <td className="mono" title={o.clientOrderId}>{o.clientOrderId}</td>
                    <td className="wrap">
                      {rej ? <span title={rej.reason}><strong>{rej.text}</strong> <span className="muted">· {rej.who}</span></span> : <span className="muted">—</span>}
                    </td>
                    <td>
                      <button type="button" className="link-button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : o.id)}>
                        {expanded ? 'Ocultar' : 'Detalle'}
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="detail-row">
                      <td colSpan={9}><OrderDetail order={o} rejection={rej} /></td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span className="muted">{pageLabel(page * PAGE_SIZE, data.orders.length, data.total)}</span>
        <button type="button" className="button" disabled={page === 0} onClick={() => onPage(page - 1)}>Anterior</button>
        <button type="button" className="button" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Siguiente</button>
      </div>
    </>
  );
}

function OrderDetail({ order, rejection: rej }) {
  return (
    <KeyValue
      items={[
        { label: 'clientOrderId', value: <span className="mono">{order.clientOrderId}</span>, hint: 'ID propio: se guarda ANTES de enviar (idempotencia)' },
        { label: 'ID en el exchange', value: order.exchangeOrderId ?? '—', hint: order.exchangeOrderId ? null : 'sin ID: no se envió o no llegó' },
        { label: 'Par y tipo', value: `${order.symbol} · ${order.type === 'market' ? 'de mercado' : 'límite'}` },
        { label: 'Pedido / ejecutado', value: `${qty(order.amount)} / ${qty(order.filledQty)}`, hint: `${order.fills} ejecución(es) · ${usdt(order.filledQuote)} en total` },
        { label: 'Precio promedio', value: price(order.avgFillPrice), hint: order.price ? `esperado al decidir: ${price(order.price)}` : null },
        { label: 'Comisión', value: usdt(order.feeQuote, { digits: 6 }) },
        { label: 'Estrategia y señal', value: order.strategy ?? '—', hint: order.signalCode },
        { label: 'Creada · aceptada · cerrada', value: `${dateTime(order.createdAt)} · ${dateTime(order.acceptedAt)} · ${dateTime(order.closedAt)}` },
        rej && { label: 'Rechazo', value: `${rej.text} (${rej.code})`, hint: `${rej.who}: ${rej.reason}` },
      ]}
    />
  );
}
