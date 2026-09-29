/**
 * Secciones del panel. En esta parte (estructura) cada una muestra su lugar
 * definitivo; su contenido se agrega en las partes siguientes del plan.
 */
import { scopeLabel } from '../lib/labels.js';
import { Card, EmptyState } from '../components/ui.jsx';

const Pending = ({ part }) => (
  <EmptyState title="Sección en construcción" icon="chart">
    Se completa en la parte {part} del plan del panel.
  </EmptyState>
);

export function StatusSection({ scope }) {
  return <Card title="Estado del bot" subtitle={scopeLabel(scope)} className="span-5"><Pending part={4} /></Card>;
}

export function RiskSection({ scope }) {
  return <Card title="Riesgo del día" subtitle={`${scopeLabel(scope)} · día UTC`} className="span-7"><Pending part={4} /></Card>;
}

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
