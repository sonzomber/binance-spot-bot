/**
 * Secuencia de arranque del bot, en este orden:
 *
 *   1. Configuración y entorno: advertencia si el dry-run está desactivado,
 *      estrategia, cliente con guardia de red (bloqueo de mainnet) y preflight
 *      (conexión, mercado y credenciales del entorno).
 *   2. Hora: sincronización con el servidor de Binance.
 *   3. Estado de riesgo desde SQLite: parada guardada, kill switch, posiciones
 *      y PnL del día; ¿alcanza MAX_TRADE_USDT para una orden válida?
 *   4. Reconciliación con Binance (órdenes y saldos) y límites de riesgo.
 *   5. Velas históricas suficientes para calentar los indicadores.
 *
 * Si un paso falla, se cierra lo que ya se abrió y se lanza StartupError con
 * el paso y el motivo. Si todos pasan, arranca el feed en vivo y el ciclo del bot.
 *
 * Desde el paso 3 (cuando ya hay base de datos) se guarda el estado del bot para
 * el panel: "starting", y si el arranque falla, "stopped" con el motivo.
 */
import { runPreflight } from './config/preflight.js';
import { TradingBot } from './bot.js';
import { createCandleFeed } from './data/candle-feed.js';
import { DataHealth } from './data/data-health.js';
import { WeightLimiter } from './data/rate-limiter.js';
import { TimeSync } from './data/time-sync.js';
import { createExecution } from './execution/index.js';
import { createTradingExchange } from './lib/exchange.js';
import { startupExitCode } from './lib/exit-codes.js';
import { RiskError, createRiskManager } from './risk/risk-manager.js';
import { BotStatusStore, publicSettings } from './storage/bot-status-store.js';
import { openDatabase } from './storage/db.js';
import { createStrategy } from './strategy/registry.js';

const STEPS = 5;

export class StartupError extends Error {
  constructor(step, name, cause) {
    super(`paso ${step}/${STEPS} (${name}): ${cause.message}`, { cause });
    this.name = 'StartupError';
    this.step = step;
  }
}

/**
 * @param {object} args
 * @param {object} args.config configuración validada
 * @param {import('pino').Logger} args.logger
 * @param {object} [args.overrides] para pruebas: fetchImplementation (red REST simulada),
 *        createSocket (WebSocket simulado), warnDelayMs (cuenta regresiva del dry-run)
 * @returns {Promise<TradingBot>} el bot ya en marcha
 */
