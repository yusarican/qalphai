import * as React from "react"

import { cn } from "@/lib/utils"
import { DASH, pct, signedPct } from "@/lib/format"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * THE GAUNTLET LADDER — this console's signature.
 *
 * Every strategy in this system is judged on four windows of increasing severity, and
 * the whole argument for trusting a number rests on WHICH window produced it. A single
 * headline "return %" hides that completely: the same +40% means "we fit the data" on
 * the full period and "this might actually work" on the sealed holdout.
 *
 * So the four are always drawn together, in severity order, on one shared scale, with
 * a common zero baseline. The shape of the ladder is the finding — a run that earns
 * its money only on the left and collapses to the right is overfit, and you can see
 * that across the room without reading a digit.
 *
 * The rung labels say what each window WITHHOLDS rather than numbering them 01–04.
 * The withholding is the information; the ordinal would just be decoration.
 *
 * Colour is the diverging pair (jade above zero, clay below) on a neutral midpoint —
 * validated against the panel surface for CVD separation. Every rung is direct
 * labelled, so identity never rests on colour alone.
 */

export interface GauntletRung {
  key: string
  label: string
  /** What this window holds back from the strategy. */
  withholds: string
  pnlPct: number | null
  maxDDPct?: number | null
  trades?: number | null
  /** The window no part of the selection path was allowed to see. */
  sealed?: boolean
  /** Shown when the engine did not produce this window at all. */
  missingNote?: string
}

export function GauntletLadder({
  rungs,
  className,
  height = 88,
}: {
  rungs: GauntletRung[]
  className?: string
  height?: number
}) {
  const values = rungs
    .map((r) => r.pnlPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))

  // One scale for all four. Scaling each rung to itself would make a +2% window and a
  // +60% window draw the same bar, which is the exact comparison this chart exists for.
  const max = Math.max(1, ...values.map((v) => Math.abs(v)))

  return (
    <div className={cn("overflow-hidden rounded-lg bg-hairline", className)}>
      {/*
        auto-fit rather than a fixed column count: the ladder is used with three rungs
        (a promotion record) and four (a backtest run), and it reflows on narrow
        screens without either case leaving a hole in the grid.
      */}
      <div
        className="grid gap-px"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))" }}
      >
        {rungs.map((rung) => (
          <Rung key={rung.key} rung={rung} max={max} height={height} />
        ))}
      </div>
    </div>
  )
}

