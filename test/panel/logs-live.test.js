/**
 * Logs (lectura, filtros por nivel y ámbito, seguimiento en vivo) y
 * actualizaciones en tiempo real por SSE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogTail, createLogFilter, parseLine, readRecentLogs, redact } from '../../panel/server/log-reader.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { BotStatusStore } from '../../src/storage/bot-status-store.js';
import { tempDir } from '../helpers.js';
import { SCOPE, openLive, seedRunningBot, setupPanel } from './support.js';

const line = (level, msg, extra = {}) => `${JSON.stringify({ level, time: '2026-09-29T12:00:00.000Z', msg, ...extra })}\n`;

describe('lectura y filtros de logs', () => {
  let tmp;
  let file;
  beforeEach(async () => {
    tmp = await tempDir();
    file = path.join(tmp.dir, 'bot.log');
    fs.writeFileSync(file, [
      line(20, 'depuración', { scope: 'testnet/dry-run' }),
      line(30, 'info testnet', { scope: 'testnet/dry-run' }),
      line(40, 'aviso testnet', { scope: 'testnet/dry-run' }),
      line(50, 'error testnet', { scope: 'testnet/dry-run' }),
      line(60, 'fatal testnet', { scope: 'testnet/dry-run' }),
      line(30, 'info demo', { scope: 'demo/exchange' }),
      line(30, 'general (script)'),
      'esto no es JSON\n',
      line(40, 'aviso general'),
    ].join(''));
  });
  afterEach(() => tmp.cleanup());

  const msgs = (options) => readRecentLogs(file, { filter: createLogFilter(options) }).lines.map((l) => l.msg);

  it('por ámbito: las del ámbito elegido más las generales; nunca las de otro ámbito', () => {
    expect(msgs({ scope: SCOPE })).toEqual(['info testnet', 'aviso testnet', 'error testnet', 'fatal testnet', 'general (script)', 'aviso general']);
    expect(msgs({ scope: { env: 'demo', mode: 'exchange' } })).toEqual(['info demo', 'general (script)', 'aviso general']);
    expect(msgs({ scope: SCOPE, includeGeneral: false })).toEqual(['info testnet', 'aviso testnet', 'error testnet', 'fatal testnet']);
  });

  it('por nivel: info, warn, error ("error" incluye fatal); debug solo si se pide', () => {
    expect(msgs({ scope: SCOPE, levels: ['warn'] })).toEqual(['aviso testnet', 'aviso general']);
    expect(msgs({ scope: SCOPE, levels: ['error'] })).toEqual(['error testnet', 'fatal testnet']);
    expect(msgs({ scope: SCOPE, levels: ['warn', 'error'], includeGeneral: false })).toEqual(['aviso testnet', 'error testnet', 'fatal testnet']);
    expect(msgs({ scope: SCOPE, levels: ['debug'] })).toEqual(['depuración']);
  });

  it('ignora líneas que no son JSON y respeta el límite (las más recientes)', () => {
    expect(readRecentLogs(file, { filter: createLogFilter({ scope: SCOPE }), limit: 2 }).lines.map((l) => l.msg)).toEqual(['general (script)', 'aviso general']);
    expect(parseLine('esto no es JSON')).toBeNull();
    expect(parseLine('{"sin":"nivel"}')).toBeNull();
  });

  it('archivo inexistente: lista vacía, no error', () => {
    expect(readRecentLogs(path.join(tmp.dir, 'no.log'))).toEqual({ exists: false, lines: [] });
  });

  it('redact oculta campos con nombre de secreto a cualquier profundidad', () => {
    expect(redact({ apiKey: 'a', a: { api_secret: 'b', list: [{ signature: 'c', ok: 1 }] }, headers: { 'X-MBX-APIKEY': 'd', Authorization: 'e' }, clientOrderId: 'se ve' }))
      .toEqual({ apiKey: '[REDACTED]', a: { api_secret: '[REDACTED]', list: [{ signature: '[REDACTED]', ok: 1 }] }, headers: { 'X-MBX-APIKEY': '[REDACTED]', Authorization: '[REDACTED]' }, clientOrderId: 'se ve' });
  });

  it('LogTail: solo lo nuevo, líneas a medio escribir y caracteres UTF-8 cortados entre lecturas', () => {
    const tail = new LogTail(file);
    expect(tail.poll()).toEqual([]); // empieza al final

    const text = line(30, 'Configuración inválida: ñandú', { scope: 'testnet/dry-run' });
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(Buffer.from('ó')) + 1; // a la MITAD de la "ó" (2 bytes)
    fs.appendFileSync(file, bytes.subarray(0, cut));
    expect(tail.poll()).toEqual([]); // línea incompleta: todavía nada
    fs.appendFileSync(file, bytes.subarray(cut));
    expect(tail.poll().map((l) => l.msg)).toEqual(['Configuración inválida: ñandú']);

    fs.writeFileSync(file, line(40, 'archivo nuevo')); // truncado/reemplazado
    expect(tail.poll().map((l) => l.msg)).toEqual(['archivo nuevo']);
  });
});

// ---------------------------------------------------------------------------------
describe('endpoint /api/logs', () => {
  let ctx;
  afterEach(() => ctx.cleanup());

  it('filtra por nivel y ámbito según los parámetros, y valida los valores', async () => {
    ctx = await setupPanel({ seed: (c) => seedRunningBot(c) });
    fs.writeFileSync(ctx.files.logFile, [
      line(30, 'info t', { scope: 'testnet/dry-run' }), line(50, 'error t', { scope: 'testnet/dry-run' }),
      line(50, 'error d', { scope: 'demo/exchange' }), line(40, 'aviso general'),
    ].join(''));
    const msgs = async (query) => (await ctx.get(`/api/logs?${query}`)).json.lines.map((l) => l.msg);
    expect(await msgs('env=testnet&mode=dry-run')).toEqual(['info t', 'error t', 'aviso general']);
    expect(await msgs('env=testnet&mode=dry-run&levels=error')).toEqual(['error t']);
    expect(await msgs('env=demo&mode=exchange&levels=error,warn&general=0')).toEqual(['error d']);
    expect((await ctx.get('/api/logs?levels=todo')).status).toBe(400);
    expect((await ctx.get('/api/logs?general=si')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------
describe('tiempo real (SSE)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await setupPanel({ seed: (c) => seedRunningBot(c) });
    fs.writeFileSync(ctx.files.logFile, line(30, 'anterior', { scope: 'testnet/dry-run' }));
  });
  afterEach(() => ctx.cleanup());

  const waitFor = (live, name) => expect.poll(() => live.events.find((e) => e.event === name), { timeout: 3000 }).toBeTruthy();

  it('saludo inicial con el estado de la base, el kill switch y el identificador de esta ejecución', async () => {
    const live = openLive(ctx.port);
    const res = await live.ready;
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    await waitFor(live, 'hello');
    expect(live.events[0].data).toMatchObject({ database: { state: 'ok' }, killSwitch: { active: false }, instanceId: ctx.panel.instanceId });
    live.close();
    // El mismo identificador que ve la página al cargar (si cambia, el panel se reinició)
    expect((await ctx.get('/api/meta')).json.panel.instanceId).toBe(ctx.panel.instanceId);
    expect(ctx.panel.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cuando el bot guarda algo → "db"; el kill switch → "killswitch"; una línea de log → "logs"', async () => {
    const live = openLive(ctx.port);
    await live.ready;
    await waitFor(live, 'hello');

    new BotStatusStore(ctx.writer, SCOPE).heartbeat({ time: Date.now(), lastCandle: Date.now() - 60_000, price: 1, priceTime: Date.now() });
    await waitFor(live, 'db');

    new KillSwitch(ctx.files.killSwitchFile).activate('prueba en vivo');
    await waitFor(live, 'killswitch');
    expect(live.events.find((e) => e.event === 'killswitch').data).toMatchObject({ active: true, reason: 'prueba en vivo' });

    fs.appendFileSync(ctx.files.logFile, line(40, 'nuevo aviso', { scope: 'testnet/dry-run' }));
    await waitFor(live, 'logs');
    // Solo lo nuevo (la línea anterior no se reenvía)
    expect(live.events.find((e) => e.event === 'logs').data.lines.map((l) => l.msg)).toEqual(['nuevo aviso']);
    live.close();
  });

  it('se vigila solo mientras hay alguien conectado', async () => {
    const live = openLive(ctx.port);
    await live.ready;
    await waitFor(live, 'hello');
    expect(ctx.panel.hub.timers).not.toBeNull();
    live.close();
    await expect.poll(() => ctx.panel.hub.clients.size, { timeout: 3000 }).toBe(0);
    expect(ctx.panel.hub.timers).toBeNull();
  });
});
