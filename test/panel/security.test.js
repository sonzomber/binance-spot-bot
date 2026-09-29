/**
 * Seguridad del panel:
 *   - escucha SOLO en 127.0.0.1;
 *   - no existe ningún endpoint de escritura aparte del kill switch (ni por la
 *     lista de rutas, ni por las rutas registradas en Express, ni probando todos
 *     los métodos contra todas las rutas);
 *   - el kill switch exige Origin exacto, token, JSON y confirmación, y funciona
 *     igual que `npm run kill` cuando todo está en regla;
 *   - Host ajeno (DNS rebinding), CORS y cabeceras de seguridad.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, WRITE_ROUTES, createPanelApp } from '../../panel/server/app.js';
import { PANEL_HOST } from '../../panel/server/config.js';
import { tokensMatch } from '../../panel/server/security.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { ALL_TRADING_SCOPES } from '../../src/storage/scope.js';
import { SCOPE, killRequest, request, seedRunningBot, setupPanel } from './support.js';

let ctx;
beforeEach(async () => {
  ctx = await setupPanel({ seed: (c) => seedRunningBot(c) });
});
afterEach(() => ctx.cleanup());

const stopFileExists = () => fs.existsSync(ctx.files.killSwitchFile);
const haltStates = () => ALL_TRADING_SCOPES.map((scope) => new RiskStore(ctx.writer, scope).getHaltState());
const nothingHalted = () => haltStates().every((s) => !s.halted);
const dbHash = () => crypto.createHash('sha256').update(fs.readFileSync(ctx.files.dbPath)).digest('hex');

// ---------------------------------------------------------------------------------
describe('escucha solo en 127.0.0.1', () => {
  it('el servidor está atado a 127.0.0.1 (no a todas las interfaces)', () => {
    expect(ctx.panel.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(PANEL_HOST).toBe('127.0.0.1');
  });

  it('el host no se puede cambiar desde el .env ni desde el entorno', async () => {
    const other = await setupPanel({ env: { PANEL_HOST: '0.0.0.0', HOST: '0.0.0.0' } });
    try {
      expect(other.config.host).toBe('127.0.0.1');
      expect(other.panel.server.address().address).toBe('127.0.0.1');
    } finally {
      await other.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------
describe('no existen endpoints de escritura aparte del kill switch', () => {
  it('la lista de rutas tiene exactamente UNA que no es GET: POST /api/kill-switch', () => {
    expect(ROUTES.filter((r) => r.method !== 'GET')).toEqual([{ method: 'POST', path: '/api/kill-switch' }]);
    expect(WRITE_ROUTES).toEqual(['/api/kill-switch']);
  });

  it('las rutas registradas en Express coinciden exactamente con la lista (nada escondido)', () => {
    const app = createPanelApp({
      config: ctx.config, database: {}, killSwitch: {}, hub: {}, token: 't', getPort: () => 1, logger: ctx.logs.logger, webRoot: ctx.tmp.dir,
    });
    const registered = app.router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods).filter((m) => m !== '_all').map((m) => ({ method: m.toUpperCase(), path: layer.route.path })));
    expect(registered.sort((a, b) => a.path.localeCompare(b.path))).toEqual([...ROUTES].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it('todo método que no sea GET/HEAD, contra CUALQUIER ruta, se rechaza y no cambia nada', async () => {
    const before = dbHash();
    const paths = [
      ...ROUTES.map((r) => r.path.replace(':id', '1')),
      '/', '/index.html', '/api', '/api/orders/1', '/api/config', '/api/resume', '/api/orders/create', '/api/strategy',
      '/api/settings', '/api/kill-switch/../orders', '/api/kill-switch?x=1', '/API/KILL-SWITCH',
    ];
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    for (const url of paths) {
      for (const method of methods) {
        if (method === 'POST' && url.split('?')[0] === '/api/kill-switch') continue; // la única acción (probada aparte)
        const res = await request(ctx.port, { method, path: url, headers: { 'content-type': 'application/json', origin: ctx.origin }, body: { confirm: true } });
        // 405 exacto: el filtro de métodos corre ANTES que las rutas (un 404 querría decir que lo pasó)
        expect(res.status, `${method} ${url}`).toBe(405);
        expect(res.headers['access-control-allow-origin'], `${method} ${url}`).toBeUndefined();
      }
    }
    expect(stopFileExists()).toBe(false);
    expect(nothingHalted()).toBe(true);
    expect(dbHash()).toBe(before);
  });

  it('no hay rutas para reanudar, crear órdenes ni cambiar la configuración', async () => {
    for (const url of ['/api/resume', '/api/orders/create', '/api/config', '/api/settings', '/api/strategy']) {
      expect((await ctx.get(url)).status, url).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------------
describe('protección del kill switch (cada condición es obligatoria)', () => {
  const cases = [
    ['sin Origin', { omit: ['origin'] }, 403, /origen no permitido/],
    ['Origin de otra página', { headers: { origin: 'https://pagina-maliciosa.example' } }, 403, /origen no permitido/],
    ['Origin "null" (iframe con sandbox, archivo local)', { headers: { origin: 'null' } }, 403, /origen no permitido/],
    ['Origin de otro puerto local', { headers: { origin: 'http://127.0.0.1:1' } }, 403, /origen no permitido/],
    ['Origin https del mismo host', { headers: { origin: 'https://127.0.0.1' } }, 403, /origen no permitido/],
    ['Sec-Fetch-Site cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403, /Sec-Fetch-Site/],
    ['Sec-Fetch-Site same-site', { headers: { 'sec-fetch-site': 'same-site' } }, 403, /Sec-Fetch-Site/],
    ['sin token', { omit: ['x-panel-token'] }, 403, /token/],
    ['token incorrecto', { headers: { 'x-panel-token': 'x'.repeat(43) } }, 403, /token/],
    ['token vacío', { headers: { 'x-panel-token': '' } }, 403, /token/],
    ['formulario (text/plain: petición "simple" que no pide permiso CORS)', { headers: { 'content-type': 'text/plain' } }, 415, /application\/json/],
    ['formulario urlencoded', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=true' }, 415, /application\/json/],
    ['sin confirmación', { body: { reason: 'x' } }, 400, /confirmación/],
    ['confirmación como texto', { body: { confirm: 'true' } }, 400, /confirmación/],
    ['motivo demasiado largo', { body: { confirm: true, reason: 'x'.repeat(201) } }, 400, /200 caracteres/],
    ['JSON inválido', { body: '{"confirm": tru' }, 400, /JSON inválido/],
    ['cuerpo enorme', { body: { confirm: true, reason: 'x'.repeat(5000) } }, 413, /demasiado grande/],
  ];

  for (const [name, options, status, message] of cases) {
    it(`${name} → ${status}, y NO se activa`, async () => {
      const res = await killRequest(ctx, options);
      expect(res.status).toBe(status);
      expect(res.json.error).toMatch(message);
      expect(stopFileExists()).toBe(false);
      expect(nothingHalted()).toBe(true);
    });
  }

  it('Host ajeno (DNS rebinding) → 421, aunque traiga el token correcto', async () => {
    const res = await killRequest(ctx, { headers: { host: 'pagina-maliciosa.example', origin: 'http://pagina-maliciosa.example' } });
    expect(res.status).toBe(421);
    expect(stopFileExists()).toBe(false);
  });

  it('todo en regla → mismo efecto que `npm run kill`: archivo STOP y parada en TODOS los ámbitos', async () => {
    const res = await killRequest(ctx, { body: { confirm: true, reason: '  volatilidad   extrema ' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, reason: 'panel: volatilidad extrema', halted: 4, warning: null });
    expect(new KillSwitch(ctx.files.killSwitchFile).read()).toMatchObject({ reason: 'panel: volatilidad extrema' });
    for (const state of haltStates()) {
      expect(state).toMatchObject({ halted: true, code: 'KILL_SWITCH', reason: 'kill switch: panel: volatilidad extrema' });
    }
    // Queda registrado en el log del panel
    expect(ctx.logs.messages()).toContain('Kill switch ACTIVADO desde el panel: panel: volatilidad extrema');
  });

  it('también desde http://localhost:PUERTO (el otro nombre permitido del panel)', async () => {
    const res = await killRequest(ctx, { headers: { host: `localhost:${ctx.port}`, origin: `http://localhost:${ctx.port}` }, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(res.json.reason).toBe('panel: kill switch activado desde el panel');
    expect(stopFileExists()).toBe(true);
  });

  it('sin Sec-Fetch-Site (clientes que no son navegadores) alcanza con Origin + token', async () => {
    const res = await killRequest(ctx, { omit: ['sec-fetch-site'] });
    expect(res.status).toBe(200);
  });

  it('el token es único por inicio del panel y solo viaja dentro del HTML', async () => {
    const other = await setupPanel();
    try {
      expect(other.panel.token).not.toBe(ctx.panel.token);
      expect(ctx.panel.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes aleatorios
    } finally {
      await other.cleanup();
    }
    const html = await ctx.get('/');
    expect(html.text).toContain(`<meta name="panel-token" content="${ctx.panel.token}">`);
    for (const url of ['/api/meta', `/api/status?env=${SCOPE.env}&mode=${SCOPE.mode}`, '/api/risk', '/api/orders', '/api/logs', '/api/backtests', '/api/candles']) {
      expect((await ctx.get(url)).text, url).not.toContain(ctx.panel.token);
    }
  });

  it('tokensMatch: compara en tiempo constante y rechaza vacíos, tipos raros y longitudes distintas', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abd', 'abc')).toBe(false);
    expect(tokensMatch('abcd', 'abc')).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
    expect(tokensMatch(undefined, 'abc')).toBe(false);
    expect(tokensMatch(['abc'], 'abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
describe('Host, CORS y cabeceras', () => {
  it('Host ajeno → 421 en cualquier ruta (también lecturas y el HTML)', async () => {
    for (const url of ['/', '/api/meta', '/api/orders', '/api/live']) {
      const res = await request(ctx.port, { path: url, headers: { host: 'atacante.example:8787' } });
      expect(res.status, url).toBe(421);
    }
  });

  it('acepta 127.0.0.1:PUERTO y localhost:PUERTO, y nada más (ni otro puerto)', async () => {
    expect((await request(ctx.port, { path: '/api/meta', headers: { host: `localhost:${ctx.port}` } })).status).toBe(200);
    expect((await request(ctx.port, { path: '/api/meta', headers: { host: `127.0.0.1:${ctx.port}` } })).status).toBe(200);
    expect((await request(ctx.port, { path: '/api/meta', headers: { host: '127.0.0.1' } })).status).toBe(421);
    expect((await request(ctx.port, { path: '/api/meta', headers: { host: `127.0.0.1:${ctx.port + 1}` } })).status).toBe(421);
  });

  it('una lectura desde otro origen no recibe permiso CORS (el navegador no le deja leerla)', async () => {
    const res = await request(ctx.port, { path: '/api/orders', headers: { origin: 'https://pagina-maliciosa.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('cabeceras de seguridad: sin iframes, CSP estricta, nosniff, sin referrer, API sin caché', async () => {
    const html = await ctx.get('/');
    expect(html.headers['x-frame-options']).toBe('DENY');
    expect(html.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(html.headers['content-security-policy']).toMatch(/script-src 'self'(;|$)/);
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect(html.headers['x-powered-by']).toBeUndefined();
    const api = await ctx.get('/api/meta');
    expect(api.headers['cache-control']).toBe('no-store');
  });
});
