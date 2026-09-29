/**
 * Formatos de números, montos y fechas para el panel.
 *
 * Números: con la configuración regional del navegador si está en español
 * (si no, "es"). Fechas: siempre "AAAA-MM-DD HH:MM:SS" de 24 h, sin ambigüedad
 * entre países; en hora local, salvo que se pida UTC (el día de la pérdida
 * diaria es en UTC).
 */
const browserLocale = typeof navigator !== 'undefined' ? navigator.language : undefined;
export const LOCALE = browserLocale?.toLowerCase().startsWith('es') ? browserLocale : 'es';

const formatters = new Map();
function numberFormat(locale, min, max, extra = {}) {
  const key = `${locale}|${min}|${max}|${JSON.stringify(extra)}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max, ...extra }));
  }
  return formatters.get(key);
}

const missing = (n) => n === null || n === undefined || Number.isNaN(n);

/** Número con decimales fijos. */
export function number(n, { digits = 2, min = digits, locale = LOCALE } = {}) {
  return missing(n) ? '—' : numberFormat(locale, min, digits).format(n);
}

/** Monto en USDT. sign: true muestra "+" en los positivos (para PnL). */
export function usdt(n, { digits = 2, sign = false, locale = LOCALE } = {}) {
  if (missing(n)) return '—';
  const text = numberFormat(locale, digits, digits, sign ? { signDisplay: 'exceptZero' } : {}).format(n);
  return `${text} USDT`;
}

/** Precio (2 decimales, con separador de miles). */
export const price = (n, options) => number(n, { digits: 2, ...options });

/** Cantidad del activo base: hasta 8 decimales, sin ceros de más. */
export const qty = (n, { locale = LOCALE } = {}) => (missing(n) ? '—' : numberFormat(locale, 0, 8).format(n));

/** Porcentaje: 9.1725 → "9,17 %". */
export function pct(n, { digits = 2, sign = false, locale = LOCALE } = {}) {
  if (missing(n)) return '—';
  return `${numberFormat(locale, digits, digits, sign ? { signDisplay: 'exceptZero' } : {}).format(n)} %`;
}

const pad = (n) => String(n).padStart(2, '0');

/** "2026-09-29 12:00:30" en hora local (o UTC con { utc: true }). */
export function dateTime(value, { utc = false, seconds = true } = {}) {
  if (value === null || value === undefined) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const [y, mo, da, h, mi, s] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  return `${y}-${pad(mo)}-${pad(da)} ${pad(h)}:${pad(mi)}${seconds ? `:${pad(s)}` : ''}${utc ? ' UTC' : ''}`;
}

/** Solo la hora local: "12:00:30". */
export const time = (value) => (value === null || value === undefined ? '—' : dateTime(value).slice(11));

/** Hace cuánto: 5 000 → "hace 5 s"; 180 000 → "hace 3 min". */
export function ago(ms) {
  if (missing(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `hace ${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}
