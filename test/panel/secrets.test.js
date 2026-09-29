/**
 * El panel nunca lee, muestra ni envía las API keys ni otros secretos.
 *
 * El .env de prueba tiene API keys "centinela": si alguno de esos textos
 * aparece en cualquier respuesta (REST, SSE o HTML), la prueba falla.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_PORT, PANEL_ENV_KEYS, loadPanelConfig } from '../../panel/server/config.js';
import { tempDir } from '../helpers.js';
import { SCOPE, SECRET_KEY, SECRET_SECRET, openLive, riskFor, seedCandles, seedFilledOrder, seedRunningBot, setupPanel } from './support.js';

const leaks = (text) => text.includes(SECRET_KEY) || text.includes(SECRET_SECRET);

let ctx;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe('config del panel: lista blanca sin secretos', () => {
  it('la lista de variables que lee no incluye las API keys', () => {
    expect(PANEL_ENV_KEYS.filter((key) => /API|SECRET|KEY$/.test(key))).toEqual([]);
  });

  it('con API keys en el .env: la config no las contiene y process.env no se toca', async () => {
    const tmp = await tempDir();
    try {
      const envFile = path.join(tmp.dir, '.env');
      fs.writeFileSync(envFile, `BINANCE_API_KEY=${SECRET_KEY}\nBINANCE_API_SECRET=${SECRET_SECRET}\nSTRATEGY=sma-cross\n`);
      const before = { key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET };
      const config = loadPanelConfig({ envFile, env: {} });
      expect(leaks(JSON.stringify(config))).toBe(false);
      expect(Object.keys(config).some((k) => /api|secret/i.test(k))).toBe(false);
      expect({ key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET }).toEqual(before);
    } finally {
      tmp.cleanup();
    }
  });

  it('valida con el esquema del bot; un valor inválido usa el defecto y avisa (no impide monitorear)', async () => {
    const tmp = await tempDir();
    try {
      const envFile = path.join(tmp.dir, '.env');
      fs.writeFileSync(envFile, 'BINANCE_ENV=mainnet\nDRY_RUN=false\nPANEL_PORT=80\nMAX_DAILY_LOSS_USDT=15\n');
      const config = loadPanelConfig({ envFile, env: {} });
      expect(config.defaultScope).toEqual({ env: 'testnet', mode: 'exchange' }); // mainnet no existe; DRY_RUN=false → exchange
      expect(config.port).toBe(DEFAULT_PANEL_PORT);
      expect(config.limits.maxDailyLossUsdt).toBe(15);
      expect(config.warnings.join('\n')).toMatch(/BINANCE_ENV: .*no soporta mainnet/);
      expect(config.warnings.join('\n')).toMatch(/PANEL_PORT: debe ser ≥ 1024/);
    } finally {
      tmp.cleanup();
    }
  });

  it('PANEL_PORT configurable en el .env (y las variables del proceso tienen prioridad, como en el bot)', async () => {
    const tmp = await tempDir();
    try {
      const envFile = path.join(tmp.dir, '.env');
      fs.writeFileSync(envFile, 'PANEL_PORT=9100\n');
      expect(loadPanelConfig({ envFile, env: {} }).port).toBe(9100);
      expect(loadPanelConfig({ envFile, env: { PANEL_PORT: '9200' } }).port).toBe(9200);
      expect(loadPanelConfig({ envFile: path.join(tmp.dir, 'no-existe'), env: {} }).port).toBe(8787);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('ninguna respuesta contiene secretos', () => {
  // Las keys también en el entorno del proceso (p. ej. exportadas en la terminal):
  // así, cualquier código que volcara process.env quedaría en evidencia.
  const saved = {};
  beforeEach(() => {
    for (const key of ['BINANCE_API_KEY', 'BINANCE_API_SECRET']) saved[key] = process.env[key];
    process.env.BINANCE_API_KEY = SECRET_KEY;
    process.env.BINANCE_API_SECRET = SECRET_SECRET;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('la config que llega al navegador tiene exactamente los campos públicos (lista blanca)', async () => {
    ctx = await setupPanel();
    const { config } = (await ctx.get('/api/meta')).json;
    expect(Object.keys(config).sort()).toEqual([
      'dataStaleAfterMs', 'defaultScope', 'envFileFound', 'feeRate', 'heartbeatMs', 'limits', 'paths',
      'slippageBps', 'strategy', 'symbol', 'timeframe', 'warnings',
    ]);
  });

  it('REST, HTML y SSE, con datos en todas las secciones y una línea de log con claves sin ocultar', async () => {
    ctx = await setupPanel({
      seed: (c) => {
        seedRunningBot(c); // su config de prueba incluye apiKey/apiSecret: publicSettings los deja afuera
        seedCandles(c, 'testnet', [100, 101, 102, 103, 104, 105]);
        seedFilledOrder(c, SCOPE, { id: 'o-1', side: 'buy', qty: 0.001, price: 100, fee: 0.1, time: Date.now() - 60_000 });
        riskFor(c).recordEntry({ symbol: 'BTC/USDT', qty: 0.001, price: 100 });
      },
    });
    // Una línea de log que (por un error hipotético) no pasó por la redacción de pino
    fs.writeFileSync(ctx.files.logFile, `${JSON.stringify({
      level: 30, time: new Date().toISOString(), scope: 'testnet/dry-run', msg: 'config',
      apiKey: SECRET_KEY, config: { apiSecret: SECRET_SECRET, nested: [{ 'X-MBX-APIKEY': SECRET_KEY }] },
    })}\n`);

    const live = openLive(ctx.port);
    await live.ready;
    const urls = ['/', '/api/meta', `/api/status?env=testnet&mode=dry-run`, '/api/risk', '/api/candles', '/api/orders', '/api/logs', '/api/backtests'];
    for (const url of urls) {
      const res = await ctx.get(url);
      expect(res.status, url).toBe(200);
      expect(leaks(res.text), url).toBe(false);
    }
    const logs = (await ctx.get('/api/logs')).json.lines;
    expect(logs[0].data).toEqual({ apiKey: '[REDACTED]', config: { apiSecret: '[REDACTED]', nested: [{ 'X-MBX-APIKEY': '[REDACTED]' }] } });

    // SSE: el saludo y una línea nueva del log en vivo
    fs.appendFileSync(ctx.files.logFile, `${JSON.stringify({ level: 40, time: new Date().toISOString(), msg: 'x', secret: SECRET_SECRET })}\n`);
    await expect.poll(() => live.events.some((e) => e.event === 'logs'), { timeout: 3000 }).toBe(true);
    live.close();
    expect(live.events.length).toBeGreaterThan(1);
    expect(leaks(JSON.stringify(live.events))).toBe(false);
  });
});
