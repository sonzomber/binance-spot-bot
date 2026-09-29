/**
 * Secciones del panel. Las que aún muestran "en construcción" se completan en
 * las partes siguientes del plan.
 */
import { Card, EmptyState } from '../components/ui.jsx';
import { scopeLabel } from '../lib/labels.js';

export { RiskSection } from './RiskSection.jsx';
export { StatusSection } from './StatusSection.jsx';

const Pending = ({ part }) => (
  <EmptyState title="Sección en construcción" icon="chart">
    Se completa en la parte {part} del plan del panel.
  </EmptyState>
);

export function ChartSection({ scope }) {
  return <Card title="Gráfico" subtitle={scopeLabel(scope)} className="span-12"><Pending part={5} /></Card>;
}

export function OrdersSection({ scope }) {
  return <Card title="Órdenes" subtitle={scopeLabel(scope)} className="span-12"><Pending part={6} /></Card>;
}

export function LogsSection({ scope }) {
  return <Card title="Logs recientes" subtitle={scopeLabel(scope)} className="span-12"><Pending part={6} /></Card>;
}

export function BacktestsSection() {
  return (
    <Card title="Backtests guardados" subtitle="Datos históricos de producción (solo lectura)" className="span-12">
      <Pending part={7} />
    </Card>
  );
}
