import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';
import { tempDir } from '../helpers.js';

/** Stream que junta lo escrito (hace de process.stdout). */
function fakeStdout() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

let tmp;
beforeEach(async () => { tmp = await tempDir(); });
afterEach(() => tmp.cleanup());

describe('createLogger', () => {
  it('en la terminal escribe POR process.stdout (no bytes crudos al descriptor 1), con acentos intactos', () => {
    const out = fakeStdout();
    const logger = createLogger({ pretty: true, stdout: out.stream });
    logger.fatal('El bot no arranca. Configuración inválida: la señal ñandú');
    expect(out.text()).toMatch(/Configuración inválida: la señal ñandú/);
    expect(out.text()).toMatch(/FATAL/);
  });

  it('fuera de una terminal escribe JSON, una línea por evento', () => {
    const out = fakeStdout();
    createLogger({ pretty: false, stdout: out.stream }).info({ n: 1 }, 'Configuración cargada');
    expect(JSON.parse(out.text())).toMatchObject({ level: 30, msg: 'Configuración cargada', n: 1 });
  });

  it('el archivo de log queda en UTF-8, con timestamp ISO y sin secretos', () => {
    const file = path.join(tmp.dir, 'logs', 'bot.log');
    const logger = createLogger({ console: false, file });
    logger.warn({ apiKey: 'NO-DEBE-VERSE', config: { apiSecret: 'TAMPOCO' } }, 'Pérdida máxima diaria');
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(line).toMatchObject({ level: 40, msg: 'Pérdida máxima diaria', apiKey: '[REDACTED]', config: { apiSecret: '[REDACTED]' } });
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('console: false no escribe en la terminal', () => {
    const out = fakeStdout();
    createLogger({ console: false, stdout: out.stream }).info('nada');
    expect(out.text()).toBe('');
  });

  it('respeta el nivel', () => {
    const out = fakeStdout();
    const logger = createLogger({ level: 'warn', pretty: false, stdout: out.stream });
    logger.info('no');
    logger.warn('sí');
    expect(out.text().trim().split('\n')).toHaveLength(1);
  });
});
