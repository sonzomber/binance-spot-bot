/**
 * WebSocket falso con la interfaz del paquete `ws`, para simular el stream de
 * velas de Binance sin red.
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

export class FakeSocket extends EventEmitter {
  pong = vi.fn();
  close = vi.fn((code = 1000, reason = '') => this.emit('close', code, Buffer.from(reason)));
  terminate = vi.fn(() => this.emit('close', 1006, Buffer.from('')));

  open() {
    this.isOpen = true;
    this.emit('open');
  }

  /** Mensaje kline de Binance. `closed` = campo x (vela cerrada). */
  kline(time, close, closed = true) {
    const c = close.toFixed(8);
    this.emit('message', Buffer.from(JSON.stringify({
      e: 'kline', E: Date.now(), s: 'BTCUSDT',
      k: { t: time, T: time + 59_999, s: 'BTCUSDT', i: '1m', o: c, h: c, l: c, c, v: '1.00000000', x: closed },
    })));
  }
}

/** Fábrica que guarda los sockets creados (el último es el activo). */
export function socketFactory() {
  const sockets = [];
  const create = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { sockets, create, current: () => sockets.at(-1) };
}
