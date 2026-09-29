/**
 * Gestión de riesgo.
 *
 * Responsabilidades:
 *   1. Validar ANTES de cada orden: parada activa, kill switch, pérdida diaria,
 *      monto máximo por operación, máximo de posiciones abiertas y filtros del par.
 *   2. Registrar las operaciones ejecutadas (con comisiones) para calcular el PnL.
 *   3. Vigilar los límites en cada ciclo y, si se activan, ejecutar la parada de
 *      emergencia: guardar la parada, bloquear órdenes nuevas, cancelar las
 *      pendientes y registrar el motivo. Reanudar requiere `npm run resume`.
 *
 * Todo el estado vive en SQLite (RiskStore): reiniciar el bot NO resetea nada.
 * El "día" del límite diario es el día UTC (00:00:00 a 23:59:59.999 UTC).
 */
import { KillSwitch } from './kill-switch.js';
import { checkMarketFilters, roundDownToStep } from './market-filters.js';
import { entryCost, exitProceeds, nextUtcMidnight, unrealizedPnl, utcDay } from './pnl.js';
import { RiskStore } from '../storage/risk-store.js';

export const RiskCode = Object.freeze({
  OK: 'OK',
  INVALID_ORDER: 'INVALID_ORDER',
  HALTED: 'HALTED',
  KILL_SWITCH: 'KILL_SWITCH',
  DAILY_LOSS: 'DAILY_LOSS',
  MAX_POSITIONS: 'MAX_POSITIONS',
  MAX_TRADE: 'MAX_TRADE',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  NO_POSITION: 'NO_POSITION',
  EXCEEDS_POSITION: 'EXCEEDS_POSITION',
  MARKET_FILTER: 'MARKET_FILTER',
  STALE_DATA: 'STALE_DATA',
  RECONCILIATION: 'RECONCILIATION',
  DUPLICATE_SIGNAL: 'DUPLICATE_SIGNAL',
  ORDER_IN_FLIGHT: 'ORDER_IN_FLIGHT',
});

export class RiskError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RiskError';
  }
}

/** Alguien intentó enviar una orden sin una aprobación válida del gestor de riesgo. */
export class RiskBypassError extends Error {
  constructor(message) {
    super(`Orden bloqueada: ${message}. Toda orden debe pasar por el gestor de riesgo.`);
    this.name = 'RiskBypassError';
  }
}

// --- Aprobaciones ------------------------------------------------------------------
// Una aprobación es la "llave" que exige cualquier envío de órdenes (simulado o real).
// Solo checkOrder() puede crearlas: el registro de aprobaciones auténticas es privado
// de este módulo (no se exporta), así que no se pueden fabricar desde afuera. Cada
// una sirve para UNA orden exacta (mismo clientOrderId, lado, cantidad…), una sola
// vez y por poco tiempo.
const genuineApprovals = new WeakSet();
const usedApprovals = new WeakSet();
const APPROVAL_TTL_MS = 30_000;
const APPROVAL_FIELDS = ['clientOrderId', 'symbol', 'side', 'type', 'amount', 'price'];

function issueApproval(order, scope, now) {
  const approval = Object.freeze({
    ...Object.fromEntries(APPROVAL_FIELDS.map((field) => [field, order[field]])),
    env: scope.env,
    mode: scope.mode,
    issuedAt: now,
  });
  genuineApprovals.add(approval);
  return approval;
}

/**
 * Verifica y CONSUME una aprobación antes de enviar una orden.
 * @throws {RiskBypassError} si no es auténtica, ya se usó, venció o no coincide con la orden
 */
export function consumeApproval(approval, order, { scope, now = Date.now() } = {}) {
  if (!approval || !genuineApprovals.has(approval)) throw new RiskBypassError('sin aprobación auténtica del gestor de riesgo');
  if (usedApprovals.has(approval)) throw new RiskBypassError(`la aprobación de ${approval.clientOrderId} ya se usó (reenvío bloqueado)`);
  if (now - approval.issuedAt > APPROVAL_TTL_MS) throw new RiskBypassError('la aprobación venció: hay que volver a evaluar el riesgo');
  for (const field of APPROVAL_FIELDS) {
    if (approval[field] !== order[field]) {
      throw new RiskBypassError(`la orden no coincide con lo aprobado (${field}: ${order[field]} ≠ ${approval[field]})`);
    }
  }
  if (scope && (approval.env !== scope.env || approval.mode !== scope.mode)) {
    throw new RiskBypassError(`aprobación de otro entorno (${approval.env}/${approval.mode})`);
  }
  usedApprovals.add(approval);
  return true;
}

