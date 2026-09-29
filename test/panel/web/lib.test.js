/**
 * Lógica de la interfaz del panel (sin navegador): formatos, cliente de la API
 * (incluido cómo se envía el kill switch), textos de estados y tema.
 */
import { describe, expect, it, vi } from 'vitest';
import { currentResult } from '../../../panel/web/src/hooks/useApi.js';
import { ApiError, activateKillSwitch, buildUrl, getJson, readToken } from '../../../panel/web/src/lib/api.js';
import { ago, dateTime, number, pct, price, qty, usdt } from '../../../panel/web/src/lib/format.js';
import { ALL_SCOPES, BOT_STATES, botState, parseScopeKey, scopeKey, scopeLabel } from '../../../panel/web/src/lib/labels.js';
import { THEME_KEY, applyTheme, loadTheme, nextTheme, saveTheme } from '../../../panel/web/src/lib/theme.js';

const es = { locale: 'es' };

describe('formatos', () => {
  it('montos en USDT, con signo para el PnL', () => {
    expect(usdt(-1.1675, es)).toBe('-1,17 USDT');
    expect(usdt(18.1655, { ...es, sign: true })).toBe('+18,17 USDT');
    expect(usdt(0, { ...es, sign: true })).toBe('0,00 USDT');
    expect(usdt(-0.6675, { ...es, digits: 4 })).toBe('-0,6675 USDT');
  });

  it('precios, cantidades y porcentajes', () => {
    expect(price(84000.5, es)).toBe('84.000,50');
    expect(qty(0.00059, es)).toBe('0,00059');
    expect(qty(0.123456789, es)).toBe('0,12345679');
    expect(pct(9.1725, es)).toBe('9,17 %');
    expect(pct(13.31, { ...es, sign: true })).toBe('+13,31 %');
    expect(number(3, { ...es, digits: 0 })).toBe('3');
  });

  it('valores ausentes → "—" (nunca "NaN" ni "undefined")', () => {
    for (const fn of [usdt, price, qty, pct, number]) {
      expect(fn(null, es)).toBe('—');
      expect(fn(undefined, es)).toBe('—');
      expect(fn(Number.NaN, es)).toBe('—');
    }
    expect(dateTime(null)).toBe('—');
    expect(dateTime('no es una fecha')).toBe('—');
    expect(ago(null)).toBe('—');
  });

  it('fechas sin ambigüedad: AAAA-MM-DD HH:MM:SS (24 h), en UTC si se pide', () => {
    expect(dateTime('2026-09-29T12:00:30.000Z', { utc: true })).toBe('2026-09-29 12:00:30 UTC');
    expect(dateTime(Date.UTC(2026, 0, 2, 3, 4, 5), { utc: true, seconds: false })).toBe('2026-01-02 03:04 UTC');
    expect(dateTime('2026-09-29T12:00:30.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // hora local
  });

  it('hace cuánto', () => {
    expect(ago(4_600)).toBe('hace 5 s');
    expect(ago(-178)).toBe('hace 0 s'); // relojes apenas desfasados
    expect(ago(-2_000)).toBe('hace 0 s'); // nunca "hace -2 s"
    expect(ago(180_000)).toBe('hace 3 min');
    expect(ago(5 * 3_600_000)).toBe('hace 5 h');
    expect(ago(3 * 86_400_000)).toBe('hace 3 d');
  });
});

describe('cliente de la API', () => {
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

  it('buildUrl omite vacíos y une listas con comas', () => {
    expect(buildUrl('/api/orders', { env: 'testnet', mode: 'dry-run', status: ['filled', 'rejected'], side: null, q: '' }))
      .toBe('/api/orders?env=testnet&mode=dry-run&status=filled%2Crejected');
    expect(buildUrl('/api/meta', {})).toBe('/api/meta');
    expect(buildUrl('/api/orders', { status: [] })).toBe('/api/orders');
  });

  it('getJson: sin caché; un 503 trae el estado de la base; sin conexión → mensaje claro', async () => {
    const fetchImpl = vi.fn(async () => response(503, { error: 'base de datos no disponible', database: { state: 'missing', message: 'Todavía no existe' } }));
    const error = await getJson('/api/status', { env: 'testnet', mode: 'dry-run' }, { fetchImpl }).catch((e) => e);
    expect(fetchImpl).toHaveBeenCalledWith('/api/status?env=testnet&mode=dry-run', expect.objectContaining({ cache: 'no-store' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, database: { state: 'missing' } });

    const offline = await getJson('/api/meta', {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).catch((e) => e);
    expect(offline).toMatchObject({ status: 0, message: 'No hay conexión con el servidor del panel.' });
  });

  it('kill switch: POST a /api/kill-switch con JSON, el token y confirm: true', async () => {
    const fetchImpl = vi.fn(async () => response(200, { ok: true, reason: 'panel: x', halted: 4, warning: null }));
    const result = await activateKillSwitch('  volatilidad  ', { token: 'TOKEN-123', fetchImpl });
    expect(result.halted).toBe(4);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/kill-switch');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Panel-Token': 'TOKEN-123' } });
    expect(JSON.parse(init.body)).toEqual({ confirm: true, reason: 'volatilidad' });
  });

  it('kill switch sin motivo no envía "reason"; sin token no envía nada; un rechazo trae el motivo', async () => {
    const fetchImpl = vi.fn(async () => response(200, { ok: true }));
    await activateKillSwitch('', { token: 't', fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ confirm: true });

    const noToken = vi.fn();
    await expect(activateKillSwitch('x', { token: null, fetchImpl: noToken })).rejects.toThrow(/Falta el token del panel/);
    expect(noToken).not.toHaveBeenCalled();

    const denied = await activateKillSwitch('x', { token: 'viejo', fetchImpl: async () => response(403, { error: 'token del panel inválido o ausente' }) }).catch((e) => e);
    expect(denied).toMatchObject({ status: 403, message: 'token del panel inválido o ausente' });
  });

  it('readToken lee el <meta> que inyecta el servidor', () => {
    const doc = { querySelector: (selector) => (selector === 'meta[name="panel-token"]' ? { getAttribute: () => 'abc' } : null) };
    expect(readToken(doc)).toBe('abc');
    expect(readToken({ querySelector: () => null })).toBeNull();
  });
});

describe('los datos de un ámbito nunca se muestran en otro', () => {
  it('al cambiar de ámbito, los datos anteriores no se muestran mientras llegan los nuevos', () => {
    const testnet = '/api/orders?env=testnet&mode=dry-run';
    const demo = '/api/orders?env=demo&mode=exchange';
    const state = { url: testnet, data: { orders: ['de testnet'] }, error: null };
    expect(currentResult(state, testnet)).toEqual({ data: { orders: ['de testnet'] }, error: null, loading: false });
    expect(currentResult(state, demo)).toEqual({ data: null, error: null, loading: true });
    expect(currentResult({ url: null, data: null, error: null }, null)).toEqual({ data: null, error: null, loading: false });
  });
});

describe('textos de ámbitos y estados', () => {
  it('ámbitos: los 4 de trading, nunca producción', () => {
    expect(ALL_SCOPES.map(scopeKey)).toEqual(['testnet/dry-run', 'testnet/exchange', 'demo/dry-run', 'demo/exchange']);
    expect(scopeLabel({ env: 'testnet', mode: 'dry-run' })).toBe('Spot Testnet · dry-run');
    expect(parseScopeKey('demo/exchange')).toEqual({ env: 'demo', mode: 'exchange' });
    expect(parseScopeKey('production-readonly/dry-run')).toBeNull();
    expect(parseScopeKey(null)).toBeNull();
  });

  it('cada estado del servidor tiene texto y color', () => {
    for (const state of ['never', 'starting', 'running', 'stopping', 'stopped', 'unresponsive']) {
      expect(BOT_STATES[state].label).toBeTruthy();
    }
    expect(botState('unresponsive')).toEqual({ label: 'Sin responder', tone: 'danger' });
    expect(botState('desconocido')).toEqual({ label: 'desconocido', tone: 'neutral' });
  });
});

describe('tema', () => {
  const memory = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k), data };
  };

  it('se recuerda la elección; "sistema" no guarda nada; valores raros → sistema', () => {
    const storage = memory();
    expect(loadTheme(storage)).toBe('system');
    saveTheme('dark', storage);
    expect(storage.data.get(THEME_KEY)).toBe('dark');
    expect(loadTheme(storage)).toBe('dark');
    saveTheme('system', storage);
    expect(storage.data.has(THEME_KEY)).toBe(false);
    storage.setItem(THEME_KEY, 'fucsia');
    expect(loadTheme(storage)).toBe('system');
  });

  it('sin almacenamiento disponible (modo privado): no falla', () => {
    const broken = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); }, removeItem() { throw new Error('bloqueado'); } };
    expect(loadTheme(broken)).toBe('system');
    expect(() => saveTheme('dark', broken)).not.toThrow();
  });

  it('applyTheme marca <html data-theme>; "sistema" lo quita; el botón rota sistema → claro → oscuro', () => {
    const root = { dataset: {} };
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('system', root);
    expect(root.dataset.theme).toBeUndefined();
    expect([nextTheme('system'), nextTheme('light'), nextTheme('dark')]).toEqual(['light', 'dark', 'system']);
  });
});
