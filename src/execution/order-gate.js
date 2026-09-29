/**
 * Filtro de órdenes a nivel de red: la última capa para que NINGUNA orden
 * salga sin pasar por el gestor de riesgo.
 *
 * Toda petición REST pasa por la guardia de red (src/config/safety.js), que
 * llama a check() antes de enviarla. Si la petición CREA una orden (POST a
 * /api/v3/order, /orderList, /sor/order…), debe llevar un newClientOrderId que
 * el ejecutor haya autorizado presentando una aprobación auténtica del riesgo.
 * Así, ni siquiera exchange.createOrder() llamado directamente puede enviar una
 * orden, y un mismo clientOrderId no se puede enviar dos veces.
 *
 * Cancelar (DELETE) y consultar (GET) no se filtran: reducen o no cambian el riesgo.
 */
import { SafetyError } from '../config/safety.js';
import { consumeApproval } from '../risk/risk-manager.js';

/** Endpoints Spot que crean órdenes. */
const ORDER_CREATION_PATH = /^\/api\/v3\/(order(\/(test|oco|cancelReplace))?|orderList\/[a-zA-Z]+|sor\/order(\/test)?)$/;
const GATE = Symbol.for('binance-spot-bot.orderGate');

export class OrderGate {
  /** @param {{ env: string, mode: string }} scope ámbito de las órdenes que envía este cliente */
  constructor(scope) {
    this.scope = scope;
    this.authorized = new Set(); // clientOrderIds autorizados, aún no enviados
    this.sent = new Set(); // clientOrderIds ya enviados (no se pueden reenviar)
  }

  /**
   * Autoriza el envío de UNA orden. Consume la aprobación del riesgo: sin una
   * aprobación auténtica y exacta para esta orden, lanza RiskBypassError.
   */
  authorize(order, approval) {
    consumeApproval(approval, order, { scope: this.scope });
    this.authorized.add(order.clientOrderId);
  }

  /** Lo llama la guardia de red antes de cada petición REST. */
  check(url, method, body) {
    const { pathname, searchParams } = new URL(url);
    if (!['POST', 'PUT'].includes(String(method).toUpperCase()) || !ORDER_CREATION_PATH.test(pathname)) return;

    const params = new URLSearchParams(typeof body === 'string' ? body : '');
    const clientOrderId = params.get('newClientOrderId') ?? searchParams.get('newClientOrderId');
    if (!clientOrderId) {
      throw new SafetyError('orden sin clientOrderId bloqueada: toda orden debe pasar por el ejecutor y el gestor de riesgo');
    }
    if (this.sent.has(clientOrderId)) {
      throw new SafetyError(`reenvío bloqueado: la orden ${clientOrderId} ya se envió; hay que consultar su estado, no reenviarla`);
    }
    if (!this.authorized.has(clientOrderId)) {
      throw new SafetyError(`orden ${clientOrderId} sin aprobación del gestor de riesgo: bloqueada antes de salir`);
    }
    this.authorized.delete(clientOrderId);
    this.sent.add(clientOrderId);
  }
}

/** Instala el filtro en un cliente (no se puede quitar ni reemplazar). */
export function installOrderGate(exchange, scope) {
  const gate = new OrderGate(scope);
  Object.defineProperty(exchange, GATE, { value: gate, writable: false, configurable: false, enumerable: false });
  return gate;
}

export function getOrderGate(exchange) {
  const gate = exchange?.[GATE];
  if (!gate) throw new SafetyError('el cliente del exchange no tiene el filtro de órdenes instalado');
  return gate;
}