export async function startBot({ config, logger, overrides = {} }) {
  const { fetchImplementation, createSocket, warnDelayMs = 1000 } = overrides;
  const opened = []; // recursos abiertos, para cerrarlos si el arranque falla
  let status; // estado del bot para el panel (desde el paso 3)

  const step = async (n, name, fn) => {
    logger.info(`[${n}/${STEPS}] ${name}…`);
    try {
      const result = await fn();
      logger.info(`[${n}/${STEPS}] ${name}: OK`);
      return result;
    } catch (err) {
      throw new StartupError(n, name, err);
    }
  };

  try {
    // 1. Configuración y entorno ---------------------------------------------------------
    let timeSync;
    const { strategy, exchange, market } = await step(1, 'Configuración y entorno (bloqueo de mainnet)', async () => {
      if (!config.dryRun) await warnOrdersEnabled(config, logger, warnDelayMs);
      const strategy = await createStrategy(config.strategy.id, config.strategy.params);
      logger.info({ strategy: strategy.id, params: strategy.params, warmup: strategy.warmup }, 'Estrategia cargada');
      const limiter = new WeightLimiter({ logger, now: () => (timeSync ? timeSync.now() : Date.now()) });
      const exchange = createTradingExchange(config, { limiter });
      if (fetchImplementation) exchange.fetchImplementation = fetchImplementation;
      opened.push({ name: 'cliente del exchange', close: () => exchange.close() });
      const { market } = await runPreflight(exchange, config, logger);
      return { strategy, exchange, market };
    });

    // 2. Hora del servidor -------------------------------------------------------------
    timeSync = await step(2, 'Sincronizar la hora con Binance', async () => {
      const sync = new TimeSync({ exchange, logger });
      const { offsetMs, rttMs } = await sync.sync();
      logger.info({ offsetMs, rttMs }, `Reloj local ${offsetMs >= 0 ? 'atrasado' : 'adelantado'} ${Math.abs(offsetMs)} ms respecto de Binance (compensado)`);
      sync.start();
      opened.push({ name: 'sincronización de hora', close: () => sync.stop() });
      return sync;
    });
    const now = () => timeSync.now();

    // 3. Estado de riesgo --------------------------------------------------------------
    const { db, risk, health, price } = await step(3, 'Cargar el estado de riesgo desde SQLite', async () => {
      const db = openDatabase(config.storage.dbPath, { logger });
      opened.push({ name: 'base de datos', close: () => db.close() });
      status = saveStatus(logger, 'arranque', () => {
        const store = new BotStatusStore(db, config);
        store.start({
          time: now(), pid: process.pid, heartbeatMs: config.lifecycle.heartbeatMs, strategy: strategy.id,
          params: strategy.params, symbol: config.symbol, timeframe: config.timeframe, settings: publicSettings(config),
        });
        return store;
      });
      const health = new DataHealth({ timeframe: config.timeframe, staleAfterMs: config.dataStaleAfterMs, now, logger });
      const risk = createRiskManager(config, db, logger, { now, dataHealth: health });
      risk.assertCanStart(); // parada guardada o kill switch activo → no arranca
      const { last: price } = await exchange.fetchTicker(config.symbol);
      risk.assertTradable(market, price);
      const daily = risk.dailyPnl({ [config.symbol]: price });
      logger.info(
        { openPositions: risk.store.openPositions().length, dailyPnl: daily.total, day: daily.day },
        `Estado de riesgo: ${risk.store.openPositions().length} posición(es) abierta(s), PnL del día ${daily.total.toFixed(2)} USDT`,
      );
      return { db, risk, health, price };
    });

    // 4. Reconciliación ----------------------------------------------------------------
    let bot;
    const { executor } = await step(4, 'Reconciliar con Binance', async () => {
      const execution = createExecution({
        config, db, exchange, market, risk, logger, now,
        getPrice: () => bot?.getPrice() ?? price,
      });
      const report = await execution.reconciler.run();
      if (!report.ok) {
        const details = report.differences.map((d) => d.detail).join('; ');
        throw new RiskError(`${report.differences.length} diferencia(s) con el exchange: ${details}. Revísalas con "npm run reconcile"`);
      }
      const limits = await risk.enforceLimits({
        markPrices: { [config.symbol]: price },
        cancelOpenOrders: () => execution.executor.cancelAll(),
      });
      if (limits.halted) throw new RiskError(`parada de riesgo: ${limits.reason}`);
      return execution;
    });

    // 5. Velas históricas --------------------------------------------------------------
    const feed = await step(5, 'Cargar velas históricas para calentar los indicadores', async () => {
      const warmupCandles = Math.max(strategy.lookback, strategy.warmup, 50);
      const feed = createCandleFeed({ config, exchange, market, db, health, now, logger, warmupCandles, createSocket });
      opened.push({ name: 'feed de datos', close: () => feed.stop() });
      const { available } = await feed.loadHistory();
      if (available < strategy.warmup) {
        throw new Error(`hay ${available} velas y la estrategia "${strategy.id}" necesita ${strategy.warmup}`);
      }
      return feed;
    });

    // En marcha ------------------------------------------------------------------------
    health.start();
    opened.push({ name: 'monitor de datos', close: () => health.stop() });
    feed.startStreaming();
    bot = new TradingBot({
      config, strategy, feed, executor, risk, health, killSwitch: risk.killSwitch, logger, now, status,
      // Se cierran en este orden: primero lo que produce eventos, al final la base de datos.
      resources: [...opened].reverse(),
    });
    bot.start();
    return bot;
  } catch (err) {
    // Para el panel: por qué no arrancó (antes de cerrar la base de datos), con el
    // mismo código de salida que usará el proceso (3 = rechazo esperado, 1 = error).
    if (status) {
      saveStatus(logger, 'arranque fallido', () => status.stopped({
        time: Date.now(), reason: `no arrancó: ${err.message}`, exitCode: startupExitCode(err),
      }));
    }
    for (const resource of opened.reverse()) {
      try {
        await resource.close();
      } catch {
        // se ignora: el error original es el importante
      }
    }
    throw err;
  }
}

/**
 * Guarda el estado del bot para el panel. Nunca lanza: si falla, lo advierte y
 * el arranque sigue igual (es solo un registro).
 * @returns {*} lo que devuelve write, o undefined si falló
 */
function saveStatus(logger, what, write) {
  try {
    return write();
  } catch (err) {
    logger.warn({ err: err.message }, `No se pudo guardar el estado del bot para el panel (${what}); el bot sigue normalmente`);
    return undefined;
  }
}

/**
 * Dry-run desactivado: advertencia imposible de pasar por alto y 5 pausas de
 * `delayMs` (5 s en total) para cancelar con Ctrl+C antes de enviar órdenes.
 */
async function warnOrdersEnabled(config, logger, delayMs) {
  const line = '='.repeat(72);
  logger.warn(
    [
      line,
      `  DRY-RUN DESACTIVADO: el bot ENVIARÁ ÓRDENES a ${config.env.toUpperCase()} (${config.env === 'testnet' ? 'testnet.binance.vision' : 'demo.binance.com'}).`,
      '  Los fondos son ficticios, pero las órdenes son reales en ese entorno.',
      `  Máximo por operación: ${config.risk.maxTradeUsdt} USDT · pérdida diaria máxima: ${config.risk.maxDailyLossUsdt} USDT.`,
      '  Para volver a simular: DRY_RUN=true en el .env.',
      line,
    ].join('\n'),
  );
  for (let seconds = 5; seconds > 0; seconds--) {
    logger.warn(`Arrancando en ${seconds} s… (Ctrl+C para cancelar)`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
