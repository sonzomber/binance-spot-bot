/**
 * Códigos de salida del bot. El lanzador (pm2) los usa para decidir si lo
 * reinicia solo:
 *
 *   0  apagado ordenado pedido (Ctrl+C, "Detener bot")        → no se reinicia
 *   1  caída inesperada (un bug, la red al arrancar, errores  → pm2 lo reinicia
 *      seguidos procesando velas)                                con espera creciente
 *   3  detenido A PROPÓSITO: kill switch, parada de riesgo,   → no se reinicia:
 *      IP bloqueada por Binance (418) o arranque rechazado       requiere que una
 *      (config, entorno, credenciales, riesgo, reconciliación)   persona lo revise
 *
 * Reiniciar en el caso 3 no sirve (volvería a detenerse) o empeora las cosas:
 * con la IP bloqueada, insistir alarga el bloqueo.
 */
export const EXIT_CODES = Object.freeze({ OK: 0, ERROR: 1, NEEDS_ATTENTION: 3 });

/**
 * Rechazos esperados al arrancar (config, entorno, riesgo…): se muestran sin
 * stack trace y salen con código 3. Un error de red o un bug sale con código 1.
 */
export const EXPECTED_STARTUP_ERRORS = Object.freeze([
  'SafetyError', 'PreflightError', 'StrategyError', 'RiskError', 'ConfigError', 'IpBannedError',
]);

/** ¿Es un rechazo esperado? Mira la causa: el arranque envuelve el error de cada paso en StartupError. */
export function isExpectedStartupError(err) {
  const cause = err?.cause ?? err;
  return EXPECTED_STARTUP_ERRORS.includes(cause?.name);
}

/** Código de salida cuando el arranque falla. */
export function startupExitCode(err) {
  return isExpectedStartupError(err) ? EXIT_CODES.NEEDS_ATTENTION : EXIT_CODES.ERROR;
}

/**
 * Texto para el log cuando el bot sale con código 3: qué pasó y que no se reinicia solo.
 * @param {string} reason
 * @param {{ startup?: boolean }} [options] startup: el arranque se rechazó (no llegó a correr)
 */
export function needsAttentionMessage(reason, { startup = false } = {}) {
  const what = startup ? 'Arranque rechazado' : 'Detenido a propósito';
  return `${what} (código ${EXIT_CODES.NEEDS_ATTENTION}): ${String(reason).trim().replace(/\.+$/, '')}. ` +
    'No se reinicia solo: revisa el motivo antes de volver a iniciarlo.';
}

/**
 * Descripción breve de un código de salida (la usan los logs y el lanzador).
 * @param {number|null|undefined} code
 */
export function describeExitCode(code) {
  switch (code) {
    case EXIT_CODES.OK: return 'apagado ordenado';
    case EXIT_CODES.ERROR: return 'caída inesperada';
    case EXIT_CODES.NEEDS_ATTENTION: return 'detenido a propósito (requiere intervención; no se reinicia solo)';
    case 130: return 'salida forzada (segundo Ctrl+C o durante el arranque)';
    case null: case undefined: return 'sin código de salida';
    default: return `código de salida ${code}`;
  }
}
