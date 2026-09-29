/**
 * Señales del sistema y errores inesperados → apagado ordenado.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installProcessHandlers } from '../src/lifecycle.js';
import { captureLogger } from './helpers.js';

let proc;
let exit;
let bot;
let logs;
let handlers;
beforeEach(async () => {
  proc = new EventEmitter(); // hace de `process`
  exit = vi.fn();
  logs = await captureLogger();
  bot = { shutdown: vi.fn(() => new Promise(() => {})) }; // el apagado "tarda"
  handlers = installProcessHandlers({ proc, logger: logs.logger, getBot: () => bot, exit, forceExitAfterMs: 10_000 });
});
afterEach(() => {
  handlers.uninstall();
  vi.useRealTimers();
});

describe('SIGINT (Ctrl+C) y SIGTERM', () => {
  it.each(['SIGINT', 'SIGTERM'])('%s inicia el apagado ordenado y registra el motivo', (signal) => {
    proc.emit(signal);
    expect(bot.shutdown).toHaveBeenCalledWith(`señal ${signal}`);
    expect(exit).not.toHaveBeenCalled();
    expect(logs.messages()).toContain(`Señal ${signal} recibida: apagado ordenado (otro Ctrl+C fuerza la salida)`);
  });

  it('un segundo Ctrl+C fuerza la salida y lo registra como advertencia', () => {
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
    const warning = logs.lines.find((l) => /Segunda señal/.test(l.msg));
    expect(warning).toMatchObject({ level: 40, msg: 'Segunda señal (SIGINT): salida FORZADA sin completar el apagado ordenado' });
    expect(bot.shutdown).toHaveBeenCalledTimes(1);
  });

  it('durante el arranque (aún no hay bot) sale de inmediato', () => {
    bot = undefined;
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('si el apagado se cuelga, un temporizador de seguridad fuerza la salida', async () => {
    vi.useFakeTimers();
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.messages().join()).toMatch(/El apagado no terminó en 10 s: salida forzada/);
  });
});

describe('errores inesperados → el mismo apagado seguro', () => {
  it('excepción no controlada: registra el error y apaga con código 1', () => {
    proc.emit('uncaughtException', new Error('bug inesperado'));
    const fatal = logs.lines.find((l) => l.level === 60);
    expect(fatal).toMatchObject({ msg: 'Excepción no controlada', err: expect.objectContaining({ message: 'bug inesperado' }) });
    expect(bot.shutdown).toHaveBeenCalledWith('uncaughtException: bug inesperado', { exitCode: 1 });
  });

  it('promesa rechazada sin manejar: registra y apaga con código 1', () => {
    proc.emit('unhandledRejection', new Error('promesa olvidada'));
    expect(logs.messages()).toContain('Promesa rechazada sin manejar');
    expect(bot.shutdown).toHaveBeenCalledWith('unhandledRejection: promesa olvidada', { exitCode: 1 });
  });

  it('si el apagado mismo falla, fuerza la salida', async () => {
    bot.shutdown.mockRejectedValue(new Error('no se pudo'));
    proc.emit('uncaughtException', new Error('x'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('uninstall quita los manejadores', () => {
    handlers.uninstall();
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });
});
