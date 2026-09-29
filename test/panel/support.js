/**
 * Soporte para las pruebas del panel: una base con datos creados con los
 * stores REALES del bot, el panel escuchando en un puerto libre, y un cliente
 * HTTP de bajo nivel (node:http) que permite fijar Host y Origin a mano, como
 * lo haría otra página del navegador o un atacante.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadPanelConfig } from '../../panel/server/config.js';
import { startPanel } from '../../panel/server/index.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskManager } from '../../src/risk/risk-manager.js';
import { BotStatusStore, publicSettings } from '../../src/storage/bot-status-store.js';
import { CandleStore } from '../../src/storage/candle-store.js';
import { openDatabase } from '../../src/storage/db.js';
import { OrderStore } from '../../src/storage/order-store.js';
import { RiskStore } from '../../src/storage/risk-store.js';
import { captureLogger, tempDir } from '../helpers.js';

export const MIN = 60_000;
export const SCOPE = Object.freeze({ env: 'testnet', mode: 'dry-run' });
export const OTHER_SCOPE = Object.freeze({ env: 'demo', mode: 'exchange' });
/** Valores centinela: si aparecen en alguna respuesta, se filtró un secreto. */
export const SECRET_KEY = 'CLAVE-CENTINELA-NO-DEBE-SALIR-9f3a';
export const SECRET_SECRET = 'SECRETO-CENTINELA-NO-DEBE-SALIR-7b1c';

/**
 * Petición HTTP cruda. Por defecto con el Host correcto del panel.
 * @returns {Promise<{ status: number, headers: object, text: string, json: any }>}
 */
export function request(port, { method = 'GET', path: url = '/', headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      // Content-Length explícito: sin él, Node no delimita el cuerpo en OPTIONS/DELETE.
      headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* no es JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Conexión SSE: junta los eventos que llegan. */
export function openLive(port, { headers = {} } = {}) {
  const events = [];
  let buffer = '';
  let response;
  const req = http.request({ host: '127.0.0.1', port, path: '/api/live', headers: { host: `127.0.0.1:${port}`, ...headers } });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: JSON.parse(data) });
        }
      });
      resolve(res);
    });
    req.on('error', reject);
  });
  req.end();
  return { events, ready, get response() { return response; }, close: () => req.destroy() };
}

/**
 * Crea el entorno de prueba: carpeta temporal, .env con API keys centinela
 * (que el panel NUNCA debe leer), base de datos y panel escuchando.
 * @param {{ seed?: (ctx) => void, env?: object, createDb?: boolean, now?: number }} [options]
 */
export async function setupPanel({ seed, env = {}, createDb = true, now = Date.now() } = {}) {
  const tmp = await tempDir('panel-test-');
  const files = {
    envFile: path.join(tmp.dir, '.env'),
    dbPath: path.join(tmp.dir, 'bot.db'),
    logFile: path.join(tmp.dir, 'bot.log'),
    killSwitchFile: path.join(tmp.dir, 'STOP'),
  };
  fs.writeFileSync(files.envFile, [
    `BINANCE_API_KEY=${SECRET_KEY}`,
    `BINANCE_API_SECRET=${SECRET_SECRET}`,
    'STRATEGY=sma-cross',
    'STRATEGY_PARAMS={"fast":2,"slow":4}',
    'TIMEFRAME=1m',
    `DB_PATH=${files.dbPath}`,
    `LOG_FILE=${files.logFile}`,
    `KILL_SWITCH_FILE=${files.killSwitchFile}`,
  ].join('\n'));
  const config = loadPanelConfig({ envFile: files.envFile, env });

  // El "bot": una conexión de escritura, como la del proceso del bot.
  const writer = createDb ? openDatabase(files.dbPath) : null;
  const ctx = { tmp, files, config, writer, now };
  if (writer && seed) seed(ctx);

  const logs = await captureLogger();
  const panel = await startPanel({
    config, logger: logs.logger, port: 0, webRoot: path.join(tmp.dir, 'web'),
    overrides: { now: () => ctx.now, intervalMs: 50 },
  });
  Object.assign(ctx, {
    panel, logs, port: panel.port,
    get: (url, headers) => request(panel.port, { path: url, headers }),
    origin: `http://127.0.0.1:${panel.port}`,
    async cleanup() {
      await panel.close();
      writer?.close();
      tmp.cleanup();
    },
  });
  return ctx;
}

