"use client"

import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import { cn } from "@/lib/utils"
import { compactUsd, dateTime, signedUsd, usd } from "@/lib/format"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"

/**
 * One equity series over time.
 *
 * A single measure, so there is no legend — the panel title names it. The line takes
 * the diverging pair's colour from where the series ENDS relative to its baseline,
 * which is the question a reader actually asks of an equity curve ("are we up?").
 *
 * The zero/base reference line is always drawn and always neutral. Without it a curve
 * that never crossed into profit and one that never crossed into loss look identical.
 */

const config = {
  value: { label: "Equity" },
} satisfies ChartConfig

export interface EquityPoint {
  timestamp: number
  value: number
}

export function EquityChart({
  data,
  /** Cumulative-P&L curves are read against 0; balance curves against opening balance. */
  baseline = 0,
  valueLabel = "Cumulative P&L",
  height = 240,
  className,
}: {
  data: EquityPoint[]
  baseline?: number
  valueLabel?: string
  height?: number
  className?: string
}) {
  const gradientId = React.useId()

  /*
   * The engine can emit two points on the same bar timestamp (a close and a reopen
   * inside one candle). Two marks at the same x is not something a curve can draw —
   * it duplicates React keys and makes the time axis generate overlapping ticks — so
   * collapse to the last value seen at each timestamp, which is the state the bar
   * actually ended in.
   */
  const series = React.useMemo(() => {
    const byTime = new Map<number, number>()
    for (const p of data) byTime.set(p.timestamp, p.value)
    return [...byTime.entries()]
      .map(([timestamp, value]) => ({ timestamp, value }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }, [data])

  const last = series.length > 0 ? series[series.length - 1]!.value : baseline
  const up = last >= baseline
  const stroke = up ? "var(--jade)" : "var(--clay)"

  /*
   * Ticks are placed by us, evenly across the span, rather than left to the time
   * scale — which puts one at every data point and stacks them into an unreadable
   * smear when the series is short and unevenly spaced.
   */
  const { ticks, spansDays } = React.useMemo(() => {
    if (series.length === 0) return { ticks: [] as number[], spansDays: 0 }
    const first = series[0]!.timestamp
    const final = series[series.length - 1]!.timestamp
    const days = (final - first) / 86_400_000
    const count = Math.min(6, Math.max(2, series.length))
    const step = (final - first) / (count - 1)
    const out =
      final === first
        ? [first]
        : Array.from({ length: count }, (_, i) => Math.round(first + i * step))
    return { ticks: out, spansDays: days }
  }, [series])

  const formatTick = React.useCallback(
    (v: number) =>
      new Date(v).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        // Multi-year backtests need the year; a two-month window does not.
        ...(spansDays > 400 ? { year: "2-digit" as const } : {}),
      }),
    [spansDays]
  )

  // Recharts needs a numeric x for a time axis to space points by their real distance
  // rather than by index; an index axis would draw a quiet week the same width as a
  // busy hour.
  const domain = React.useMemo(() => {
    const values = series.map((d) => d.value).concat(baseline)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const pad = Math.max((max - min) * 0.12, Math.abs(baseline) * 0.01, 1)
    return [min - pad, max + pad] as [number, number]
  }, [series, baseline])

  return (
    <ChartContainer
      config={config}
      className={cn("w-full", className)}
      style={{ height }}
    >
      <AreaChart data={series} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid
          vertical={false}
          stroke="var(--hairline)"
          strokeDasharray="0"
        />

        <XAxis
          dataKey="timestamp"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          ticks={ticks}
          tickFormatter={formatTick}
          tickLine={false}
          axisLine={false}
          minTickGap={32}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
        />

        <YAxis
          domain={domain}
          width={56}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => compactUsd(v)}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
        />

        <ReferenceLine y={baseline} stroke="var(--border)" strokeWidth={1} />

        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const point = payload[0]!.payload as EquityPoint
            return (
              <div className="rounded-lg border bg-popover px-3 py-2 shadow-md">
                <div className="eyebrow mb-1">{dateTime(point.timestamp)}</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">
                    {valueLabel}
                  </span>
                  <span
                    className={cn(
                      "tnum font-mono text-sm font-medium",
                      point.value >= baseline ? "text-jade-ink" : "text-clay-ink"
                    )}
                  >
                    {baseline === 0
                      ? signedUsd(point.value)
                      : usd(point.value)}
                  </span>
                </div>
              </div>
            )
          }}
        />

        <Area
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{
            r: 4,
            fill: stroke,
            // A 2px surface ring keeps the active dot legible where it overlaps the fill.
            stroke: "var(--card)",
            strokeWidth: 2,
          }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
