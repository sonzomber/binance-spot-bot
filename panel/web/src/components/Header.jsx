/**
 * Encabezado: nombre, pestañas, ámbito (entorno + modo), conexión en vivo,
 * tema y el kill switch (siempre visible).
 */
import { ALL_SCOPES, CONNECTION_STATES, MODE_HINTS, parseScopeKey, scopeKey, scopeLabel } from '../lib/labels.js';
import { THEME_LABELS, nextTheme } from '../lib/theme.js';
import { Icon } from './Icon.jsx';
import { KillSwitchButton } from './KillSwitch.jsx';
import { Badge } from './ui.jsx';

const THEME_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' };
export const TABS = Object.freeze([
  { id: 'bot', label: 'Bot en vivo' },
  { id: 'backtests', label: 'Backtests' },
]);

export function Header({ tab, onTab, scope, scopes, onScope, connection, theme, onTheme, killSwitch, restarted, onKillActivated }) {
  const conn = CONNECTION_STATES[connection] ?? CONNECTION_STATES.connecting;
  const withData = new Set((scopes ?? []).filter((s) => s.hasStatus || s.orders > 0).map(scopeKey));

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Icon name="chart" size={16} /></span>
          <span className="brand-name">Panel del bot</span>
          <Badge tone="neutral" title="El panel no puede operar: solo muestra datos y activa el kill switch">solo lectura</Badge>
        </div>

        <nav className="tabs" aria-label="Secciones">
          {TABS.map((t) => (
            <a key={t.id} href={`#/${t.id}`} className={`tab${tab === t.id ? ' is-active' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => onTab(t.id)}>
              {t.label}
            </a>
          ))}
        </nav>

        <div className="topbar-actions">
          {tab === 'bot' ? (
            <label className="scope-select" title={MODE_HINTS[scope?.mode]}>
              <span className="visually-hidden">Entorno y modo</span>
              <select value={scopeKey(scope)} onChange={(event) => onScope(parseScopeKey(event.target.value))}>
                {ALL_SCOPES.map((s) => (
                  <option key={scopeKey(s)} value={scopeKey(s)}>
                    {scopeLabel(s)}{withData.has(scopeKey(s)) ? '' : ' (sin datos)'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Badge tone={conn.tone} dot title="Conexión en tiempo real con el servidor del panel">{conn.label}</Badge>
          <button type="button" className="button button-icon" onClick={() => onTheme(nextTheme(theme))} title={`${THEME_LABELS[theme]} (clic para cambiar)`} aria-label={`${THEME_LABELS[theme]}. Cambiar tema`}>
            <Icon name={THEME_ICONS[theme]} />
          </button>
          <KillSwitchButton killSwitch={killSwitch} restarted={restarted} onActivated={onKillActivated} />
        </div>
      </div>
    </header>
  );
}
