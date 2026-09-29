/**
 * Modelo de ejecución simulada: el MISMO para el dry-run y el backtest.
 *
 * Una orden de mercado se ejecuta al mejor precio disponible, que casi nunca es
 * exactamente el último precio visto: comprando se paga un poco más y vendiendo
 * se recibe un poco menos (slippage). Además se paga la comisión del exchange.
 *
 *   compra: precio × (1 + slippage)      venta: precio × (1 − slippage)
 *   comisión = cantidad × precio de ejecución × feeRate   (en USDT)
 */
export function simulateMarketFill({ side, amount, price, slippageBps, feeRate, quote = 'USDT' }) {
  const slippage = slippageBps / 10_000;
  const fillPrice = side === 'buy' ? price * (1 + slippage) : price * (1 - slippage);
  const fee = amount * fillPrice * feeRate;
  return { qty: amount, price: fillPrice, feeAmount: fee, feeCurrency: quote, feeQuote: fee };
}
