"use client";

import {
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  Line,
} from "recharts";
import Link from "next/link";
import type { SpendByYear, TopEntity, ProcedureBreakdown } from "@/lib/france/types";
import { formatEuro } from "@/lib/france/format";

const WARM_PALETTE = [
  "#c96b52",
  "#2d6a4f",
  "#d4a373",
  "#6b705c",
  "#b5838d",
  "#e6ccb2",
  "#a68a64",
  "#7f5539",
];

export { formatEuro } from "@/lib/france/format";

function CustomTooltip({ active, payload, label }: Record<string, unknown>) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  return (
    <div className="fr-chart-tooltip">
      <p className="fr-chart-tooltip-label">{String(label)}</p>
      {payload.map((entry: Record<string, unknown>, i: number) => (
        <p key={i} className="fr-chart-tooltip-row">
          <span
            className="fr-chart-tooltip-dot"
            style={{ background: String(entry.color) }}
          />
          {String(entry.name)}:{" "}
          <strong>
            {typeof entry.value === "number"
              ? entry.name === "contract_count"
                ? entry.value.toLocaleString()
                : formatEuro(entry.value)
              : String(entry.value)}
          </strong>
        </p>
      ))}
    </div>
  );
}

export function SpendByYearChart({ data }: { data: SpendByYear[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ left: 20, right: 12, top: 8, bottom: 4 }}>
        <defs>
          <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c96b52" />
            <stop offset="100%" stopColor="#b54a32" />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="year"
          tick={{ fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          yAxisId="left"
          tickFormatter={formatEuro}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={80}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar
          yAxisId="left"
          dataKey="total_amount"
          fill="url(#barGradient)"
          radius={[4, 4, 0, 0]}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="contract_count"
          stroke="#2d6a4f"
          strokeWidth={2.5}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function TopEntitiesChart({
  data,
  linkPrefix,
}: {
  data: TopEntity[];
  linkPrefix: string;
}) {
  const max = Math.max(...data.map((d) => d.total_amount), 1);

  return (
    <div className="fr-entity-list">
      {data.map((item) => (
        <Link
          key={item.id}
          href={`${linkPrefix}/${encodeURIComponent(item.id)}`}
          className="fr-entity-row"
        >
          <span className="fr-entity-name">{item.name}</span>
          <div className="fr-entity-bar">
            <div
              className="fr-entity-bar-fill"
              style={{ width: `${(item.total_amount / max) * 100}%` }}
            />
          </div>
          <span className="fr-entity-amount">{formatEuro(item.total_amount)}</span>
        </Link>
      ))}
    </div>
  );
}

export function ProcedureBreakdownChart({ data }: { data: ProcedureBreakdown[] }) {
  const total = data.reduce((sum, d) => sum + d.total_amount, 0);

  return (
    <div className="fr-procedure-chart">
      <PieChart width={200} height={200}>
        <Pie
          data={data}
          dataKey="total_amount"
          nameKey="procedure"
          innerRadius={50}
          outerRadius={80}
          stroke="none"
          paddingAngle={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={WARM_PALETTE[i % WARM_PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
      </PieChart>
      <div className="fr-procedure-legend">
        {data.map((item, i) => (
          <div key={item.procedure} className="fr-procedure-legend-row">
            <span
              className="fr-procedure-legend-dot"
              style={{ background: WARM_PALETTE[i % WARM_PALETTE.length] }}
            />
            <span className="fr-procedure-legend-label">{item.procedure}</span>
            <span className="fr-procedure-legend-pct">{item.pct.toFixed(1)}%</span>
            <span className="fr-procedure-legend-amount">
              {formatEuro(total * (item.pct / 100))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
