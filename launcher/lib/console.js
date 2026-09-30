/**
 * Consola del lanzador: mensajes, "escribe X para confirmar" y pausas.
 *
 * Solo usa módulos de Node (ninguna dependencia): cli.js lo carga ANTES de
 * verificar que exista node_modules, para poder avisar que falta `npm install`.
 *
 * Los mensajes usan palabras (OK, AVISO, ERROR) y no símbolos: la consola
 * clásica de Windows no tiene glifos para ✔ o ✖ y mostraría cuadrados.
 */
import readline from 'node:readline';

const ANSI = { bold: '1', green: '32', yellow: '33', red: '31', cyan: '36', dim: '2' };

/**
 * Compara lo escrito con la palabra pedida sin importar mayúsculas, tildes ni
 * espacios alrededor: "sí", "Si" y " SI " confirman "SI".
 */
export function matchesWord(answer, word) {
  const normalize = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toUpperCase();
  return normalize(answer) === normalize(word);
}

/**
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, color?: boolean }} [options]
 */
export function createConsoleUi({ stdin = process.stdin, stdout = process.stdout, color = Boolean(stdout.isTTY) } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const write = (text = '') => stdout.write(`${text}\n`);
  const interactive = Boolean(stdin.isTTY);

  /** Lee una línea. Sin terminal interactiva (p. ej. stdin cerrado) devuelve ''. */
  const ask = (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: interactive });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => { if (!answered) resolve(''); });
  });

  /** Espera una tecla (en modo crudo, sin Enter). Sin terminal interactiva, no espera. */
  const waitKey = (message = 'Presiona una tecla para cerrar esta ventana.') => {
    if (!interactive) return Promise.resolve();
    write();
    stdout.write(paint(ANSI.dim, message));
    return new Promise((resolve) => {
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.once('data', () => {
        stdin.setRawMode?.(false);
        stdin.pause();
        write();
        resolve();
      });
    });
  };

  return {
    interactive,
    line: write,
    title: (text) => { write(); write(paint(ANSI.bold, text)); write(paint(ANSI.dim, '─'.repeat(Math.min(60, text.length + 10)))); },
    section: (text) => { write(); write(paint(ANSI.cyan, text)); },
    info: (text) => write(text),
    detail: (text) => write(paint(ANSI.dim, text)),
    ok: (text) => write(`${paint(ANSI.green, 'OK')}     ${text}`),
    warn: (text) => write(`${paint(ANSI.yellow, 'AVISO')}  ${text}`),
    error: (text) => write(`${paint(ANSI.red, 'ERROR')}  ${text}`),
    ask,
    /**
     * Pide escribir una palabra exacta para confirmar una acción.
     * @returns {Promise<boolean>} true solo si escribió la palabra
     */
    async confirm({ word, prompt = `Escribe ${word} y presiona Enter para confirmar (cualquier otra cosa cancela): ` }) {
      write();
      return matchesWord(await ask(paint(ANSI.bold, prompt)), word);
    },
    waitKey,
    /** Cuenta regresiva para cerrar (una tecla la corta). Sin terminal interactiva, no espera. */
    closeIn(seconds) {
      if (!interactive) return Promise.resolve();
      write();
      return new Promise((resolve) => {
        let left = seconds;
        const show = () => stdout.write(`\r${paint(ANSI.dim, `Esta ventana se cierra en ${left} s (o presiona una tecla).`)}`);
        const finish = () => {
          clearInterval(timer);
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', finish);
          write();
          resolve();
        };
        show();
        const timer = setInterval(() => {
          left--;
          if (left <= 0) finish();
          else show();
        }, 1000);
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.once('data', finish);
      });
    },
  };
}
