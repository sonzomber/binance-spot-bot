/**
 * Seguridad del panel. Aunque escucha solo en 127.0.0.1, cualquier página que
 * abras en el navegador puede intentar hablarle a http://127.0.0.1:PUERTO.
 * Capas:
 *
 *   1. Host: solo "127.0.0.1:PUERTO" o "localhost:PUERTO". Frena el "DNS
 *      rebinding" (un dominio ajeno que pasa a apuntar a 127.0.0.1 para que su
 *      página cuente como del mismo origen que el panel).
 *   2. Métodos: todo es GET/HEAD, salvo UNA ruta POST (el kill switch). El resto
 *      recibe 405. No hay CORS: nunca se envía Access-Control-Allow-*, así que
 *      otro origen no puede leer las respuestas ni hacer peticiones "no simples".
 *   3. Kill switch: Origin EXACTO del panel, Sec-Fetch-Site same-origin (si el
 *      navegador lo envía), JSON, y el token local generado al iniciar. El token
 *      solo viaja dentro del HTML del panel, que otro origen no puede leer.
 *   4. Cabeceras: CSP estricta, sin iframes (clickjacking), sin referrer, sin caché en la API.
 */
import crypto from 'node:crypto';

/** Token local: 32 bytes aleatorios, solo en memoria, nuevo en cada inicio del panel. */
export function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Comparación en tiempo constante (sobre hashes: longitudes distintas no se filtran). */
export function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || given.length === 0) return false;
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

export const allowedHosts = (port) => [`127.0.0.1:${port}`, `localhost:${port}`];
export const allowedOrigins = (port) => allowedHosts(port).map((host) => `http://${host}`);

/** Cabeceras de seguridad en TODAS las respuestas. */
export function securityHeaders({ dev = false } = {}) {
  const csp = [
    "default-src 'self'",
    // En desarrollo, Vite inyecta estilos y un script de recarga en línea.
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/** Rechaza toda petición cuyo Host no sea el del panel (anti DNS rebinding). */
export function hostGuard(getPort) {
  return (req, res, next) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts(getPort()).includes(host)) {
      res.status(421).type('text/plain').send('Host no permitido: el panel solo responde en 127.0.0.1 o localhost.');
      return;
    }
    next();
  };
}

/**
 * Solo lectura: GET y HEAD en cualquier ruta; POST únicamente en las rutas de
 * `writeRoutes`. Cualquier otro método (PUT, PATCH, DELETE, OPTIONS…) → 405.
 */
export function methodGuard(writeRoutes) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.method === 'POST' && writeRoutes.includes(req.path)) return next();
    res.setHeader('Allow', writeRoutes.includes(req.path) ? 'POST' : 'GET, HEAD');
    res.status(405).json({ error: 'método no permitido: el panel es de solo lectura' });
  };
}

/**
 * Protección de la única acción (kill switch). Cada condición que falla
 * responde con su motivo y la acción NO se ejecuta.
 */
export function killSwitchGuard({ getPort, token }) {
  return (req, res, next) => {
    const deny = (status, reason) => res.status(status).json({ error: reason });
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins(getPort()).includes(origin)) {
      return deny(403, 'origen no permitido: la acción solo se acepta desde el propio panel');
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      return deny(403, 'la petición no viene del propio panel (Sec-Fetch-Site)');
    }
    if (!req.is('application/json')) {
      return deny(415, 'se requiere Content-Type: application/json');
    }
    if (!tokensMatch(req.headers['x-panel-token'], token)) {
      return deny(403, 'token del panel inválido o ausente');
    }
    next();
  };
}
