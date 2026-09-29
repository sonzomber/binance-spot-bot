/**
 * Secciones del panel. Las que aún muestran "en construcción" se completan en
 * las partes siguientes del plan.
 */
import { Card, EmptyState } from '../components/ui.jsx';

export { ChartSection } from './ChartSection.jsx';
export { LogsSection } from './LogsSection.jsx';
export { OrdersSection } from './OrdersSection.jsx';
export { RiskSection } from './RiskSection.jsx';
export { StatusSection } from './StatusSection.jsx';

export function BacktestsSection() {
  return (
    <Card title="Backtests guardados" subtitle="Datos históricos de producción (solo lectura)" className="span-12">
      <EmptyState title="Sección en construcción" icon="chart">Se completa en la parte 7 del plan del panel.</EmptyState>
    </Card>
  );
}
