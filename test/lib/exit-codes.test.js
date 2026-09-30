/**
 * Códigos de salida: el lanzador (pm2) reinicia con 1 y NO reinicia con 3.
 */
import { describe, expect, it } from 'vitest';
import { StartupError } from '../../src/app.js';
import { ConfigError } from '../../src/config/index.js';
import { PreflightError } from '../../src/config/preflight.js';
import { SafetyError } from '../../src/config/safety.js';
import { IpBannedError } from '../../src/data/rate-limiter.js';
import {
  EXIT_CODES, EXPECTED_STARTUP_ERRORS, describeExitCode, isExpectedStartupError, needsAttentionMessage, startupExitCode,
} from '../../src/lib/exit-codes.js';
import { RiskError } from '../../src/risk/risk-manager.js';
import { StrategyError } from '../../src/strategy/base-strategy.js';

const inStep = (cause) => new StartupError(3, 'paso de prueba', cause);

describe('códigos de salida', () => {
  it('0 = apagado pedido, 1 = caída, 3 = detenido a propósito', () => {
    expect(EXIT_CODES).toEqual({ OK: 0, ERROR: 1, NEEDS_ATTENTION: 3 });
  });

  it('los rechazos esperados al arrancar salen con 3 (vienen envueltos en StartupError)', () => {
    const causes = [
      new SafetyError('mainnet'),
      new PreflightError('keys rechazadas'),
      new StrategyError('estrategia inexistente'),
      new RiskError('kill switch activo'),
      new ConfigError(['BINANCE_ENV: inválido']),
      new IpBannedError(Date.now() + 60_000),
    ];
    expect(causes.map((c) => c.name)).toEqual([...EXPECTED_STARTUP_ERRORS]); // la lista cubre exactamente estas clases
    for (const cause of causes) {
      expect(isExpectedStartupError(inStep(cause))).toBe(true);
      expect(startupExitCode(inStep(cause))).toBe(3);
    }
  });

  it('un error inesperado al arrancar (la red, un bug) sale con 1: se puede reintentar', () => {
    const network = Object.assign(new Error('ECONNRESET'), { name: 'NetworkError' });
    for (const err of [inStep(network), inStep(new TypeError('x is undefined')), new Error('sin causa')]) {
      expect(isExpectedStartupError(err)).toBe(false);
      expect(startupExitCode(err)).toBe(1);
    }
  });

  it('un rechazo esperado sin envolver (fuera de los pasos) también sale con 3', () => {
    expect(startupExitCode(new RiskError('parada'))).toBe(3);
  });

  it('el mensaje del log dice qué pasó, con código 3, y que no se reinicia solo', () => {
    expect(needsAttentionMessage('kill switch: mantenimiento')).toBe(
      'Detenido a propósito (código 3): kill switch: mantenimiento. No se reinicia solo: revisa el motivo antes de volver a iniciarlo.',
    );
    expect(needsAttentionMessage('paso 3/5 (riesgo): kill switch activo. Ejecuta "npm run resume".', { startup: true })).toBe(
      'Arranque rechazado (código 3): paso 3/5 (riesgo): kill switch activo. Ejecuta "npm run resume". '
        + 'No se reinicia solo: revisa el motivo antes de volver a iniciarlo.',
    );
  });

  it('descripción de cada código', () => {
    expect(describeExitCode(0)).toBe('apagado ordenado');
    expect(describeExitCode(1)).toBe('caída inesperada');
    expect(describeExitCode(3)).toMatch(/^detenido a propósito .*no se reinicia solo/);
    expect(describeExitCode(130)).toMatch(/^salida forzada/);
    expect(describeExitCode(null)).toBe('sin código de salida');
    expect(describeExitCode(undefined)).toBe('sin código de salida');
    expect(describeExitCode(7)).toBe('código de salida 7');
  });
});
