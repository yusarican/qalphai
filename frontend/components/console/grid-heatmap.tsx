"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { GridAxis, GridCellRow } from "@/lib/api"
import { signedPct } from "@/lib/format"

/**
 * The parameter grid, drawn.
 *
 * Rows are the stop multiplier, columns the reward ratio, and the callback multiplier
 * opens a panel per value — TRAIN beside TEST, so a cell that only works on the data it
 * was fitted to is visible as a bright square with a dull twin.
 *
 * The point of the picture is not to find the brightest cell. It is to find the
 * neighbourhood: a lone bright square surrounded by dull ones is a cell that got lucky
 * on a handful of trades, and the engine's plateau score deliberately refuses to pick
 * it. Reading the map is how an operator checks that refusal was right.
 *
 * Any axis that is not row, column or panel becomes a page — risk per trade first,
 * because it is the axis that moves drawdown the most and therefore the one worth
 * stepping through by hand.
 */

const COL_AXIS = "rewardRatio"
const ROW_AXIS = "slMultiplier"
const PANEL_AXIS = "callbackMultiplier"

/** Risk per trade leads the pagers; the rest follow in the order the engine swept them. */
const PAGE_AXIS_ORDER = ["riskPerTradePct"]

export function GridHeatmap({
  axes,
  cells,
  bestIndex,
}: {
  axes: GridAxis[]
  cells: GridCellRow[]
  bestIndex: number
}) {
  const layout = React.useMemo(() => buildLayout(axes), [axes])

  /*
   * One selected index per page axis. Seeded from the winning cell rather than from
   * zero: the map opens on the page the engine actually chose, so the first thing the
   * operator sees is the neighbourhood the verdict came from.
   */
  const best = cells[bestIndex]
  const [page, setPage] = React.useState<Record<number, number>>(() => {
    const seed: Record<number, number> = {}
    for (const p of layout?.pageAxes ?? []) seed[p.axisIndex] = best?.idx[p.axisIndex] ?? 0
    return seed
  })

  if (!layout) {
    return (
      <p className="text-xs text-muted-foreground">
        This run swept a single cell, so there is no surface to draw. Turn off &ldquo;use
        the champion&apos;s parameters&rdquo; to sweep a grid.
      </p>
    )
  }

  const { rowAxis, colAxis, panelAxis, pageAxes } = layout

  // Cells on the current page, keyed by their row/col/panel position. A role with no
  // real axis behind it (the single-dimension fallback) collapses to slot 0 on both
  // sides of the lookup rather than indexing at -1 and matching nothing.
  const slot = (cell: GridCellRow, role: AxisRole | null) =>
    role && role.axisIndex >= 0 ? (cell.idx[role.axisIndex] ?? 0) : 0

  const onPage = new Map<string, { cell: GridCellRow; index: number }>()
  cells.forEach((cell, index) => {
    for (const p of pageAxes) {
      if (cell.idx[p.axisIndex] !== (page[p.axisIndex] ?? 0)) return
    }
    onPage.set(`${slot(cell, panelAxis)}:${slot(cell, rowAxis)}:${slot(cell, colAxis)}`, {
      cell,
      index,
    })
  })

  /*
   * Colour is normalised across everything on the page — both slices, every panel — so
   * the eye can compare a TRAIN square against its TEST twin. Normalising each panel
   * separately would make every panel look equally good.
   */
  let maxAbs = 0
  for (const { cell } of onPage.values()) {
    maxAbs = Math.max(maxAbs, Math.abs(cell.trainPnlPct), Math.abs(cell.testPnlPct))
  }
  if (maxAbs === 0) maxAbs = 1

  const panelValues = panelAxis ? panelAxis.values : [null]

  return (
    <div className="flex flex-col gap-5">
      {pageAxes.length > 0 ? (
        <div className="flex flex-col gap-3">
          {pageAxes.map((p) => (
            <AxisPager
              key={p.axisIndex}
              axis={p}
              value={page[p.axisIndex] ?? 0}
              bestValue={best?.idx[p.axisIndex] ?? -1}
              onChange={(i) => setPage((prev) => ({ ...prev, [p.axisIndex]: i }))}
            />
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        {panelValues.map((panelValue, panelIdx) => (
          <div key={panelIdx} className="flex flex-col gap-3">
            {panelAxis ? (
              <p className="eyebrow">
                {axisLabel(panelAxis.name)} {formatAxisValue(panelAxis.name, panelValue!)}
              </p>
            ) : null}
            <div className="grid gap-x-8 gap-y-5 xl:grid-cols-2">
              {(["train", "test"] as const).map((slice) => (
                <Panel
                  key={slice}
                  slice={slice}
                  rowAxis={rowAxis}
                  colAxis={colAxis}
                  maxAbs={maxAbs}
                  bestIndex={bestIndex}
                  lookup={(r, c) => onPage.get(`${panelIdx}:${r}:${c}`)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <Legend maxAbs={maxAbs} />
    </div>
  )
}

/* --------------------------------------------------------------------- panel --- */

function Panel({
  slice,
  rowAxis,
  colAxis,
  maxAbs,
  bestIndex,
  lookup,
}: {
  slice: "train" | "test"
  rowAxis: AxisRole
  colAxis: AxisRole
  maxAbs: number
  bestIndex: number
  lookup: (row: number, col: number) => { cell: GridCellRow; index: number } | undefined
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] font-medium tracking-wide">
          {slice === "train" ? "TRAIN" : "TEST"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {slice === "train" ? "chooses" : "confirms"}
        </span>
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full border-separate border-spacing-[3px]">
          <thead>
            <tr>
              <th className="w-14" />
              {colAxis.values.map((v, c) => (
                <th
                  key={c}
                  scope="col"
                  className="pb-0.5 font-mono text-[10px] font-normal text-muted-foreground"
                >
                  {axisShort(colAxis.name)} {formatAxisValue(colAxis.name, v)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowAxis.values.map((rv, r) => (
              <tr key={r}>
                <th
                  scope="row"
                  className="pr-1.5 text-right font-mono text-[10px] font-normal whitespace-nowrap text-muted-foreground"
                >
                  {axisShort(rowAxis.name)} {formatAxisValue(rowAxis.name, rv)}
                </th>
                {colAxis.values.map((_, c) => {
                  const hit = lookup(r, c)
                  return (
                    <Cell
                      key={c}
                      cell={hit?.cell}
                      isBest={hit?.index === bestIndex}
                      value={
                        hit ? (slice === "train" ? hit.cell.trainPnlPct : hit.cell.testPnlPct) : null
                      }
                      maxAbs={maxAbs}
                    />
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Cell({
  cell,
  value,
  maxAbs,
  isBest,
}: {
  cell: GridCellRow | undefined
  value: number | null
  maxAbs: number
  isBest: boolean
}) {
  if (!cell || value === null) {
    return <td className="h-9 rounded-md bg-muted/40" />
  }

  const t = Math.max(-1, Math.min(1, value / maxAbs))
  const disqualified = cell.dq !== null

  return (
    <td
      /*
       * A disqualified cell keeps its number but loses its colour. Hiding it entirely
       * would leave a hole in the surface and make the plateau look wider than it is —
       * the operator needs to see that the bright region is bordered by dead ground.
       */
      className={cn(
        "h-9 rounded-md px-1.5 text-center align-middle font-mono text-[11px] font-medium tabular-nums",
        disqualified && "opacity-45",
        isBest && "outline-2 outline-offset-[-2px] outline-amber-ink"
      )}
      style={{ background: heatColor(t), color: Math.abs(t) > 0.55 ? "#0a0d13" : undefined }}
      title={cellTitle(cell)}
    >
      {signedPct(value, 1)}
    </td>
  )
}

/**
 * Diverging fill. Clay for loss, jade for gain, mixed toward the card surface rather
 * than toward white so the ramp holds up on the console's dark ground.
 */
function heatColor(t: number): string {
  if (t === 0) return "var(--muted)"
  const hue = t > 0 ? "var(--jade)" : "var(--clay)"
  const strength = Math.round(Math.abs(t) * 74)
  return `color-mix(in oklab, ${hue} ${strength}%, var(--card))`
}

function cellTitle(c: GridCellRow): string {
  const parts = [
    `train ${signedPct(c.trainPnlPct, 1)} · test ${signedPct(c.testPnlPct, 1)}`,
    `test DD ${c.testDDPct.toFixed(1)}% · ${c.testTrades} trades`,
    `windows ${c.windowsPositive}/${c.windowCount}`,
  ]
  if (c.dq) parts.push(`disqualified: ${c.dq}`)
  else if (c.score !== null) parts.push(`score ${c.score.toFixed(2)}`)
  return parts.join("\n")
}

function Legend({ maxAbs }: { maxAbs: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="tnum font-mono">-{maxAbs.toFixed(0)}%</span>
        <span
          className="h-2.5 w-28 rounded-full"
          style={{
            background: `linear-gradient(to right, ${heatColor(-1)}, ${heatColor(0)}, ${heatColor(1)})`,
          }}
        />
        <span className="tnum font-mono">+{maxAbs.toFixed(0)}%</span>
      </div>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] outline-2 outline-offset-[-2px] outline-amber-ink" />
        selected cell
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-muted opacity-45" />
        disqualified
      </span>
    </div>
  )
}

/* ---------------------------------------------------------------------- pager --- */

function AxisPager({
  axis,
  value,
  bestValue,
  onChange,
}: {
  axis: AxisRole
  value: number
  bestValue: number
  onChange: (index: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="eyebrow">{axisLabel(axis.name)}</span>
      <div className="flex flex-wrap items-center gap-1">
        {axis.values.map((v, i) => {
          const active = i === value
          return (
            <button
              key={i}
              type="button"
              onClick={() => onChange(i)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "relative rounded-md border px-2.5 py-1 font-mono text-[11px] tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {formatAxisValue(axis.name, v)}
              {/*
                The page the engine's winner sits on is marked, so stepping away from it
                and back does not require remembering which one it was.
              */}
              {i === bestValue ? (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 size-1.5 rounded-full bg-amber-ink"
                />
              ) : null}
            </button>
          )
        })}
      </div>
      {bestValue >= 0 && value !== bestValue ? (
        <span className="text-[10px] text-muted-foreground">
          not the page the winner is on
        </span>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------------- layout --- */

export interface AxisRole {
  axisIndex: number
  name: string
  values: Array<number | boolean>
}

interface Layout {
  rowAxis: AxisRole
  colAxis: AxisRole
  panelAxis: AxisRole | null
  pageAxes: AxisRole[]
}

/**
 * Decides which axis becomes rows, columns, panels and pages.
 *
 * Named axes take their usual seats so the map is the same shape run to run. Anything
 * with a single value is dropped from the layout entirely — a one-value axis is not a
 * dimension, and rendering a pager for it would offer a choice that does not exist.
 */
function buildLayout(axes: GridAxis[]): Layout | null {
  const roles: AxisRole[] = axes
    .map((a, axisIndex) => ({ axisIndex, name: a.name, values: a.values }))
    .filter((a) => a.values.length > 1)

  if (roles.length === 0) return null

  const take = (name: string) => {
    const i = roles.findIndex((r) => r.name === name)
    return i === -1 ? null : roles.splice(i, 1)[0]!
  }

  // Fall back to the widest remaining axes when the run does not have the usual names
  // (a Codex candidate can name its parameters anything).
  const widest = () => {
    if (roles.length === 0) return null
    let bestI = 0
    for (let i = 1; i < roles.length; i++) {
      if (roles[i]!.values.length > roles[bestI]!.values.length) bestI = i
    }
    return roles.splice(bestI, 1)[0]!
  }

  const colAxis = take(COL_AXIS) ?? widest()
  const rowAxis = take(ROW_AXIS) ?? widest()
  if (!colAxis) return null
  if (!rowAxis) {
    // A single dimension still draws: one row, the column axis across.
    return {
      rowAxis: { axisIndex: -1, name: "", values: [0] },
      colAxis,
      panelAxis: null,
      pageAxes: [],
    }
  }

  const panelAxis = take(PANEL_AXIS)

  const pageAxes = roles.sort((a, b) => {
    const ai = PAGE_AXIS_ORDER.indexOf(a.name)
    const bi = PAGE_AXIS_ORDER.indexOf(b.name)
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    return a.axisIndex - b.axisIndex
  })

  return { rowAxis, colAxis, panelAxis, pageAxes }
}

/* ------------------------------------------------------------------ labelling --- */

const AXIS_LABELS: Record<string, string> = {
  rewardRatio: "Reward ratio",
  slMultiplier: "Stop × ATR",
  callbackMultiplier: "Callback × ATR",
  riskPerTradePct: "Risk per trade",
  entryThreshold: "Entry threshold",
  minConfidence: "Min confidence",
  minVolumeRatio: "Min volume ratio",
  confirmationCandles: "Confirmation candles",
  requireDirectionalDi: "Directional DI",
  btcRegimeFilter: "BTC regime filter",
}

const AXIS_SHORT: Record<string, string> = {
  rewardRatio: "RR",
  slMultiplier: "SL×",
  callbackMultiplier: "CB×",
  riskPerTradePct: "risk",
}

export function axisLabel(name: string): string {
  return AXIS_LABELS[name] ?? name
}

function axisShort(name: string): string {
  return AXIS_SHORT[name] ?? name
}

export function formatAxisValue(name: string, v: number | boolean): string {
  if (typeof v === "boolean") return v ? "on" : "off"
  // Risk per trade is stored as a fraction; showing 0.035 where the operator thinks in
  // percent is how a 3.5% grid gets mistaken for a 0.035% one.
  if (name === "riskPerTradePct") return `${(v * 100).toFixed(v * 100 < 1 ? 2 : 1)}%`
  return String(v)
}
