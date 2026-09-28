/**
 * Indicadores técnicos: funciones puras sobre series de números.
 * No saben nada de velas, órdenes ni exchange.
 */

/**
 * Media móvil simple (SMA): promedio de los últimos `period` valores.
 *
 * Devuelve una serie alineada con la entrada: la posición i contiene la SMA de
 * values[i - period + 1 .. i], o null si todavía no hay `period` valores.
 *
 *   sma([1, 2, 3, 4, 5], 3) → [null, null, 2, 3, 4]
 *
 * @param {number[]} values
 * @param {number} period entero ≥ 1
 * @returns {(number | null)[]}
 */
export function sma(values, period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`sma: period debe ser un entero ≥ 1 (recibido ${period})`);
  }
  if (!Array.isArray(values)) {
    throw new TypeError('sma: values debe ser un array');
  }
  values.forEach((value, i) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`sma: values[${i}] no es un número finito (${String(value)})`);
    }
  });

  return values.map((_, i) => {
    if (i < period - 1) return null;
    // Suma directa de la ventana: evita que se acumule error de redondeo (una
    // suma móvil sumaría y restaría floats durante toda la serie).
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    return sum / period;
  });
}