/** POST al kill switch con todo en regla (cada prueba de seguridad quita o cambia UNA cosa). */
export function killRequest(ctx, { headers = {}, body = { confirm: true, reason: 'prueba' }, omit = [] } = {}) {
  const base = {
    origin: ctx.origin,
    'content-type': 'application/json',
    'x-panel-token': ctx.panel.token,
    'sec-fetch-site': 'same-origin',
  };
  for (const key of omit) delete base[key];
  return request(ctx.port, { method: 'POST', path: '/api/kill-switch', headers: { ...base, ...headers }, body });
}

// --- Datos de ejemplo (con los stores reales del bot) ------------------------------------

/** Estado de un bot en marcha, con heartbeat reciente. */
export function seedRunningBot(ctx, scope = SCOPE, { heartbeatAgoMs = 5_000, price = 84_000 } = {}) {
  const status = new BotStatusStore(ctx.writer, scope);
  const config = { dryRun: scope.mode === 'dry-run', risk: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 }, execution: { feeRate: 0.001, slippageBps: 5 }, dataFeed: 'ws', dataStaleAfterMs: 60_000, apiKey: SECRET_KEY, apiSecret: SECRET_SECRET };
  status.start({
    time: ctx.now - 3_600_000, pid: 1234, heartbeatMs: 60_000, strategy: 'sma-cross', params: { fast: 2, slow: 4 },
    symbol: 'BTC/USDT', timeframe: '1m', settings: publicSettings(config),
  });
  status.running({ time: ctx.now - 3_590_000 });
  status.heartbeat({
    time: ctx.now - heartbeatAgoMs, lastCandle: ctx.now - 2 * MIN, price, priceTime: ctx.now - heartbeatAgoMs,
    data: { stale: false, reason: null },
  });
  return status;
}

/** Riesgo real (RiskManager) sobre la base de escritura. */
export function riskFor(ctx, scope = SCOPE) {
  return new RiskManager({
    store: new RiskStore(ctx.writer, scope),
    killSwitch: new KillSwitch(ctx.files.killSwitchFile),
    limits: { maxTradeUsdt: 50, maxDailyLossUsdt: 20, maxOpenPositions: 1 },
    feeRate: 0.001, slippageBps: 5,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: () => ctx.now,
  });
}

/** Una orden ejecutada (create → aceptada → fill), como la deja el ejecutor. */
export function seedFilledOrder(ctx, scope, { id, side, qty, price, fee, time }) {
  const orders = new OrderStore(ctx.writer, scope, { now: () => time });
  orders.create({ clientOrderId: id, symbol: 'BTC/USDT', side, type: 'market', amount: qty, price, strategy: 'sma-cross', signalCode: side === 'buy' ? 'GOLDEN_CROSS' : 'DEATH_CROSS' });
  orders.markAccepted(id, { exchangeOrderId: `ex-${id}` });
  orders.addFill(id, { tradeId: `t-${id}`, qty, price, feeAmount: fee, feeCurrency: 'USDT', feeQuote: fee, time });
}

/** Velas de 1 minuto en el caché del entorno, terminando en la última cerrada. */
export function seedCandles(ctx, env, closes) {
  const last = Math.floor(ctx.now / MIN) * MIN - MIN;
  const candles = closes.map((close, i) => {
    const time = last - (closes.length - 1 - i) * MIN;
    return { time, open: close, high: close, low: close, close, volume: 1 };
  });
  new CandleStore(ctx.writer, { env }).upsert('BTC/USDT', '1m', candles, { now: ctx.now });
  return candles;
}
