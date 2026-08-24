"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SOURCES, SOURCE_LABELS, type Source } from "@socialmonitor/shared";

/** Fixed slot per source — color follows the entity, never the rank (dataviz rule). */
const SOURCE_VAR: Record<Source, string> = {
  x: "var(--series-1)",
  reddit: "var(--series-2)",
  youtube: "var(--series-3)",
  telegram: "var(--series-4)",
  discord: "var(--series-5)",
};

const axisProps = {
  stroke: "var(--chart-baseline)",
  tick: { fill: "var(--chart-axis-ink)", fontSize: 11 },
  tickLine: false,
} as const;

const tooltipStyle = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--ink)",
} as const;

function Legend({ entries }: { entries: { label: string; color: string }[] }) {
  return (
    <div className="row" style={{ gap: 14, marginBottom: 6 }}>
      {entries.map((e) => (
        <span key={e.label} className="row" style={{ gap: 5, fontSize: 12, color: "var(--ink-secondary)" }}>
          <span className="badge-dot" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  );
}

export interface VolumePoint {
  day: string;
  [source: string]: string | number;
}

/** Stacked daily volume by source. Thin bars, rounded top data-end, surface gaps. */
export function VolumeChart({ data, sources }: { data: VolumePoint[]; sources: Source[] }) {
  const present = SOURCES.filter((s) => sources.includes(s));
  if (data.length === 0) return <p className="muted">No items yet.</p>;
  return (
    <div>
      <Legend entries={present.map((s) => ({ label: SOURCE_LABELS[s], color: SOURCE_VAR[s] }))} />
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} barCategoryGap="35%">
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="day" {...axisProps} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--chart-grid)", opacity: 0.4 }} />
          {present.map((s, i) => (
            <Bar
              key={s}
              dataKey={s}
              stackId="v"
              fill={SOURCE_VAR[s]}
              stroke="var(--chart-surface)"
              strokeWidth={1}
              radius={i === present.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface SentimentPoint {
  day: string;
  positive: number;
  negative: number;
  neutral: number;
}

/** Sentiment over time — diverging pair for polarity, gray for neutral. */
export function SentimentChart({ data }: { data: SentimentPoint[] }) {
  if (data.length === 0) return <p className="muted">No classified items yet.</p>;
  return (
    <div>
      <Legend
        entries={[
          { label: "positive", color: "var(--pos)" },
          { label: "negative", color: "var(--neg)" },
          { label: "neutral", color: "var(--chart-axis-ink)" },
        ]}
      />
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="day" {...axisProps} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey="positive" stroke="var(--pos)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          <Line type="monotone" dataKey="negative" stroke="var(--neg)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          <Line type="monotone" dataKey="neutral" stroke="var(--chart-axis-ink)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
