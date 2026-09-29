/**
 * La aplicación del panel (Express). Toda la superficie HTTP está en ROUTES:
 * lecturas GET y UNA sola acción POST, el kill switch. Una prueba compara esta
 * lista con las rutas realmente registradas en Express.
 *
 * Orden de las capas (ver security.js): cabeceras → Host → métodos → rutas.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { activateKillSwitch } from '../../src/risk/kill-command.js';
import { ScopeError, tradingScope } from '../../src/storage/scope.js';
import { displayPath } from './config.js';
import { DatabaseUnavailableError } from './database.js';
import { LEVEL_GROUPS, createLogFilter, readRecentLogs } from './log-reader.js';
import { backtestDetail, listBacktests } from './queries/backtests.js';
import { MAX_CANDLES, candleChart, chartTarget, loadStrategy } from './queries/candles.js';
import { MAX_PAGE, ORDER_SIDES, ORDER_STATUSES, listOrders } from './queries/orders.js';
import { riskSummary } from './queries/risk.js';
import { botStatus, listScopes } from './queries/status.js';
import { hostGuard, killSwitchGuard, methodGuard, securityHeaders } from './security.js';

/** Toda la API. La única ruta que no es GET es el kill switch. */
export const ROUTES = Object.freeze([
  { method: 'GET', path: '/api/meta' },
  { method: 'GET', path: '/api/status' },
  { method: 'GET', path: '/api/risk' },
  { method: 'GET', path: '/api/candles' },
  { method: 'GET', path: '/api/orders' },
  { method: 'GET', path: '/api/logs' },
  { method: 'GET', path: '/api/backtests' },
  { method: 'GET', path: '/api/backtests/:id' },
  { method: 'GET', path: '/api/live' },
  { method: 'POST', path: '/api/kill-switch' },
]);
export const WRITE_ROUTES = Object.freeze(ROUTES.filter((r) => r.method !== 'GET').map((r) => r.path));

export const MAX_REASON_LENGTH = 200;

class BadRequestError extends Error {}

/** Parámetro de texto simple (rechaza listas: ?a=1&a=2). */
function textParam(req, name) {
  const value = req.query[name];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestError(`${name} debe aparecer una sola vez`);
  return value;
}

