"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  CartesianGrid,
  Line,
} from "recharts";
import Link from "next/link";
import type { SpendByYear, TopEntity, ProcedureBreakdown } from "@/lib/france/types";
import { formatEuro } from "@/lib/france/format";

const COLORS = [
  "var(--color-accent)",
  "var(--color-high)",
  "var(--color-medium)",
  "var(--color-speaker-1)",
  "var(--color-speaker-2)",
  "var(--color-speaker-3)",
  "var(--color-speaker-4)",
  "var(--color-speaker-5)",
];

export { formatEuro } from "@/lib/france/format";

export function SpendByYearChart({ data }: { data: SpendByYear[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="year" />
        <YAxis yAxisId="left" tickFormatter={formatEuro} />
        <YAxis yAxisId="right" orientation="right" />
        <Tooltip formatter={(value) => typeof value === "number" ? formatEuro(value) : value} />
        <Bar yAxisId="left" dataKey="total_amount" fill="var(--color-accent)" fillOpacity={0.7} />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="contract_count"
          stroke="var(--color-high)"
          strokeWidth={2}
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
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      {data.map((item) => (
        <Link
          key={item.id}
          href={`${linkPrefix}/${encodeURIComponent(item.id)}`}
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", textDecoration: "none", color: "inherit" }}
        >
          <span
            style={{
              minWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.name}
          </span>
          <div style={{ flex: 1, height: "1.2rem", background: "var(--color-surface)" }}>
            <div
              style={{
                width: `${(item.total_amount / max) * 100}%`,
                height: "100%",
                background: "var(--color-accent)",
                opacity: 0.6,
              }}
            />
          </div>
          <span style={{ width: 80, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {formatEuro(item.total_amount)}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function ProcedureBreakdownChart({ data }: { data: ProcedureBreakdown[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
      <PieChart width={200} height={200}>
        <Pie
          data={data}
          dataKey="total_amount"
          nameKey="procedure"
          innerRadius={50}
          outerRadius={80}
          stroke="var(--color-bg)"
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(value) => typeof value === "number" ? formatEuro(value) : value} />
      </PieChart>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {data.map((item, i) => (
          <div key={item.procedure} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <div
              style={{
                width: 10,
                height: 10,
                flexShrink: 0,
                background: COLORS[i % COLORS.length],
              }}
            />
            <span>{item.procedure}</span>
            <span style={{ opacity: 0.7 }}>{item.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
