/**
 * Rotación de logs por tamaño: si un archivo pasa de `maxBytes`, se guarda una
 * copia (bot.log → bot.1.log; las anteriores pasan a .2, .3…) y se vacía. Se
 * conservan `keep` copias.
 *
 * Se COPIA y se VACÍA en vez de renombrar: el bot (pino) y pm2 tienen el archivo
 * abierto en modo "agregar al final" y siguen escribiendo en el mismo archivo;
 * tras vaciarlo, lo nuevo se escribe desde el principio. Si se renombrara, en
 * Windows seguirían escribiendo en la copia renombrada. El panel ya lo soporta:
 * si el archivo se achica, lo vuelve a leer desde el principio.
 *
 * Limitación: lo que se escriba en los milisegundos entre copiar y vaciar se pierde.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ROTATION = Object.freeze({
  maxBytes: 10 * 1024 * 1024, // 10 MB
  keep: 5,
  intervalMs: 5 * 60_000, // cada 5 minutos
});

/** Nombre de la copia n: bot.log → bot.1.log (conserva la extensión para abrirla con doble clic). */
export function rotatedName(file, n) {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.${n}${ext}`;
}

/**
 * @param {string} file
 * @param {{ maxBytes: number, keep: number }} options
 * @returns {{ file: string, bytes: number } | null} null si no hizo falta rotar (o no existe)
 */
export function rotateIfNeeded(file, { maxBytes, keep }) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size < maxBytes) return null;
  // .keep-1 → .keep, …, .1 → .2 (renombrar reemplaza la copia más vieja: se conservan `keep`)
  for (let n = keep - 1; n >= 1; n--) {
    const from = rotatedName(file, n);
    if (fs.existsSync(from)) fs.renameSync(from, rotatedName(file, n + 1));
  }
  fs.copyFileSync(file, rotatedName(file, 1));
  fs.truncateSync(file, 0);
  return { file, bytes: size };
}

/**
 * Archivos a rotar: el log del bot (LOG_FILE), el del lanzador, los de pm2 de
 * cada proceso (bot.out.log, bot.err.log…) y el del daemon de pm2.
 * @param {{ logFile: string, launcherLog: string, pm2LogDir: string, pm2Home: string }} paths
 */
export function logFilesToRotate({ logFile, launcherLog, pm2LogDir, pm2Home }) {
  const files = [logFile, launcherLog, path.join(pm2Home, 'pm2.log')];
  let names = [];
  try {
    names = fs.readdirSync(pm2LogDir);
  } catch {
    // la carpeta todavía no existe
  }
  for (const name of names.toSorted()) {
    if (/^[a-z]+\.(out|err)\.log$/.test(name)) files.push(path.join(pm2LogDir, name)); // no las copias (bot.out.1.log)
  }
  return files;
}

/**
 * Rota todo lo que haga falta. Un archivo que falle no impide rotar los demás.
 * @returns {{ rotated: Array<{ file: string, bytes: number }>, errors: Array<{ file: string, message: string }> }}
 */
export function rotateAll(files, options = ROTATION) {
  const rotated = [];
  const errors = [];
  for (const file of files) {
    try {
      const result = rotateIfNeeded(file, options);
      if (result) rotated.push(result);
    } catch (err) {
      errors.push({ file, message: err.message });
    }
  }
  return { rotated, errors };
}