const reject = (code, reason, extra = {}) => Object.freeze({ ok: false, code, reason, ...extra });
const usdt = (value) => `${value.toFixed(2)} USDT`;
const iso = (ms) => new Date(ms).toISOString();
const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

export class RiskManager {
  /**
   * @param {object} deps
   * @param {RiskStore} deps.store repositorio atado a un ámbito (entorno + modo)
   * @param {KillSwitch} deps.killSwitch
   * @param {{ maxTradeUsdt: number, maxDailyLossUsdt: number, maxOpenPositions: number }} deps.limits
   * @param {number} deps.feeRate comisión estimada (0.001 = 0.1%)
   * @param {number} deps.slippageBps slippage estimado en puntos básicos
   * @param {import('pino').Logger} deps.logger
   * @param {() => number} [deps.now] reloj inyectable (tests)
   * @param {{ status: () => { stale: boolean, reason: string|null } }} [deps.dataHealth]
   *        frescura de los datos de mercado: si están desactualizados, no se aceptan órdenes
   * @param {{ status: () => { ok: boolean, reason: string|null } }} [deps.reconciliation]
   *        reconciliación con el exchange: si hay diferencias sin resolver, no se aceptan órdenes
   */
  constructor({ store, killSwitch, limits, feeRate, slippageBps, logger, now = Date.now, dataHealth, reconciliation }) {
    this.dataHealth = dataHealth;
    this.reconciliation = reconciliation;
    this.store = store;
    this.scope = store.scope;
    this.killSwitch = killSwitch;
    this.limits = Object.freeze({ ...limits });
    this.feeRate = feeRate;
    this.slippageBps = slippageBps;
    this.logger = logger;
    this.now = now;
  }

  // --- Estado -------------------------------------------------------------------

  haltState() {
    return this.store.getHaltState();
  }

  /**
   * PnL del día UTC actual, neto de comisiones:
   *   realizado    = operaciones CERRADAS hoy (comisión de compra y de venta incluidas)
   *   no realizado = posiciones abiertas valoradas a precio de mercado, menos la
   *                  comisión estimada de venta (desde su entrada, aunque sea de ayer:
   *                  es conservador)
   * Las ganancias del día compensan las pérdidas (se mide el neto).
   * @param {Record<string, number>} [markPrices] precio actual por símbolo
   */
  dailyPnl(markPrices = {}) {
    const day = utcDay(this.now());
    const realized = this.store.realizedForDay(day);
    let unrealized = 0;
    const missingPrices = [];
    for (const position of this.store.openPositions()) {
      let price = markPrices[position.symbol];
      if (!positive(price)) {
        missingPrices.push(position.symbol);
        price = position.entryPrice; // sin precio actual: al menos cuenta las comisiones
      }
      unrealized += unrealizedPnl(position, price, this.feeRate);
    }
    return {
      day,
      realized: realized.pnl,
      realizedFees: realized.fees,
      closedTrades: realized.trades,
      unrealized,
      total: realized.pnl + unrealized,
      missingPrices,
    };
  }

  isDailyLossReached(daily) {
    return daily.total <= -this.limits.maxDailyLossUsdt;
  }

  // --- Arranque -----------------------------------------------------------------

  /** Se niega a arrancar si hay una parada guardada o el kill switch está activo. */
  assertCanStart() {
    const halt = this.haltState();
    if (halt.halted) {
      throw new RiskError(
        `el bot está detenido desde ${halt.haltedAt} (${halt.code}): ${halt.reason}. ` +
          'Revisa la causa y ejecuta "npm run resume" para reanudar.',
      );
    }
    if (this.killSwitch.isActive()) {
      throw new RiskError(
        `kill switch activo (${this.killSwitch.file}): ${this.killSwitch.read().reason}. ` +
          'Ejecuta "npm run resume" para reanudar.',
      );
    }
  }

