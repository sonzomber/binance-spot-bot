/**
 * Reporte de backtest en texto, para la consola.
 */
const usdt = (n) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(4)} USDT`);
const pct = (n) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const TITLES = { full: 'PERÍODO COMPLETO', train: 'PERÍODO DE AJUSTE', validation: 'PERÍODO DE VALIDACIÓN (datos no usados para ajustar)' };

export function formatReport({ segment, params, report: r, runId, csvPath }) {
  const bh = r.buyAndHold;
  const rows = [
    ['Período (UTC)', `${r.period.from.slice(0, 16)} → ${r.period.to.slice(0, 16)} (${r.period.candles} velas)`],
    ['Parámetros', JSON.stringify(params)],
    ['Capital inicial → final', `${r.capital} → ${r.finalEquity.toFixed(4)} USDT`],
    ['Ganancia/pérdida neta', `${usdt(r.netPnl)} (${pct(r.netPnlPct)})`],
    ['Operaciones', `${r.trades} (${r.wins} ganadoras, ${r.losses} perdedoras)`],
    ['% ganadoras', r.winRatePct === null ? '—' : `${r.winRatePct.toFixed(1)}%`],
    ['Ganancia promedio', usdt(r.avgWin)],
    ['Pérdida promedio', usdt(r.avgLoss)],
    ['Profit factor', r.profitFactor === null ? (r.grossProfit > 0 ? '∞ (sin pérdidas)' : '—') : r.profitFactor.toFixed(3)],
    ['Máximo drawdown', `${r.maxDrawdown.toFixed(4)} USDT (${r.maxDrawdownPct.toFixed(2)}%)`],
    ['Comisiones pagadas', `${r.totalFees.toFixed(4)} USDT`],
    ['Comprar y mantener', bh.possible ? `${usdt(bh.pnl)} (${pct(bh.pnlPct)})` : `no posible: ${bh.reason}`],
    ['Estrategia vs. comprar y mantener', usdt(r.vsBuyAndHold)],
  ];
  if (r.openPositionAtEnd) {
    rows.push(['Posición abierta al final', `${r.openPositionAtEnd.qty} a ${r.openPositionAtEnd.entryPrice} (valorada al último cierre)`]);
  }
  if (r.halts) rows.push(['Paradas por pérdida diaria', String(r.halts)]);
  const rejected = Object.entries(r.rejections);
  if (rejected.length) rows.push(['Órdenes rechazadas por el riesgo', rejected.map(([code, n]) => `${code}: ${n}`).join(', ')]);
  if (runId) rows.push(['Guardado', `backtest #${runId} · ${csvPath}`]);

  const width = Math.max(...rows.map(([label]) => label.length));
  return [`── ${TITLES[segment]} ${'─'.repeat(Math.max(0, 60 - TITLES[segment].length))}`, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join('\n');
}

export function formatGrid(grid) {
  if (!grid) return null;
  const lines = grid.map((g, i) => `  ${i === 0 ? '→' : ' '} ${JSON.stringify(g.params).padEnd(24)} PnL ${usdt(g.netPnl).padStart(16)}  operaciones ${String(g.trades).padStart(3)}  PF ${g.profitFactor === null ? '—' : g.profitFactor.toFixed(2)}`);
  return ['── AJUSTE: combinaciones probadas (la mejor, marcada con →, es la que se valida)', ...lines].join('\n');
}