function intParam(req, name, { fallback, min, max }) {
  const raw = textParam(req, name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new BadRequestError(`${name} debe ser un entero`);
  const value = Number(raw);
  if (value < min || value > max) throw new BadRequestError(`${name} debe estar entre ${min} y ${max}`);
  return value;
}

/** Lista separada por comas, cada valor dentro de `allowed`. */
function listParam(req, name, allowed) {
  const raw = textParam(req, name);
  if (raw === null) return [];
  const values = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
  const invalid = values.filter((v) => !allowed.includes(v));
  if (invalid.length) throw new BadRequestError(`${name} inválido: ${invalid.join(', ')} (permitidos: ${allowed.join(', ')})`);
  return values;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./config.js').loadPanelConfig>} deps.config
 * @param {import('./database.js').PanelDatabase} deps.database
 * @param {import('../../src/risk/kill-switch.js').KillSwitch} deps.killSwitch
 * @param {import('./live.js').LiveHub} deps.hub
 * @param {string} deps.token token local para el kill switch
 * @param {string} [deps.instanceId] identificador público de esta ejecución del panel
 * @param {() => number} deps.getPort puerto real en el que escucha (para Host y Origin)
 * @param {import('pino').Logger} deps.logger
 * @param {string} deps.webRoot carpeta del frontend (panel/web)
 * @param {() => number} [deps.now]
 * @param {typeof activateKillSwitch} [deps.activateKill] inyectable en pruebas
 */
export function createPanelApp({
  config, database, killSwitch, hub, token, instanceId = null, getPort, logger, webRoot, now = Date.now,
  activateKill = activateKillSwitch,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('query parser', 'simple');

  app.use(securityHeaders());
  app.use(hostGuard(getPort));
  app.use(methodGuard(WRITE_ROUTES));

  /** Ámbito pedido (?env=&mode=) o, si no se indica, el que corresponde por defecto. */
  const scopeOf = (req, db) => {
    const env = textParam(req, 'env');
    const mode = textParam(req, 'mode');
    if (env === null && mode === null) return listScopes(db, config).defaultScope;
    return tradingScope({ env, mode });
  };

  // --- Lecturas ---------------------------------------------------------------------

  app.get('/api/meta', (req, res) => {
    const status = database.status();
    const scopes = status.state === 'ok'
      ? database.read((db) => listScopes(db, config))
      : { scopes: [], defaultScope: config.defaultScope };
    const file = killSwitch.read();
    res.json({
      panel: { readOnly: true, instanceId, host: config.host, port: getPort(), serverTime: new Date(now()).toISOString() },
      database: status,
      ...scopes,
      killSwitch: { active: Boolean(file), reason: file?.reason ?? null, createdAt: file?.createdAt ?? null },
      // Solo valores públicos (lista blanca de config.js): nunca API keys.
      config: {
        defaultScope: config.defaultScope,
        symbol: config.symbol,
        timeframe: config.timeframe,
        strategy: config.strategy,
        limits: config.limits,
        feeRate: config.feeRate,
        slippageBps: config.slippageBps,
        heartbeatMs: config.heartbeatMs,
        dataStaleAfterMs: config.dataStaleAfterMs,
        envFileFound: config.envFileFound,
        warnings: config.warnings,
        paths: { db: displayPath(config.dbPath), log: displayPath(config.logFile), killSwitch: displayPath(config.killSwitchFile) },
      },
      resumeHint: 'Para reanudar, usa "npm run resume" en la terminal (el panel no puede reanudar el bot).',
    });
  });

  app.get('/api/status', (req, res) => {
    res.json(database.read((db) => botStatus(db, scopeOf(req, db), { killSwitch, now: now() })));
  });

  app.get('/api/risk', (req, res) => {
    res.json(database.read((db) => riskSummary(db, scopeOf(req, db), { config, now: now() })));
  });

  app.get('/api/candles', async (req, res) => {
    const limit = intParam(req, 'limit', { fallback: 300, min: 10, max: MAX_CANDLES });
    const { scope, target } = database.read((db) => {
      const s = scopeOf(req, db);
      return { scope: s, target: chartTarget(db, s, { config }) };
    });
    const { strategy, error } = await loadStrategy(target.strategy); // asíncrono: fuera de la transacción
    res.json(database.read((db) => candleChart(db, scope, { target, strategy, strategyError: error, limit })));
  });

  app.get('/api/orders', (req, res) => {
    const sides = listParam(req, 'side', ORDER_SIDES);
    const filters = {
      statuses: listParam(req, 'status', ORDER_STATUSES),
      side: sides.length === 1 ? sides[0] : null, // los dos lados = sin filtro
      q: textParam(req, 'q'),
      limit: intParam(req, 'limit', { fallback: 50, min: 1, max: MAX_PAGE }),
      offset: intParam(req, 'offset', { fallback: 0, min: 0, max: 1_000_000 }),
    };
    if (filters.q && filters.q.length > 64) throw new BadRequestError('q admite hasta 64 caracteres');
    res.json(database.read((db) => listOrders(db, scopeOf(req, db), filters)));
  });

  app.get('/api/logs', (req, res) => {
    const levels = listParam(req, 'levels', Object.keys(LEVEL_GROUPS));
    const general = textParam(req, 'general');
    if (general !== null && general !== '0' && general !== '1') throw new BadRequestError('general debe ser 0 o 1');
    // El ámbito sale de la base si está disponible; si no, del pedido o del .env.
    const scope = database.status().state === 'ok'
      ? database.read((db) => scopeOf(req, db))
      : tradingScope({ env: textParam(req, 'env') ?? config.defaultScope.env, mode: textParam(req, 'mode') ?? config.defaultScope.mode });
    const filter = createLogFilter({ scope, levels: levels.length ? levels : ['info', 'warn', 'error'], includeGeneral: general !== '0' });
    const limit = intParam(req, 'limit', { fallback: 200, min: 1, max: 500 });
    res.json({ scope, file: displayPath(config.logFile), ...readRecentLogs(config.logFile, { filter, limit }) });
  });

  app.get('/api/backtests', (req, res) => {
    const limit = intParam(req, 'limit', { fallback: 50, min: 1, max: 200 });
    res.json(database.read((db) => listBacktests(db, { limit })));
  });

  app.get('/api/backtests/:id', (req, res) => {
    if (!/^\d{1,12}$/.test(req.params.id)) throw new BadRequestError('id inválido');
    const detail = database.read((db) => backtestDetail(db, Number(req.params.id)));
    if (!detail) return res.status(404).json({ error: `no existe el backtest #${req.params.id}` });
    res.json(detail);
  });

  app.get('/api/live', (req, res) => {
    if (req.method === 'HEAD') return res.status(200).end(); // HEAD no abre una conexión en vivo
    if (!hub.addClient(req, res)) res.status(503).json({ error: 'demasiadas conexiones en vivo abiertas' });
  });

  // --- La única acción: kill switch ----------------------------------------------------

  app.post(
    '/api/kill-switch',
    killSwitchGuard({ getPort, token }), // antes de leer el cuerpo: nada de un origen ajeno se procesa
    express.json({ limit: '2kb', strict: true }),
    (req, res) => {
      const { confirm, reason } = req.body ?? {};
      if (confirm !== true) return res.status(400).json({ error: 'falta la confirmación (confirm: true)' });
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
        return res.status(400).json({ error: `el motivo debe ser texto de hasta ${MAX_REASON_LENGTH} caracteres` });
      }
      const text = (reason ?? '').replace(/\s+/g, ' ').trim();
      const fullReason = `panel: ${text || 'kill switch activado desde el panel'}`;
      // El MISMO mecanismo que `npm run kill`: archivo STOP + parada en SQLite de todos los ámbitos.
      const result = activateKill({ killSwitchFile: config.killSwitchFile, dbPath: config.dbPath, reason: fullReason, now: now() });
      logger.warn(
        { reason: fullReason, halted: result.halted, dbError: result.dbError?.message },
        `Kill switch ACTIVADO desde el panel: ${fullReason}`,
      );
      res.json({
        ok: true,
        reason: fullReason,
        halted: result.halted,
        warning: result.dbError
          ? `No se pudo registrar la parada en la base de datos (${result.dbError.message}). El archivo STOP es suficiente.`
          : null,
      });
    },
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'no existe' }));

  // --- Frontend --------------------------------------------------------------------------

  // Siempre la interfaz COMPILADA (panel/web/dist): nunca se sirven los fuentes ni otros archivos del proyecto.
  app.use(express.static(path.join(webRoot, 'dist'), { index: false, dotfiles: 'ignore', redirect: false }));
  // Cualquier otra ruta GET muestra la interfaz (con el token), p. ej. al recargar en #/backtests.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.type('html').setHeader('Cache-Control', 'no-store').send(injectToken(loadIndexHtml(webRoot), token));
  });

  // --- Errores ---------------------------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof DatabaseUnavailableError) return res.status(503).json({ error: 'base de datos no disponible', database: err.status });
    if (err instanceof BadRequestError || err instanceof ScopeError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'cuerpo demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    logger.error({ err }, 'Error en el panel');
    res.status(500).json({ error: 'error interno del panel' });
  });

  return app;
}

/** El token viaja SOLO dentro del HTML del panel (otro origen no puede leerlo). */
export function injectToken(html, token) {
  const meta = `<meta name="panel-token" content="${token}">`;
  return html.includes('<head>') ? html.replace('<head>', `<head>\n    ${meta}`) : `${meta}\n${html}`;
}

/** index.html compilado (se relee en cada pedido: una recompilación se ve al recargar). */
function loadIndexHtml(webRoot) {
  const file = path.join(webRoot, 'dist', 'index.html');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : PLACEHOLDER_HTML;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Panel del bot</title>
  </head>
  <body>
    <main>
      <h1>Panel del bot</h1>
      <p>El servidor del panel está funcionando, pero la interfaz no está compilada.</p>
      <p>Usa <code>npm run panel</code> (compila y arranca) o compílala con <code>npm run panel:build</code> y recarga esta página.</p>
    </main>
  </body>
</html>
`;