  /** Verifica que con MAX_TRADE_USDT se pueda hacer al menos una compra válida en el par. */
  assertTradable(market, price) {
    const { amount } = this.sizeBuy({ market, price });
    const violations =
      amount > 0
        ? checkMarketFilters({ side: 'buy', type: 'market', amount, price }, market)
        : ['la cantidad resultante es 0'];
    if (violations.length) {
      throw new RiskError(
        `con MAX_TRADE_USDT=${this.limits.maxTradeUsdt} no se puede comprar ${market.symbol} ` +
          `a ~${price}: ${violations.join('; ')}. Sube MAX_TRADE_USDT.`,
      );
    }
  }

  // --- Tamaño de las órdenes -----------------------------------------------------

  /** Costo estimado de una compra: peor precio esperado (slippage) + comisión. */
  estimateBuyCost(amount, price) {
    return amount * price * (1 + this.slippageBps / 10_000) * (1 + this.feeRate);
  }

  /**
   * Cantidad a comprar con el presupuesto MAX_TRADE_USDT, dejando margen para
   * slippage y comisión, redondeada HACIA ABAJO al paso del par.
   */
  sizeBuy({ market, price }) {
    const step = market.precision?.amount;
    const unitCost = this.estimateBuyCost(1, price);
    let amount = roundDownToStep(this.limits.maxTradeUsdt / unitCost, step);
    const cap = Math.min(market.limits?.amount?.max || Infinity, market.limits?.market?.max || Infinity);
    if (amount > cap) amount = roundDownToStep(cap, step);
    return { amount, price, estimatedCost: this.estimateBuyCost(amount, price) };
  }

  /**
   * Cantidad a vender para cerrar la posición más antigua del símbolo,
   * redondeada hacia abajo al paso del par.
   */
  sizeSell({ market }) {
    const position = this.store.oldestOpenPosition(market.symbol);
    if (!position) return null;
    return { amount: roundDownToStep(position.qty, market.precision?.amount), position };
  }

  // --- Validación antes de cada orden ---------------------------------------------

