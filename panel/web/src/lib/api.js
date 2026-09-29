/**
 * Cliente de la API del panel (mismo origen).
 *
 * Las lecturas son GET. La única escritura es el kill switch: lleva el token
 * local que el servidor inyectó en el HTML (<meta name="panel-token">) y el
 * navegador agrega por su cuenta Origin y Sec-Fetch-Site, que el servidor exige.
 */

export class ApiError extends Error {
  /**
   * @param {number} status código HTTP (0 si no hubo respuesta)
   * @param {object|null} body cuerpo JSON de la respuesta
   */
  constructor(status, body, message) {
    super(message ?? body?.error ?? `error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    /** Si la base no está disponible (503), su estado y el motivo. */
    this.database = body?.database ?? null;
  }
}

/** Token local del panel, inyectado por el servidor en el HTML. */
export function readToken(doc = globalThis.document) {
  return doc?.querySelector('meta[name="panel-token"]')?.getAttribute('content') || null;
}

/** "/api/orders" + { env: 'testnet', status: ['filled'], q: null } → "/api/orders?env=testnet&status=filled" */
export function buildUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) query.set(key, value.join(','));
    } else {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

async function parse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** GET a la API. @throws {ApiError} */
export async function getJson(path, params, { fetchImpl = globalThis.fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(buildUrl(path, params), { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, null, 'No hay conexión con el servidor del panel.');
  }
  const body = await parse(response);
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

/**
 * La única acción del panel: activar el kill switch.
 * @param {string} reason motivo opcional (hasta 200 caracteres)
 * @returns {Promise<{ ok: true, reason: string, halted: number|null, warning: string|null }>}
 * @throws {ApiError}
 */
export async function activateKillSwitch(reason, { token = readToken(), fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new ApiError(0, null, 'Falta el token del panel: recarga la página.');
  const body = { confirm: true };
  const text = reason?.trim();
  if (text) body.reason = text;
  let response;
  try {
    response = await fetchImpl('/api/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Token': token, Accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, null, 'No hay conexión con el servidor del panel: usa "npm run kill" en una terminal.');
  }
  const result = await parse(response);
  if (!response.ok) throw new ApiError(response.status, result);
  return result;
}
