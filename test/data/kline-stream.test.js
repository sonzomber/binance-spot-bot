import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafetyError } from '../../src/config/safety.js';
import {
  KlineStream,
  defaultSocketFactory,
  klineStreamUrl,
  parseKlineMessage,
} from '../../src/data/kline-stream.js';
import { captureLogger } from '../helpers.js';

const URL = 'wss://stream.testnet.binance.vision/ws/btcusdt@kline_1m';

/** Socket falso con la misma interfaz que el de `ws`. */
class FakeSocket extends EventEmitter {
  pong = vi.fn();
  close = vi.fn((code = 1000, reason = '') => this.emit('close', code, Buffer.from(reason)));
  terminate = vi.fn(() => this.emit('close', 1006, Buffer.from('')));
  open() { this.isOpen = true; this.emit('open'); }
  kline(k, E = Date.now()) {
    this.emit('message', Buffer.from(JSON.stringify({ e: 'kline', E, s: 'BTCUSDT', k: { s: 'BTCUSDT', i: '1m', ...k } })));
  }
  drop(code = 1006) { this.isOpen = false; this.emit('close', code, Buffer.from('')); } // corte del servidor/red
}

const kline = (t, x, c = '84000.5') => ({ t, T: t + 59_999, o: '84000.00', h: '84010.00', l: '83990.00', c, v: '1.5', x });

let sockets;
let stream;
let lines;
beforeEach(async () => {
  vi.useFakeTimers();
  sockets = [];
  const capture = await captureLogger();
  lines = capture.lines;
  stream = new KlineStream({
    url: URL,
    env: 'testnet',
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    logger: capture.logger,
    random: () => 0.5, // jitter determinista
    backoff: { baseMs: 1000, maxMs: 30_000 },
    maxConnectionAgeMs: 23 * 3_600_000,
    livenessTimeoutMs: 60_000,
  });
});
afterEach(() => {
  stream.stop();
  vi.useRealTimers();
});
const current = () => sockets.at(-1);

describe('mensajes de velas', () => {
  it('klineStreamUrl arma la URL del stream', () => {
    expect(klineStreamUrl('wss://stream.testnet.binance.vision/ws/', 'BTCUSDT', '15m'))
      .toBe('wss://stream.testnet.binance.vision/ws/btcusdt@kline_15m');
  });

  it('parseKlineMessage: convierte strings a números y distingue cerradas (x) de en curso', () => {
    const raw = JSON.stringify({ e: 'kline', E: 5, k: kline(60_000, false) });
    expect(parseKlineMessage(raw)).toEqual({
      candle: { time: 60_000, open: 84000, high: 84010, low: 83990, close: 84000.5, volume: 1.5 },
      closed: false,
      eventTime: 5,
    });
    expect(parseKlineMessage(JSON.stringify({ e: 'kline', k: kline(0, true) })).closed).toBe(true);
    expect(parseKlineMessage(JSON.stringify({ e: 'trade' }))).toBeNull();
  });

  it('emite cada actualización con su marca de cerrada/en curso', () => {
    const received = [];
    stream.on('kline', (m) => received.push([m.candle.time, m.closed]));
    stream.start();
    current().open();
    current().kline(kline(0, false));
    current().kline(kline(0, false));
    current().kline(kline(0, true));
    expect(received).toEqual([[0, false], [0, false], [0, true]]);
  });

  it('un mensaje corrupto se ignora sin cortar la conexión', () => {
    stream.start();
    current().open();
    current().emit('message', Buffer.from('{no es json'));
    expect(lines.some((l) => /Mensaje WebSocket inválido/.test(l.msg))).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});

describe('pings de Binance', () => {
  it('responde cada ping con un pong del mismo contenido', () => {
    stream.start();
    current().open();
    const payload = Buffer.from('1790645766092');
    current().emit('ping', payload);
    expect(current().pong).toHaveBeenCalledWith(payload);
  });

  it('un ping cuenta como actividad (la conexión está viva aunque no haya operaciones)', () => {
    const activity = vi.fn();
    stream.on('activity', activity);
    stream.start();
    current().open();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      current().emit('ping', Buffer.from('x')); // mercado quieto: solo pings cada 20 s
    }
    expect(activity).toHaveBeenCalledTimes(6); // open + 5 pings
    expect(sockets).toHaveLength(1); // no se dio por muerta
  });
});

describe('reconexión con backoff exponencial y jitter', () => {
  it('se reconecta tras un corte, con esperas crecientes mientras siga fallando', () => {
    stream.start();
    current().drop(); // falla antes de abrir
    vi.advanceTimersByTime(749);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); // 1000/2 + 0.5 × 1000/2 = 750 ms
    expect(sockets).toHaveLength(2);
    current().drop();
    vi.advanceTimersByTime(1500); // segundo intento: 1500 ms
    expect(sockets).toHaveLength(3);
    current().drop();
    vi.advanceTimersByTime(2999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1); // tercero: 3000 ms
    expect(sockets).toHaveLength(4);
  });

  it('al reconectar avisa que es una reconexión y cuánto duró el corte; el backoff se reinicia', () => {
    const opens = [];
    stream.on('open', (info) => opens.push(info));
    stream.start();
    current().open();
    current().drop();
    vi.advanceTimersByTime(750);
    current().drop();
    vi.advanceTimersByTime(1500);
    current().open();
    expect(opens).toEqual([{ reconnect: false, downtimeMs: 0 }, { reconnect: true, downtimeMs: 2250 }]);
    current().drop();
    vi.advanceTimersByTime(750); // de nuevo la espera inicial
    expect(sockets).toHaveLength(4);
  });

  it('el cierre de Binance a las 24 h se trata como cualquier corte: reconecta', () => {
    stream.start();
    current().open();
    current().drop(1001); // "going away"
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(2);
  });

  it('rota la conexión por su cuenta antes de las 24 h, sin espera', () => {
    stream.start();
    current().open();
    const steps = (23 * 3_600_000) / 20_000;
    for (let i = 0; i < steps - 1; i++) {
      vi.advanceTimersByTime(20_000);
      current().emit('ping', Buffer.from('')); // el servidor pinguea cada 20 s: la conexión está viva
    }
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(20_000); // se cumplen las 23 h
    expect(sockets[0].close).toHaveBeenCalledWith(1000, 'rotación programada');
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2); // reconexión inmediata (sin backoff)
    expect(lines.some((l) => /Rotación programada/.test(l.msg))).toBe(true);
  });

  it('conexión zombi (sin mensajes ni pings): la corta y reconecta', () => {
    stream.start();
    current().open();
    vi.advanceTimersByTime(65_000); // más de livenessTimeoutMs sin nada
    expect(sockets[0].terminate).toHaveBeenCalled();
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(2);
  });

  it('stop() no reconecta', () => {
    stream.start();
    current().open();
    stream.stop();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('guardia de red', () => {
  it('la fábrica real rechaza URLs de mainnet antes de conectar', () => {
    expect(() => defaultSocketFactory('wss://stream.binance.com:9443/ws/btcusdt@kline_1m', 'testnet')).toThrow(SafetyError);
  });

  it('si la guardia rechaza la URL, el stream emite "fatal" y no reintenta', () => {
    const fatal = vi.fn();
    const blocked = new KlineStream({
      url: 'wss://stream.binance.com:9443/ws/btcusdt@kline_1m', env: 'testnet',
    });
    blocked.on('fatal', fatal);
    blocked.start();
    expect(fatal).toHaveBeenCalledWith(expect.any(SafetyError));
    vi.advanceTimersByTime(120_000);
    expect(blocked.stopped).toBe(true);
  });
});