  /**
   * @param {{ symbol: string, side: 'buy'|'sell', type: 'market'|'limit', amount: number, price: number,
   *           clientOrderId?: string }} order
   *        price: precio límite, o precio estimado de ejecución si es de mercado
   * @param {{ market: object, markPrices?: Record<string, number>, freeQuote?: number,
   *           activeOrders?: number, duplicateOf?: object }} context
   *        activeOrders: órdenes vivas del par; duplicateOf: orden que ya produjo esta señal
   * @returns {{ ok: boolean, code: string, reason?: string, approval?: object }}
   *          si la orden trae clientOrderId y se aprueba, incluye la aprobación de un solo uso
   */
  checkOrder(order, { market, markPrices = {}, freeQuote, activeOrders = 0, duplicateOf = null } = {}) {
    const { symbol, side, type, amount, price } = order ?? {};
    if (!['buy', 'sell'].includes(side) || !['market', 'limit'].includes(type)) {
      return reject(RiskCode.INVALID_ORDER, `orden inválida: side=${side}, type=${type}`);
    }
    if (!market || market.symbol !== symbol) {
      return reject(RiskCode.INVALID_ORDER, `falta la información del mercado de ${symbol}`);
    }
    if (!positive(amount) || !positive(price)) {
      return reject(RiskCode.INVALID_ORDER, `cantidad o precio inválidos (amount=${amount}, price=${price})`);
    }

    // 1. Paradas: ninguna orden nueva, ni de compra ni de venta
    const halt = this.haltState();
    if (halt.halted) {
      return reject(RiskCode.HALTED, `bot detenido (${halt.code}): ${halt.reason}`);
    }
    if (this.killSwitch.isActive()) {
      return reject(RiskCode.KILL_SWITCH, `kill switch activo: ${this.killSwitch.read().reason}`);
    }
    const reconciliation = this.reconciliation?.status();
    if (reconciliation && !reconciliation.ok) {
      return reject(RiskCode.RECONCILIATION, `reconciliación con el exchange pendiente: ${reconciliation.reason}`);
    }
    const health = this.dataHealth?.status();
    if (health?.stale) {
      return reject(RiskCode.STALE_DATA, `datos de mercado desactualizados: ${health.reason}`);
    }
    // Idempotencia: una señal produce como máximo una orden, y no se envía otra
    // mientras haya una viva en el par (su resultado aún puede cambiar la posición).
    if (duplicateOf) {
      return reject(RiskCode.DUPLICATE_SIGNAL, `esta señal ya generó la orden ${duplicateOf.clientOrderId} (${duplicateOf.status}): no se reenvía`);
    }
    if (activeOrders > 0) {
      return reject(RiskCode.ORDER_IN_FLIGHT, `hay ${activeOrders} orden(es) sin terminar en ${symbol}: se espera su resultado`);
    }
    const daily = this.dailyPnl({ [symbol]: price, ...markPrices });
    if (this.isDailyLossReached(daily)) {
      return reject(
        RiskCode.DAILY_LOSS,
        `la pérdida del día ${daily.day} UTC (${usdt(daily.total)}) alcanzó el límite (−${usdt(this.limits.maxDailyLossUsdt)})`,
        { daily },
      );
    }

    // 2. Límites de exposición
    if (side === 'buy') {
      const open = this.store.openPositions().length;
      if (open >= this.limits.maxOpenPositions) {
        return reject(
          RiskCode.MAX_POSITIONS,
          `hay ${open} posición(es) abierta(s) y el máximo es ${this.limits.maxOpenPositions}`,
        );
      }
      const cost = this.estimateBuyCost(amount, price);
      if (cost > this.limits.maxTradeUsdt + 1e-9) {
        return reject(
          RiskCode.MAX_TRADE,
          `costo estimado ${usdt(cost)} (con slippage y comisión) supera MAX_TRADE_USDT=${this.limits.maxTradeUsdt}`,
        );
      }
      if (freeQuote !== undefined && cost > freeQuote) {
        return reject(RiskCode.INSUFFICIENT_BALANCE, `costo estimado ${usdt(cost)} supera el saldo libre ${usdt(freeQuote)}`);
      }
    } else {
      // Vender reduce la exposición: no se limita por MAX_TRADE_USDT, pero en Spot
      // solo se puede vender lo que se tiene.
      const position = this.store.oldestOpenPosition(symbol);
      if (!position) {
        return reject(RiskCode.NO_POSITION, `no hay posición abierta en ${symbol} (en Spot solo se vende lo que se tiene)`);
      }
      if (amount > position.qty * (1 + 1e-9)) {
        return reject(RiskCode.EXCEEDS_POSITION, `se intenta vender ${amount} y la posición tiene ${position.qty}`);
      }
    }

    // 3. Filtros del par en Binance
    const violations = checkMarketFilters({ side, type, amount, price }, market);
    if (violations.length) {
      return reject(RiskCode.MARKET_FILTER, `no cumple los filtros de ${symbol}: ${violations.join('; ')}`, {
        violations,
      });
    }
    return Object.freeze({
      ok: true,
      code: RiskCode.OK,
      approval: order.clientOrderId ? issueApproval(order, this.scope, this.now()) : null,
    });
  }

  // --- Registro de operaciones ejecutadas ---------------------------------------------

  /**
   * Registra una compra ejecutada (abre una posición).
   * @param {{ symbol: string, qty: number, price: number, feeQuote?: number, time?: number, orderId?: number }} fill
   *        qty: base recibida neta de comisión; feeQuote: comisión en USDT; orderId: fila en la tabla orders
   */
  recordEntry({ symbol, qty, price, feeQuote = 0, time = this.now(), orderId = null }) {
    assertFill({ qty, price, feeQuote });
    const position = this.store.insertPosition({
      symbol,
      qty,
      entryPrice: price,
      entryFee: feeQuote,
      entryCost: entryCost({ qty, price, feeQuote }),
      entryTime: time,
      entryOrderId: orderId,
    });
    this.logger.info(
      { positionId: position.id, symbol, qty, price, fee: feeQuote, cost: position.entryCost },
      'Posición abierta',
    );
    return position;
  }

