/**
 * Logger con niveles y timestamps (pino).
 *
 * - Consola: formato legible con colores (pino-pretty) si es una terminal.
 * - Archivo: una línea JSON por evento, fácil de filtrar o procesar después.
 * - Los secretos (API key/secret) se reemplazan por [REDACTED] automáticamente.
 * - Con `scope` (entorno + modo), cada línea del archivo lleva "scope":"testnet/dry-run",
 *   para que el panel muestre los logs de un ámbito sin mezclarlos con otros. Se
 *   llama "scope" y no env/mode porque el heartbeat ya registra esos campos y pino
 *   duplicaría las claves. En la consola no se muestra (ya lo dice el heartbeat).
 *
 * En la terminal se escribe a través de process.stdout y no directamente al
 * descriptor 1: en Windows, process.stdout usa la API Unicode de la consola,
 * mientras que escribir bytes crudos hace que la consola los interprete con su
 * página de códigos antigua (850/437) y "Configuración" salga como "Configuraci├│n".
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

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
 * @param {{ level?: string, file?: string, pretty?: boolean, console?: boolean,
 *           stdout?: NodeJS.WritableStream, scope?: { env: string, mode: string } }} [options]
 *        console: false → solo archivo (lo usan los scripts, que muestran su propia salida)
 */
export function createLogger({
  level = 'info',
  file,
  pretty = Boolean(process.stdout.isTTY),
  console: toConsole = true,
  stdout = process.stdout,
  scope,
} = {}) {
  const streams = [];
  if (toConsole) {
    streams.push({
      level,
      stream: pretty
        ? pinoPretty({
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname,scope',
            destination: stdout, // no el descriptor 1: ver el comentario del módulo
          })
        : stdout, // JSON, una línea por evento (p. ej. si la salida se redirige a un archivo)
    });
  }

  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Escritura síncrona: si el proceso muere, lo último registrado ya está en disco.
    streams.push({ level, stream: pino.destination({ dest: file, sync: true }) });
  }

  return pino(
    {
      level,
      base: scope ? { scope: `${scope.env}/${scope.mode}` } : undefined, // sin pid/hostname en cada línea
      timestamp: pino.stdTimeFunctions.isoTime, // "time":"2026-09-28T14:03:00.123Z"
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    pino.multistream(streams),
  );
}
