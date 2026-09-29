/**
 * Estructura del panel:
 *   1. Arranque: pide /api/meta (estado de la base, ámbitos, kill switch, config pública).
 *   2. Conexión en vivo (SSE) y encabezado con el ámbito, el tema y el kill switch.
 *   3. Avisos globales: kill switch activo, base no disponible, conexión perdida,
 *      panel reiniciado, advertencias de la config.
 *   4. Pestañas: "Bot en vivo" (del ámbito elegido) y "Backtests".
 */
import { useCallback, useEffect, useState } from 'react';
import { Header } from './components/Header.jsx';
import { Banner, Cmd, EmptyState, Loading } from './components/ui.jsx';
import { LiveProvider, useLive } from './hooks/live.jsx';
import { useApi } from './hooks/useApi.js';
import { getJson } from './lib/api.js';
import { dateTime } from './lib/format.js';
import { parseScopeKey, scopeKey } from './lib/labels.js';
import { applyTheme, loadTheme, saveTheme } from './lib/theme.js';
import { BacktestsSection, ChartSection, LogsSection, OrdersSection, RiskSection, StatusSection } from './sections/sections.jsx';

const SCOPE_KEY = 'panel-scope';

export function App() {
  const [boot, setBoot] = useState({ meta: null, error: null });
  const load = useCallback(() => {
    setBoot({ meta: null, error: null });
    getJson('/api/meta').then((meta) => setBoot({ meta, error: null }), (error) => setBoot({ meta: null, error }));
  }, []);
  useEffect(load, [load]);

  if (boot.error) {
    return (
      <main className="page page-center">
        <EmptyState title="No se pudo conectar con el servidor del panel" icon="alert">
          <p>{boot.error.message} ¿Está corriendo <Cmd>npm run panel</Cmd>?</p>
          <button type="button" className="button" onClick={load}>Reintentar</button>
        </EmptyState>
      </main>
    );
  }
  if (!boot.meta) return <main className="page page-center"><Loading label="Conectando con el panel…" /></main>;

  return (
    <LiveProvider instanceId={boot.meta.panel?.instanceId}>
      <Dashboard initialMeta={boot.meta} />
    </LiveProvider>
  );
}

/** Pestaña actual desde la URL (#/bot, #/backtests): sobrevive a una recarga. */
const tabFromHash = () => (globalThis.location?.hash === '#/backtests' ? 'backtests' : 'bot');

function readStoredScope() {
  try {
    return parseScopeKey(globalThis.localStorage?.getItem(SCOPE_KEY));
  } catch {
    return null;
  }
}

function Dashboard({ initialMeta }) {
  const live = useLive();
  const metaQuery = useApi('/api/meta');
  const meta = metaQuery.data ?? initialMeta;

  const [tab, setTab] = useState(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Ámbito: el último elegido en este navegador; si no, el del servidor (último estado del bot o el .env).
  const [scope, setScope] = useState(() => readStoredScope() ?? meta.defaultScope);
  const chooseScope = (next) => {
    if (!next) return;
    setScope(next);
    try {
      globalThis.localStorage?.setItem(SCOPE_KEY, scopeKey(next));
    } catch {
      // sin almacenamiento: vale hasta recargar
    }
  };

  const [theme, setTheme] = useState(loadTheme);
  const chooseTheme = (next) => {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  };

  const killSwitch = live.killSwitch ?? meta.killSwitch;
  const database = meta.database;

  return (
    <>
      <Header
        tab={tab}
        onTab={setTab}
        scope={scope}
        scopes={meta.scopes}
        onScope={chooseScope}
        connection={live.connection}
        theme={theme}
        onTheme={chooseTheme}
        killSwitch={killSwitch}
        restarted={live.restarted}
        onKillActivated={(result) => live.setKillSwitch({ active: true, reason: result.reason, createdAt: new Date().toISOString() })}
      />
      <main className="page">
        <div className="banners">
          {killSwitch?.active ? (
            <Banner tone="danger" title="Kill switch ACTIVO: el bot no opera en ningún entorno.">
              Motivo: {killSwitch.reason ?? '—'}{killSwitch.createdAt ? ` (desde ${dateTime(killSwitch.createdAt)})` : ''}.{' '}
              Para reanudar, revisa la causa y usa <Cmd>npm run resume</Cmd> en la terminal: el panel no puede reanudar.
            </Banner>
          ) : null}
          {live.restarted ? (
            <Banner tone="warn" title="El servidor del panel se reinició." action={<button type="button" className="button" onClick={() => window.location.reload()}>Recargar</button>}>
              Recarga la página para seguir usando el kill switch (el token de esta página ya no es válido).
            </Banner>
          ) : null}
          {live.connection === 'reconnecting' ? (
            <Banner tone="warn" title="Sin conexión en vivo con el servidor del panel. Reintentando…">
              El bot no se ve afectado. Si cerraste el panel, vuelve a abrirlo con <Cmd>npm run panel</Cmd>.
            </Banner>
          ) : null}
          {database?.state && database.state !== 'ok' ? (
            <Banner tone={database.state === 'missing' ? 'info' : 'warn'} title="Base de datos no disponible">{database.message}</Banner>
          ) : null}
          {meta.config?.warnings?.length ? (
            <Banner tone="warn" title="Advertencias de configuración (.env)">
              <ul className="list">{meta.config.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </Banner>
          ) : null}
        </div>

        {tab === 'bot' ? (
          <div className="grid" key={scopeKey(scope)}>
            <StatusSection scope={scope} />
            <RiskSection scope={scope} />
            <ChartSection scope={scope} />
            <OrdersSection scope={scope} />
            <LogsSection scope={scope} />
          </div>
        ) : (
          <div className="grid">
            <BacktestsSection />
          </div>
        )}
      </main>
      <footer className="page-footer">
        Panel de solo lectura en {meta.panel?.host}:{meta.panel?.port} · única acción: kill switch · base: {database?.path ?? '—'}
      </footer>
    </>
  );
}