  /**
   * Registra una venta ejecutada sobre la posición más antigua del símbolo.
   *
   * - Venta total: cierra la posición. Si por el paso del par quedó un residuo
   *   que no se puede vender ("dust", menor que dustQty), su costo se cuenta
   *   como pérdida: es conservador.
   * - Venta PARCIAL (p. ej. una orden ejecutada solo en parte): la parte vendida
   *   se registra como operación cerrada, con su parte proporcional del costo, y
   *   la posición sigue abierta con la cantidad que realmente queda.
   *
   * @param {{ symbol, qty, price, feeQuote?, time?, orderId?, dustQty? }} fill
   */
  recordExit({ symbol, qty, price, feeQuote = 0, time = this.now(), orderId = null, dustQty = 0 }) {
    assertFill({ qty, price, feeQuote });
    const position = this.store.oldestOpenPosition(symbol);
    if (!position) throw new RiskError(`no hay posición abierta en ${symbol} para registrar la venta`);
    if (qty > position.qty * (1 + 1e-9)) {
      throw new RiskError(`se vendió ${qty} y la posición #${position.id} solo tenía ${position.qty}`);
    }

    const proceeds = exitProceeds({ qty, price, feeQuote });
    const exit = {
      exitQty: qty, exitPrice: price, exitFee: feeQuote, exitProceeds: proceeds,
      exitTime: time, exitDay: utcDay(time), exitOrderId: orderId,
    };
    const remaining = position.qty - qty;
    let closed;
    if (remaining <= Math.max(dustQty, position.qty * 1e-9)) {
      closed = this.store.closePosition(position.id, { ...exit, realizedPnl: proceeds - position.entryCost });
    } else {
      const share = qty / position.qty;
      const soldCost = position.entryCost * share;
      closed = this.store.splitPosition(position.id, {
        ...exit,
        soldQty: qty,
        soldCost,
        soldEntryFee: position.entryFee * share,
        realizedPnl: proceeds - soldCost,
      });
      this.logger.info(
        { positionId: position.id, sold: qty, remaining },
        `Venta parcial: la posición #${position.id} sigue abierta con ${remaining}`,
      );
    }
    this.logger.info(
      { positionId: closed.id, symbol, qty, price, fee: feeQuote, pnl: closed.realizedPnl },
      `Posición cerrada: ${closed.realizedPnl >= 0 ? 'ganancia' : 'pérdida'} de ${usdt(Math.abs(closed.realizedPnl))} (comisiones incluidas)`,
    );
    return closed;
  }

  // --- Límites en ejecución y parada de emergencia -------------------------------------

  /**
   * Revisa la parada guardada, el kill switch y la pérdida diaria. Si alguno se
   * activa, ejecuta la parada de emergencia. El bot la llama en cada ciclo y
   * después de cada operación; si devuelve halted=true, el bot se detiene.
   *
   * @param {{ markPrices?: Record<string, number>, cancelOpenOrders: () => Promise<unknown[]> }} args
   */
  async enforceLimits({ markPrices = {}, cancelOpenOrders }) {
    const halt = this.haltState();
    if (halt.halted) {
      // Parada registrada por otro proceso (p. ej. npm run kill con el bot corriendo)
      return this.emergencyStop({ code: halt.code, reason: halt.reason, cancelOpenOrders });
    }
    if (this.killSwitch.isActive()) {
      const { reason } = this.killSwitch.read();
      return this.emergencyStop({ code: RiskCode.KILL_SWITCH, reason: `kill switch: ${reason}`, cancelOpenOrders });
    }
    const daily = this.dailyPnl(markPrices);
    if (this.isDailyLossReached(daily)) {
      return this.emergencyStop({
        code: RiskCode.DAILY_LOSS,
        reason:
          `pérdida del día ${daily.day} UTC: ${usdt(daily.total)} ` +
          `(realizada ${usdt(daily.realized)}, no realizada ${usdt(daily.unrealized)}, comisiones incluidas); ` +
          `límite −${usdt(this.limits.maxDailyLossUsdt)}`,
        cancelOpenOrders,
      });
    }
    return { halted: false, daily };
  }