function Rung({
  rung,
  max,
  height,
}: {
  rung: GauntletRung
  max: number
  height: number
}) {
  const v = rung.pnlPct
  const has = typeof v === "number" && Number.isFinite(v)
  const up = has && v >= 0
  // Half the plot is above the baseline, half below — so the bar can only ever use 50%.
  const magnitude = has ? Math.min(1, Math.abs(v) / max) : 0

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex cursor-default flex-col gap-2.5 bg-card px-3 py-3 text-left transition-colors hover:bg-muted/40",
              rung.sealed && "bg-card/60"
            )}
          />
        }
      >
        <div className="flex items-center gap-1.5">
          <span className="eyebrow truncate">{rung.label}</span>
          {rung.sealed ? (
            <span
              aria-hidden
              className="rounded-[3px] border border-dashed border-border px-1 font-mono text-[9px] leading-[14px] text-muted-foreground"
            >
              SEALED
            </span>
          ) : null}
        </div>

        <div className="relative w-full" style={{ height }} aria-hidden>
          {/* Zero baseline — neutral, never a hue. */}
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
          {has ? (
            <div
              className={cn(
                "absolute left-1/2 w-7 -translate-x-1/2",
                up ? "bottom-1/2 rounded-t-[3px]" : "top-1/2 rounded-b-[3px]",
                up ? "bg-jade" : "bg-clay"
              )}
              style={{ height: `${Math.max(2, magnitude * 50)}%` }}
            />
          ) : (
            <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
              <span className="bg-card px-2 font-mono text-sm text-muted-foreground">
                {DASH}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-0.5">
          <span
            className={cn(
              "tnum font-mono text-sm leading-none font-medium",
              !has
                ? "text-muted-foreground"
                : up
                  ? "text-jade-ink"
                  : "text-clay-ink"
            )}
          >
            {signedPct(v)}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {has ? rung.withholds : (rung.missingNote ?? "not measured")}
          </span>
        </div>
      </TooltipTrigger>

      <TooltipContent className="max-w-64">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{rung.label}</span>
          <span className="text-xs opacity-80">{rung.withholds}</span>
          <div className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
            <span>Return {signedPct(v)}</span>
            {rung.maxDDPct != null ? <span>Max drawdown {pct(rung.maxDDPct)}</span> : null}
            {rung.trades != null ? <span>{rung.trades} trades</span> : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Rungs from a promotion record.
 *
 * Three rather than four: the promotion record keeps the windows the gate actually
 * weighed, and the full period is not one of them — a strategy is never promoted for
 * what it did on the data it was fitted to. Drawing an empty "full period" rung here
 * would imply the engine measured something it deliberately ignores.
 */
export function gauntletFromEvaluation(evaluation: {
  testPnlPct: number
  testMaxDDPct: number
  testTrades: number
  stressPnlPct: number
  holdoutPnlPct: number
  holdoutMaxDDPct: number
}): GauntletRung[] {
  return [
    {
      key: "test",
      label: "Test slice",
      withholds: "unseen by parameter fit",
      pnlPct: evaluation.testPnlPct,
      maxDDPct: evaluation.testMaxDDPct,
      trades: evaluation.testTrades,
    },
    {
      key: "stress",
      label: "Stress",
      withholds: "fees ×1.5, slippage ×2",
      pnlPct: evaluation.stressPnlPct,
    },
    {
      key: "holdout",
      label: "Holdout",
      withholds: "unseen by every selection step",
      pnlPct: evaluation.holdoutPnlPct,
      maxDDPct: evaluation.holdoutMaxDDPct,
      sealed: true,
    },
  ]
}

/**
 * Builds the four rungs from an engine evaluation record or a backtest result. Kept
 * here so the champion header and the backtest report cannot drift into describing the
 * same four windows differently.
 */
export function gauntletFromWindows(input: {
  full?: { totalPnlPercent: number; maxDrawdownPercent: number; totalTrades: number } | null
  test?: { totalPnlPercent: number; maxDrawdownPercent: number; totalTrades: number } | null
  stress?: { totalPnlPercent: number; maxDrawdownPercent: number; totalTrades: number } | null
  holdout?: { totalPnlPercent: number; maxDrawdownPercent: number; totalTrades: number } | null
}): GauntletRung[] {
  return [
    {
      key: "full",
      label: "Full period",
      withholds: "nothing — fit and test",
      pnlPct: input.full?.totalPnlPercent ?? null,
      maxDDPct: input.full?.maxDrawdownPercent ?? null,
      trades: input.full?.totalTrades ?? null,
    },
    {
      key: "test",
      label: "Test slice",
      withholds: "unseen by parameter fit",
      pnlPct: input.test?.totalPnlPercent ?? null,
      maxDDPct: input.test?.maxDrawdownPercent ?? null,
      trades: input.test?.totalTrades ?? null,
    },
    {
      key: "stress",
      label: "Stress",
      withholds: "fees ×1.5, slippage ×2",
      pnlPct: input.stress?.totalPnlPercent ?? null,
      maxDDPct: input.stress?.maxDrawdownPercent ?? null,
      trades: input.stress?.totalTrades ?? null,
      missingNote: "stress not run",
    },
    {
      key: "holdout",
      label: "Holdout",
      withholds: "unseen by every selection step",
      pnlPct: input.holdout?.totalPnlPercent ?? null,
      maxDDPct: input.holdout?.maxDrawdownPercent ?? null,
      trades: input.holdout?.totalTrades ?? null,
      sealed: true,
      missingNote: "no holdout window",
    },
  ]
}
