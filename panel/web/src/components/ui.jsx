/**
 * Piezas básicas de la interfaz: tarjeta, etiqueta, avisos y estados vacíos.
 * Ninguna pantalla queda en blanco: si no hay datos, se dice por qué.
 */
import { Icon } from './Icon.jsx';

/** Tarjeta de una sección. */
export function Card({ title, subtitle, actions, className = '', children }) {
  return (
    <section className={`card ${className}`}>
      <header className="card-header">
        <div>
          <h2 className="card-title">{title}</h2>
          {subtitle ? <p className="card-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Etiqueta de estado. tone: ok | info | warn | danger | neutral */
export function Badge({ tone = 'neutral', dot = false, children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Aviso a lo ancho de la página. tone: info | warn | danger */
export function Banner({ tone = 'info', title, children, action }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={tone === 'info' ? 'info' : 'alert'} className="banner-icon" />
      <div className="banner-text">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="banner-action">{action}</div> : null}
    </div>
  );
}

/** Sin datos (todavía): explica qué falta y, si aplica, qué hacer. */
export function EmptyState({ title, children, icon = 'info' }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} className="empty-icon" />
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
    </div>
  );
}

/** Error al pedir datos, con el motivo que da el servidor. */
export function ErrorState({ error, onRetry }) {
  const database = error?.database;
  if (database) {
    // Base inexistente, en otra versión, etc.: el servidor explica qué hacer.
    return <EmptyState title="Sin datos" icon="info">{database.message}</EmptyState>;
  }
  return (
    <EmptyState title="No se pudieron cargar los datos" icon="alert">
      <p>{error?.message ?? 'Error desconocido.'}</p>
      {onRetry ? <button type="button" className="button" onClick={onRetry}>Reintentar</button> : null}
    </EmptyState>
  );
}

/** Mientras llegan los datos. */
export function Loading({ label = 'Cargando…' }) {
  return <p className="loading" aria-live="polite">{label}</p>;
}

/** Texto de código o comando (p. ej. npm run resume). */
export const Cmd = ({ children }) => <code className="cmd">{children}</code>;