  /**
   * Parada de emergencia, en este orden:
   *   1. Guarda la parada en SQLite ANTES que nada: si algo falla después (o el
   *      proceso muere), al reiniciar el bot sigue detenido.
   *   2. Desde ese momento checkOrder rechaza toda orden nueva.
   *   3. Cancela las órdenes abiertas pendientes (si falla, lo registra y sigue).
   *   4. Registra el motivo en el log. Quien llama detiene el bot.
   * Es idempotente: si ya estaba detenido, conserva el motivo original.
   */
  async emergencyStop({ code, reason, cancelOpenOrders }) {
    if (typeof cancelOpenOrders !== 'function') {
      throw new TypeError('emergencyStop requiere cancelOpenOrders()');
    }
    const current = this.haltState();
    if (!current.halted) this.store.setHalt({ code, reason, time: this.now() });
    const halt = current.halted ? current : { code, reason };

    this.logger.error({ code: halt.code, reason: halt.reason }, `PARADA DE EMERGENCIA: ${halt.reason}`);

    let cancelled = [];
    let cancelError;
    try {
      cancelled = (await cancelOpenOrders()) ?? [];
      this.logger.warn({ cancelled: cancelled.length }, `Órdenes pendientes canceladas: ${cancelled.length}`);
    } catch (err) {
      cancelError = err;
      this.store.addEvent({ time: this.now(), type: 'CANCEL_FAILED', code: halt.code, message: err.message });
      this.logger.error({ err }, 'No se pudieron cancelar las órdenes pendientes: revísalas manualmente en el exchange');
    }

    this.logger.error('Bot detenido. No se enviarán órdenes nuevas. Para reanudar: revisa la causa y ejecuta "npm run resume".');
    return { halted: true, code: halt.code, reason: halt.reason, cancelled, cancelError };
  }

  /**
   * Reanudación MANUAL (npm run resume): borra la parada y el archivo del kill switch.
   * Se niega si la pérdida realizada de hoy (UTC) ya alcanzó el límite, porque
   * el bot se volvería a detener: hay que esperar al próximo día UTC.
   */
  resume({ by = 'manual' } = {}) {
    const now = this.now();
    const day = utcDay(now);
    const { pnl: realized } = this.store.realizedForDay(day);
    if (realized <= -this.limits.maxDailyLossUsdt) {
      throw new RiskError(
        `no se puede reanudar todavía: la pérdida realizada del día ${day} UTC (${usdt(realized)}) ` +
          `alcanzó el límite (−${usdt(this.limits.maxDailyLossUsdt)}). ` +
          `Podrás reanudar desde ${iso(nextUtcMidnight(now))} (00:00 UTC).`,
      );
    }

    const previous = this.haltState();
    const killSwitchWasActive = this.killSwitch.isActive();
    if (!previous.halted && !killSwitchWasActive) {
      return { resumed: false, previous };
    }
    this.killSwitch.clear();
    this.store.clearHalt({
      time: now,
      message: `Reanudado manualmente (${by})`,
      data: { previous, killSwitchWasActive },
    });
    this.logger.warn({ previous }, 'Bot reanudado manualmente');
    return { resumed: true, previous };
  }
}

function assertFill({ qty, price, feeQuote }) {
  if (!positive(qty) || !positive(price) || !(Number.isFinite(feeQuote) && feeQuote >= 0)) {
    throw new RiskError(`operación inválida: qty=${qty}, price=${price}, fee=${feeQuote}`);
  }
}

/** Arma el RiskManager a partir de la config y una base de datos abierta. */
export function createRiskManager(config, db, logger, { now, dataHealth, reconciliation } = {}) {
  return new RiskManager({
    store: new RiskStore(db, { env: config.env, mode: config.mode }),
    killSwitch: new KillSwitch(config.risk.killSwitchFile),
    limits: {
      maxTradeUsdt: config.risk.maxTradeUsdt,
      maxDailyLossUsdt: config.risk.maxDailyLossUsdt,
      maxOpenPositions: config.risk.maxOpenPositions,
    },
    feeRate: config.execution.feeRate,
    slippageBps: config.execution.slippageBps,
    logger,
    now,
    dataHealth,
    reconciliation,
  });
}
