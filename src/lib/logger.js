/**
 * Logger con niveles y timestamps (pino).
 *
 * - Consola: formato legible con colores (pino-pretty) si es una terminal.
 * - Archivo: una línea JSON por evento, fácil de filtrar o procesar después.
 * - Los secretos (API key/secret) se reemplazan por [REDACTED] automáticamente.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const REDACT_PATHS = [
  'apiKey',
  'apiSecret',
  'secret',
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  'headers["X-MBX-APIKEY"]',
  '*.headers["X-MBX-APIKEY"]',
];

/**
 * @param {{ level?: string, file?: string, pretty?: boolean, console?: boolean }} [options]
 *        console: false → solo archivo (lo usan los scripts, que muestran su propia salida)
 */
export function createLogger({
  level = 'info',
  file,
  pretty = Boolean(process.stdout.isTTY),
  console: toConsole = true,
} = {}) {
  const targets = [];
  if (toConsole) {
    targets.push(
      pretty
        ? {
            target: 'pino-pretty',
            level,
            options: {
              colorize: true,
              translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          }
        : { target: 'pino/file', level, options: { destination: 1 } }, // 1 = stdout
    );
  }

  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    targets.push({ target: 'pino/file', level, options: { destination: file } });
  }

  return pino(
    {
      level,
      base: undefined, // sin pid/hostname en cada línea
      timestamp: pino.stdTimeFunctions.isoTime, // "time":"2026-09-28T14:03:00.123Z"
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    pino.transport({ targets }),
  );
}
