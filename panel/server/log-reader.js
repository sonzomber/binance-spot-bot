/**
 * Logs del bot para el panel: el archivo JSON de pino (una línea por evento).
 *
 *   - Filtro por nivel (info, warn, error; "error" incluye fatal) y por ámbito:
 *     se muestran las líneas del ámbito elegido ("scope": "testnet/dry-run") y,
 *     si se pide, las generales (sin ámbito: scripts, backtest, el panel).
 *   - Secretos: pino ya los reemplaza por [REDACTED] al escribir. Aun así, antes
 *     de enviar una línea al navegador se vuelve a ocultar cualquier campo con
 *     nombre de secreto (defensa en profundidad).
 *   - LogTail sigue el archivo para las actualizaciones en vivo; tolera líneas a
 *     medio escribir y que el archivo se trunque o se reemplace.
 */
import fs from 'node:fs';

export const LEVEL_NAMES = Object.freeze({ 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' });
/** Grupos del filtro: "error" incluye fatal. */
export const LEVEL_GROUPS = Object.freeze({ debug: [10, 20], info: [30], warn: [40], error: [50, 60] });
export const MAX_LINES = 500;
const TAIL_BYTES = 1_000_000;
const MAX_DATA_CHARS = 4000;

const SECRET_KEY = /api[-_]?key|api[-_]?secret|secret|password|signature|x-mbx-apikey|authorization|token/i;

/** Copia del objeto con todo campo de nombre "secreto" reemplazado por [REDACTED]. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(v)]));
}

/** Línea JSON de pino → entrada para el panel (o null si no es una línea válida). */
export function parseLine(text) {
  let line;
  try {
    line = JSON.parse(text);
  } catch {
    return null;
  }
  if (!line || typeof line !== 'object' || typeof line.level !== 'number') return null;
  const { level, time, msg, scope, ...rest } = redact(line);
  let data = Object.keys(rest).length ? rest : null;
  if (data && JSON.stringify(data).length > MAX_DATA_CHARS) data = { truncated: true, keys: Object.keys(rest) };
  return { time: time ?? null, level, levelName: LEVEL_NAMES[level] ?? String(level), msg: msg ?? '', scope: scope ?? null, data };
}

/**
 * @param {{ scope?: { env: string, mode: string }|null, levels?: string[], includeGeneral?: boolean }} filter
 * @returns {(entry: ReturnType<typeof parseLine>) => boolean}
 */
export function createLogFilter({ scope = null, levels = ['info', 'warn', 'error'], includeGeneral = true } = {}) {
  const allowed = new Set(levels.flatMap((name) => LEVEL_GROUPS[name] ?? []));
  const scopeKey = scope ? `${scope.env}/${scope.mode}` : null;
  return (entry) => {
    if (!allowed.has(entry.level)) return false;
    if (!entry.scope) return includeGeneral;
    return scopeKey === null || entry.scope === scopeKey;
  };
}

/**
 * Últimas líneas del log que pasan el filtro (de la más vieja a la más nueva).
 * Lee solo el final del archivo (hasta ~1 MB).
 */
export function readRecentLogs(file, { filter = createLogFilter(), limit = 200 } = {}) {
  if (!fs.existsSync(file)) return { exists: false, lines: [] };
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const rows = text.split('\n');
  if (start > 0) rows.shift(); // la primera puede estar cortada a la mitad
  const lines = rows.map((row) => row.trim()).filter(Boolean).map(parseLine).filter((e) => e && filter(e));
  return { exists: true, lines: lines.slice(-Math.min(limit, MAX_LINES)) };
}

/** Sigue el archivo: cada poll() devuelve las líneas COMPLETAS nuevas desde la anterior. */
export class LogTail {
  constructor(file) {
    this.file = file;
    this.offset = fs.existsSync(file) ? fs.statSync(file).size : 0; // empieza al final: solo lo nuevo
    // Bytes (no texto) de la línea a medio escribir: así un carácter UTF-8 cortado
    // entre dos lecturas se reconstruye bien. Se corta solo en "\n", que nunca
    // aparece dentro de un carácter UTF-8.
    this.partial = Buffer.alloc(0);
  }

  poll() {
    if (!fs.existsSync(this.file)) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      return [];
    }
    const { size } = fs.statSync(this.file);
    if (size < this.offset) { // truncado o reemplazado: se relee desde el principio
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    let chunk;
    try {
      chunk = Buffer.alloc(Math.min(size - this.offset, TAIL_BYTES));
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += chunk.length;
    } finally {
      fs.closeSync(fd);
    }
    const data = Buffer.concat([this.partial, chunk]);
    const end = data.lastIndexOf(0x0a); // último "\n"
    if (end === -1) {
      this.partial = data;
      return [];
    }
    this.partial = data.subarray(end + 1);
    return data.subarray(0, end).toString('utf8').split('\n')
      .map((row) => row.trim()).filter(Boolean).map(parseLine).filter(Boolean);
  }
}
