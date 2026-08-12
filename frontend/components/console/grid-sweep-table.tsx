"use client"

import * as React from "react"
import { StarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { GridAxis, GridCellRow } from "@/lib/api"
import { DASH, int, num, pct, signedPct } from "@/lib/format"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { axisLabel, formatAxisValue } from "@/components/console/grid-heatmap"

const MAX_ROWS = 300

/**
 * Every swept combination, ranked the way the engine ranked them.
 *
 * The heatmap answers "where is the good region"; this table answers "why did that cell
 * win and not the one beside it". They disagree on purpose: the brightest test cell is
 * often not the top row here, because the score also pays for train agreement, trade
 * count, window consistency and a quiet neighbourhood. Seeing the two side by side is
 * what makes the selection rule inspectable instead of magic.
 *
 * Disqualified cells sink to the bottom rather than vanishing — a grid where most cells
 * died is a fact about the strategy, and hiding the corpses would flatter it.
 */
export function GridSweepTable({
  axes,
  cells,
  bestIndex,
}: {
  axes: GridAxis[]
  cells: GridCellRow[]
  bestIndex: number
}) {
  // Only axes that were actually swept get a column; a one-value axis is a constant.
  const sweptAxes = React.useMemo(
    () =>
      axes
        .map((a, axisIndex) => ({ axisIndex, name: a.name, values: a.values }))
        .filter((a) => a.values.length > 1),
    [axes]
  )

  const ranked = React.useMemo(() => {
    return cells
      .map((cell, index) => ({ cell, index }))
      .sort((a, b) => {
        const aDq = a.cell.dq !== null
        const bDq = b.cell.dq !== null
        if (aDq !== bDq) return aDq ? 1 : -1
        // Among the disqualified, score is null for everyone — fall back to test P&L so
        // the ordering is still meaningful rather than arbitrary.
        if (aDq) return b.cell.testPnlPct - a.cell.testPnlPct
        return (b.cell.score ?? 0) - (a.cell.score ?? 0)
      })
  }, [cells])

  if (cells.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This run swept a single cell, so there is nothing to rank.
      </p>
    )
  }

  const shown = ranked.slice(0, MAX_ROWS)
  const survivors = cells.filter((c) => c.dq === null).length

  return (
    <div className="flex flex-col">
      <div className="max-h-[560px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              {sweptAxes.map((a) => (
                <TableHead key={a.axisIndex} className="whitespace-nowrap">
                  {axisLabel(a.name)}
                </TableHead>
              ))}
              <TableHead className="text-right">Score</TableHead>
              <TableHead className="text-right">Test %</TableHead>
              <TableHead className="text-right">Windows</TableHead>
              <TableHead className="text-right">Test DD</TableHead>
              <TableHead className="text-right">Train %</TableHead>
              <TableHead className="text-right" title="Day-normalised test ÷ train P&L">
                T/T
              </TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Sharpe</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right" title="Disqualified cells in the neighbourhood">
                DQ nbrs
              </TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(({ cell, index }) => {
              const isBest = index === bestIndex
              const dead = cell.dq !== null
              return (
                <TableRow
                  key={index}
                  className={cn(isBest && "bg-amber/10", dead && "text-muted-foreground")}
                >
                  {sweptAxes.map((a) => (
                    <TableCell
                      key={a.axisIndex}
                      className="font-mono text-[12px] whitespace-nowrap"
                    >
                      {isBest && a.axisIndex === sweptAxes[0]?.axisIndex ? (
                        <StarIcon className="mr-1 inline size-3 text-amber-ink" />
                      ) : null}
                      {axisValueOf(a, cell)}
                    </TableCell>
                  ))}

                  <TableCell className="tnum text-right font-mono text-[13px] font-medium">
                    {cell.score === null ? DASH : num(cell.score, 2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "tnum text-right font-mono text-[13px]",
                      !dead && (cell.testPnlPct > 0 ? "text-jade-ink" : cell.testPnlPct < 0 ? "text-clay-ink" : "")
                    )}
                  >
                    {signedPct(cell.testPnlPct)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[12px]">
                    <WindowRatio positive={cell.windowsPositive} total={cell.windowCount} dead={dead} />
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[13px]">
                    {pct(cell.testDDPct)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                    {signedPct(cell.trainPnlPct)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                    {cell.testTrainRatio === null ? DASH : num(cell.testTrainRatio, 2)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                    {pct(cell.testWinRate)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                    {num(cell.testSharpe, 2)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                    {int(cell.testTrades)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "tnum text-right font-mono text-[13px]",
                      cell.dqNeighbors > 0 ? "text-amber-ink" : "text-muted-foreground"
                    )}
                  >
                    {int(cell.dqNeighbors)}
                  </TableCell>
                  <TableCell className="font-mono text-[11px] whitespace-nowrap">
                    {cell.dq ? (
                      <span className="text-clay-ink">{cell.dq}</span>
                    ) : (
                      <span className="text-jade-ink">✓</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <p className="border-t p-4 text-[11px] text-muted-foreground">
        {int(survivors)} of {int(cells.length)} combinations survived the hard filters
        {ranked.length > MAX_ROWS ? ` · showing the top ${int(MAX_ROWS)}` : ""}.
      </p>
    </div>
  )
}

/**
 * The value this cell sat at on one axis. An index the axis cannot explain renders as a
 * dash — a run stored before the engine kept indices should read as "unknown", never as
 * the first value on the axis, which would be a wrong number stated confidently.
 */
function axisValueOf(
  axis: { name: string; axisIndex: number; values: Array<number | boolean> },
  cell: GridCellRow
): string {
  const i = cell.idx[axis.axisIndex]
  if (i === undefined || i < 0 || i >= axis.values.length) return DASH
  return formatAxisValue(axis.name, axis.values[i]!)
}

/**
 * Windows positive, coloured by share rather than by count — 3/5 and 6/10 are the same
 * fact, and a reader scanning the column should not have to do the division.
 */
function WindowRatio({
  positive,
  total,
  dead,
}: {
  positive: number
  total: number
  dead: boolean
}) {
  if (total === 0) return <span className="text-muted-foreground">{DASH}</span>
  const share = positive / total
  return (
    <span
      className={cn(
        dead
          ? "text-muted-foreground"
          : share >= 0.75
            ? "text-jade-ink"
            : share >= 0.5
              ? "text-amber-ink"
              : "text-clay-ink"
      )}
    >
      {positive}/{total}
    </span>
  )
}
