/**
 * Rotación de logs: copiar y vaciar, conservar N copias, y que el bot (pino) y
 * el panel sigan funcionando con el archivo rotado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogTail } from '../../panel/server/log-reader.js';
import { ROTATION, logFilesToRotate, rotateAll, rotateIfNeeded, rotatedName } from '../../launcher/lib/rotate.js';
import { tempDir } from '../helpers.js';

let tmp;
beforeEach(async () => { tmp = await tempDir('rotate-test-'); });
afterEach(() => tmp.cleanup());

const file = (name) => path.join(tmp.dir, name);
const write = (name, text) => fs.writeFileSync(file(name), text);
const read = (name) => fs.readFileSync(file(name), 'utf8');

describe('rotateIfNeeded', () => {
  it('por debajo del límite no toca nada', () => {
    write('bot.log', 'abc');
    expect(rotateIfNeeded(file('bot.log'), { maxBytes: 4, keep: 3 })).toBeNull();
    expect(read('bot.log')).toBe('abc');
    expect(fs.readdirSync(tmp.dir)).toEqual(['bot.log']);
  });

  it('al llegar al límite: copia en .1 y vacía el original', () => {
    write('bot.log', 'abcd');
    expect(rotateIfNeeded(file('bot.log'), { maxBytes: 4, keep: 3 })).toEqual({ file: file('bot.log'), bytes: 4 });
    expect(read('bot.1.log')).toBe('abcd');
    expect(read('bot.log')).toBe('');
  });

  it('corre las copias y conserva solo `keep`', () => {
    for (const round of ['uno', 'dos', 'tres', 'cuatro']) {
      write('bot.log', `${round}-xxxx`);
      rotateIfNeeded(file('bot.log'), { maxBytes: 4, keep: 3 });
    }
    expect(fs.readdirSync(tmp.dir).toSorted()).toEqual(['bot.1.log', 'bot.2.log', 'bot.3.log', 'bot.log']);
    expect([read('bot.1.log'), read('bot.2.log'), read('bot.3.log')]).toEqual(['cuatro-xxxx', 'tres-xxxx', 'dos-xxxx']);
  });

  it('un archivo inexistente no es un error', () => {
    expect(rotateIfNeeded(file('no.log'), { maxBytes: 1, keep: 3 })).toBeNull();
  });

  it('nombres de las copias: conservan la extensión', () => {
    expect(rotatedName(path.join('a', 'bot.log'), 2)).toBe(path.join('a', 'bot.2.log'));
    expect(rotatedName(path.join('a', 'bot.out.log'), 1)).toBe(path.join('a', 'bot.out.1.log'));
    expect(rotatedName(path.join('a', 'sin-extension'), 1)).toBe(path.join('a', 'sin-extension.1'));
  });

  it('quien tenga el archivo abierto "agregando al final" (pino, pm2) sigue escribiendo en él, desde el principio', () => {
    const fd = fs.openSync(file('bot.log'), 'a'); // como pino.destination y los logs de pm2
    fs.writeSync(fd, 'línea vieja 1\nlínea vieja 2\n');
    rotateIfNeeded(file('bot.log'), { maxBytes: 10, keep: 5 });
    fs.writeSync(fd, 'línea nueva\n');
    fs.closeSync(fd);
    expect(read('bot.log')).toBe('línea nueva\n'); // sin huecos de ceros al principio
    expect(read('bot.1.log')).toBe('línea vieja 1\nlínea vieja 2\n');
  });

  it('el panel sigue mostrando las líneas nuevas después de rotar (LogTail relee si el archivo se achica)', () => {
    const fd = fs.openSync(file('bot.log'), 'a');
    const line = (msg) => fs.writeSync(fd, `${JSON.stringify({ level: 30, time: '2026-09-29T12:00:00.000Z', msg })}\n`);
    line('antes de empezar');
    const tail = new LogTail(file('bot.log'));
    line('vieja');
    expect(tail.poll().map((l) => l.msg)).toEqual(['vieja']);
    rotateIfNeeded(file('bot.log'), { maxBytes: 10, keep: 5 });
    line('nueva');
    expect(tail.poll().map((l) => l.msg)).toEqual(['nueva']);
    fs.closeSync(fd);
  });
});

describe('qué se rota', () => {
  it('el log del bot, el del lanzador, el del daemon de pm2 y los de cada proceso (no sus copias)', () => {
    const pm2LogDir = path.join(tmp.dir, 'pm2');
    fs.mkdirSync(pm2LogDir);
    for (const name of ['bot.out.log', 'bot.err.log', 'panel.out.log', 'bot.out.1.log', 'otra-cosa.txt']) fs.writeFileSync(path.join(pm2LogDir, name), '');
    const files = logFilesToRotate({ logFile: file('bot.log'), launcherLog: file('lanzador.log'), pm2LogDir, pm2Home: path.join(tmp.dir, '.pm2') });
    expect(files).toEqual([
      file('bot.log'), file('lanzador.log'), path.join(tmp.dir, '.pm2', 'pm2.log'),
      path.join(pm2LogDir, 'bot.err.log'), path.join(pm2LogDir, 'bot.out.log'), path.join(pm2LogDir, 'panel.out.log'),
    ]);
  });

  it('sin la carpeta de pm2 todavía, igual rota los demás', () => {
    const files = logFilesToRotate({ logFile: file('bot.log'), launcherLog: file('l.log'), pm2LogDir: file('no'), pm2Home: file('h') });
    expect(files).toHaveLength(3);
  });

  it('rotateAll: un archivo que falla no impide rotar los demás', () => {
    write('a.log', 'xxxxx');
    fs.mkdirSync(file('b.log')); // una carpeta con nombre de log: copiarla falla
    fs.writeFileSync(path.join(file('b.log'), 'x'), 'xxxxxxxx');
    write('c.log', 'yyyyy');
    const { rotated, errors } = rotateAll([file('a.log'), file('b.log'), file('c.log')], { maxBytes: 0, keep: 2 });
    expect(rotated.map((r) => path.basename(r.file))).toEqual(['a.log', 'c.log']);
    expect(errors.map((e) => path.basename(e.file))).toEqual(['b.log']);
  });

  it('valores: 10 MB, 5 copias, cada 5 minutos', () => {
    expect(ROTATION).toEqual({ maxBytes: 10 * 1024 * 1024, keep: 5, intervalMs: 5 * 60_000 });
  });
});
