/**
 * Kill switch manual basado en un archivo.
 *
 * Si el archivo (por defecto ./STOP) existe, el bot debe detenerse de forma
 * segura. Se usa un archivo porque funciona igual en Windows, macOS y Linux,
 * no requiere que el bot tenga una consola abierta y se puede crear a mano o
 * con `npm run kill`. Reanudar requiere `npm run resume`.
 */
import fs from 'node:fs';
import path from 'node:path';

export class KillSwitch {
  /** @param {string} file ruta absoluta del archivo de parada */
  constructor(file) {
    this.file = file;
  }

  isActive() {
    return fs.existsSync(this.file);
  }

  /**
   * Lee el motivo guardado en el archivo. Tolera archivos vacíos o creados a
   * mano (p. ej. con `type nul > STOP`): lo que importa es que exista.
   * @returns {{ reason: string, createdAt?: string } | null}
   */
  read() {
    if (!this.isActive()) return null;
    let content = '';
    try {
      content = fs.readFileSync(this.file, 'utf8').trim();
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.reason === 'string') return parsed;
    } catch {
      // contenido no JSON: se usa como texto
    }
    return { reason: content || 'archivo de kill switch presente' };
  }

  activate(reason = 'kill switch manual', now = Date.now()) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = { reason, createdAt: new Date(now).toISOString(), pid: process.pid };
    fs.writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  clear() {
    fs.rmSync(this.file, { force: true });
  }

  /**
   * Revisa el archivo cada `intervalMs` y llama a onActivate UNA vez al detectarlo.
   * @returns {() => void} función para dejar de vigilar
   */
  watch(onActivate, { intervalMs = 1000 } = {}) {
    let fired = false;
    const timer = setInterval(() => {
      if (fired || !this.isActive()) return;
      fired = true;
      clearInterval(timer);
      onActivate(this.read());
    }, intervalMs);
    timer.unref?.(); // no mantiene vivo el proceso por sí solo
    return () => clearInterval(timer);
  }
}
