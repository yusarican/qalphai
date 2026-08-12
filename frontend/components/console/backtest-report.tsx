"use client"

import * as React from "react"
import { TriangleAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { BacktestResults, BacktestRunResult, GridSpec } from "@/lib/api"
import {
  DASH,
  compactUsd,
  dateTime,
  duration,
  humanizeRule,
  int,
  num,
  pct,
  profitFactor,
  signedPct,
  signedUsd,
  usd,
} from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EquityChart } from "@/components/console/equity-chart"
import { Eyebrow, Figure, SpecRow } from "@/components/console/figure"
import { GauntletLadder, gauntletFromWindows } from "@/components/console/gauntlet"
import { GridHeatmap } from "@/components/console/grid-heatmap"
import { GridSweepTable } from "@/components/console/grid-sweep-table"
import { SideBadge, VerdictBadge } from "@/components/console/status"
import { baseAsset } from "@/lib/format"

/**
 * The report for one backtest run.
 *
 * It leads with the gauntlet rather than with the headline return, because the
 * headline return is the least trustworthy number in the run — it includes the data
 * the parameters were fitted to. The metric grid underneath defaults to the test
 * slice for the same reason.
 */
export function BacktestReport({ run }: { run: BacktestRunResult }) {
  const equity = run.equityCurve.map((p) => ({
    timestamp: p.timestamp,
    value: p.balance,
  }))

  // Runs stored before the engine kept the grid, and runs that swept a single cell,
  // have no surface to draw. Both are legitimate — neither gets a fabricated one.
  const hasGrid = (run.cells?.length ?? 0) > 0 && (run.axes?.length ?? 0) > 0

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Run</Eyebrow>
              <CardTitle className="font-mono text-base">
                {run.strategyName}
              </CardTitle>
              <CardDescription className="font-mono text-[11px]">
                {run.id}
              </CardDescription>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <VerdictBadge verdict={run.verdict} />
              <p className="text-xs text-muted-foreground">
                {dateTime(run.startedAt)} · took {duration(run.durationMs)}
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <Spec label="Symbols" value={`${run.params.symbols.length}`} />
            <Spec label="Candle" value={run.params.interval} />
            <Spec label="Window" value={`${run.params.days} days`} />
            <Spec label="Profile" value={run.params.profile} />
            <Spec label="Start" value={usd(run.params.initialBalance, 0)} />
            <Spec label="Grid cells" value={int(run.gridCells)} />
            {run.params.noCosts ? (
              <Badge variant="outline" className="font-mono text-[9px]">
                COSTS OFF
              </Badge>
            ) : null}
            {run.params.fixedParams ? (
              <Badge variant="outline" className="font-mono text-[9px]">
                FIXED PARAMS
              </Badge>
            ) : null}
            {/*
              A run swept on a hand-edited grid is not comparable to one swept on the
              default, so it says so — otherwise two runs in the history list look like
              the same experiment with different luck.
            */}
            {run.params.grid ? (
              <Badge
                variant="outline"
                className="font-mono text-[9px]"
                title={gridSummary(run.params.grid)}
              >
                CUSTOM GRID
              </Badge>
            ) : null}
          </div>

          {run.fallbackUsed ? (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>No cell passed the scoring filters</AlertTitle>
              <AlertDescription>
                The engine fell back to the best effort in the grid. Treat this run as a
                measurement, not a candidate.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Eyebrow>The gauntlet</Eyebrow>
              <p className="text-xs text-muted-foreground">
                <span className="tnum font-mono text-foreground">
                  {int(run.best.windowsPositive)}/{int(run.best.windowCount)}
                </span>{" "}
                walk-forward windows positive ·{" "}
                <span className="tnum font-mono text-foreground">
                  {int(run.best.qualifiedNeighbors)}
                </span>{" "}
                qualifying neighbours
              </p>
            </div>
            <GauntletLadder rungs={gauntletFromWindows(run)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
          <CardDescription>
            The test slice is the default because it is the only window the parameter
            search never saw.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="test">
            <TabsList>
              <TabsTrigger value="test">Test slice</TabsTrigger>
              <TabsTrigger value="full">Full period</TabsTrigger>
              {run.stress ? <TabsTrigger value="stress">Stress</TabsTrigger> : null}
              {run.holdout ? <TabsTrigger value="holdout">Holdout</TabsTrigger> : null}
            </TabsList>

            <TabsContent value="test">
              <MetricGrid results={run.test} />
            </TabsContent>
            <TabsContent value="full">
              <MetricGrid results={run.full} />
            </TabsContent>
            {run.stress ? (
              <TabsContent value="stress">
                <MetricGrid results={run.stress} />
              </TabsContent>
            ) : null}
            {run.holdout ? (
              <TabsContent value="holdout">
                <MetricGrid results={run.holdout} />
              </TabsContent>
            ) : null}
          </Tabs>
        </CardContent>
      </Card>

      {equity.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Equity curve</CardTitle>
            <CardDescription>
              Mark-to-market over the full period, starting from{" "}
              {usd(run.params.initialBalance, 0)}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EquityChart
              data={equity}
              baseline={run.params.initialBalance}
              valueLabel="Balance"
              height={280}
            />
          </CardContent>
        </Card>
      ) : null}

      {hasGrid ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>P&amp;L surface</CardTitle>
              <CardDescription>
                Rows are the stop multiplier, columns the reward ratio. Train picks,
                test confirms — a plateau, a green region whose neighbours are also
                green, survives out of sample far more often than a lone bright cell.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GridHeatmap
                axes={run.axes!}
                cells={run.cells!}
                bestIndex={run.bestIndex ?? 0}
              />
            </CardContent>
          </Card>

          <Card className="gap-0 py-0">
            <CardHeader className="p-5">
              <CardTitle>Parameter sweep</CardTitle>
              <CardDescription>
                {int(run.gridCells)} combinations ranked by the engine&apos;s five-stage
                score — hard filters, MAR, a confidence factor for trade count and window
                consistency, then plateau pooling.
              </CardDescription>
            </CardHeader>
            <Separator />
            <GridSweepTable
              axes={run.axes!}
              cells={run.cells!}
              bestIndex={run.bestIndex ?? 0}
            />
          </Card>
        </>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Winning cell</CardTitle>
            <CardDescription>
              The parameter set the grid selected, and the risk settings it ran under.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {Object.entries(run.best.params).map(([k, v]) => (
              <SpecRow key={k} label={k} value={String(v)} />
            ))}
            <Separator />
            {Object.entries(run.best.risk).map(([k, v]) => (
              <SpecRow key={k} label={k} value={String(v)} />
            ))}
            <Separator />
            <SpecRow
              label="Plateau score"
              value={
                run.best.plateauScore === null
                  ? DASH
                  : num(run.best.plateauScore, 3)
              }
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>How trades ended</CardTitle>
            </CardHeader>
            <CardContent>
              <BarList
                items={run.exitReasons.map((r) => ({
                  label: humanizeRule(r.reason),
                  value: r.count,
                }))}
                emptyNote="No trade closed in this run."
              />
            </CardContent>
          </Card>

          {/*
            Why entries were NOT taken. A strategy that trades twice in six months is
            not obviously broken and not obviously conservative — this table is what
            tells the two apart.
          */}
          <Card>
            <CardHeader>
              <CardTitle>Why entries were skipped</CardTitle>
              <CardDescription>
                Strategy vetoes and harness rejections, by rule.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BarList
                items={run.skips.map((s) => ({
                  label: humanizeRule(s.rule),
                  value: s.count,
                }))}
                emptyNote="No entry was skipped."
              />
            </CardContent>
          </Card>

          {run.disqualifications.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Why grid cells were disqualified</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={run.disqualifications.map((d) => ({
                    label: d.label || humanizeRule(d.reason),
                    value: d.count,
                  }))}
                  emptyNote=""
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {run.trades.length > 0 ? (
        <Card className="gap-0 py-0">
          <CardHeader className="p-5">
            <CardTitle>Trades</CardTitle>
            <CardDescription>
              {int(run.trades.length)} in the full period, most recent first.
            </CardDescription>
          </CardHeader>
          <Separator />
          <div className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Closed</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Exit</TableHead>
                  <TableHead className="text-right">Lev</TableHead>
                  <TableHead className="text-right">Conf</TableHead>
                  <TableHead className="text-right">P&amp;L</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">R</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...run.trades]
                  .sort((a, b) => b.exitTime - a.exitTime)
                  .slice(0, 200)
                  .map((t, i) => (
                    <TableRow key={`${t.symbol}-${t.exitTime}-${i}`}>
                      <TableCell className="font-mono text-[12px] whitespace-nowrap text-muted-foreground">
                        {dateTime(t.exitTime)}
                      </TableCell>
                      <TableCell className="font-mono text-[13px] font-medium">
                        {baseAsset(t.symbol)}
                      </TableCell>
                      <TableCell>
                        <SideBadge side={t.side} />
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {humanizeRule(t.exitReason)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono text-[13px]">
                        {t.leverage}×
                      </TableCell>
                      <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                        {num(t.confidence, 2)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono text-[13px]",
                          t.pnl > 0
                            ? "text-jade-ink"
                            : t.pnl < 0
                              ? "text-clay-ink"
                              : ""
                        )}
                      >
                        {signedUsd(t.pnl)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tnum text-right font-mono text-[13px]",
                          t.pnlPercent > 0
                            ? "text-jade-ink"
                            : t.pnlPercent < 0
                              ? "text-clay-ink"
                              : ""
                        )}
                      >
                        {signedPct(t.pnlPercent)}
                      </TableCell>
                      <TableCell className="tnum text-right font-mono text-[13px] text-muted-foreground">
                        {t.pnlR === null ? DASH : `${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(2)}R`}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
          {run.trades.length > 200 ? (
            <>
              <Separator />
              <p className="p-4 text-[11px] text-muted-foreground">
                Showing the 200 most recent of {int(run.trades.length)}.
              </p>
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}

function MetricGrid({ results }: { results: BacktestResults }) {
  const r = results
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Figure
          label="Return"
          value={signedPct(r.totalPnlPercent)}
          tone={r.totalPnlPercent > 0 ? "up" : r.totalPnlPercent < 0 ? "down" : "flat"}
          size="lg"
          sub={signedUsd(r.totalPnl)}
        />
        <Figure label="CAGR" value={signedPct(r.cagr)} sub="annualised" />
        <Figure
          label="Max drawdown"
          value={pct(r.maxDrawdownPercent)}
          sub={usd(r.maxDrawdown)}
        />
        <Figure label="MAR" value={num(r.mar, 2)} sub="CAGR ÷ max drawdown" />
        <Figure label="Sharpe" value={num(r.sharpeRatio, 2)} sub="daily log returns" />
        <Figure label="Sortino" value={num(r.sortinoRatio, 2)} sub="downside only" />
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Figure
          label="Trades"
          value={int(r.totalTrades)}
          sub={`${int(r.winningTrades)}W / ${int(r.losingTrades)}L`}
        />
        <Figure label="Win rate" value={pct(r.winRate)} />
        <Figure label="Profit factor" value={profitFactor(r.profitFactor)} />
        <Figure
          label="Expectancy"
          value={`${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R`}
          tone={r.expectancyR > 0 ? "up" : r.expectancyR < 0 ? "down" : "flat"}
        />
        <Figure
          label="Cost share"
          value={pct(r.feeShareOfGross * 100)}
          /* Above half, the edge is going to the exchange rather than the account. */
          tone={r.feeShareOfGross > 0.5 ? "down" : "flat"}
          sub={`${usd(r.totalFeesUSD)} fees`}
        />
        <Figure label="Turnover" value={compactUsd(r.turnoverUSD)} sub="notional traded" />
      </div>

      {r.bestTrade || r.worstTrade ? (
        <p className="text-[11px] text-muted-foreground">
          {r.bestTrade ? (
            <>
              Best {baseAsset(r.bestTrade.symbol)}{" "}
              <span className="font-mono text-jade-ink">
                {signedUsd(r.bestTrade.pnl)}
              </span>
            </>
          ) : null}
          {r.bestTrade && r.worstTrade ? " · " : null}
          {r.worstTrade ? (
            <>
              Worst {baseAsset(r.worstTrade.symbol)}{" "}
              <span className="font-mono text-clay-ink">
                {signedUsd(r.worstTrade.pnl)}
              </span>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Magnitude bars. One hue, stepped by rank rather than coloured by identity — these
 * categories have no meaning attached to colour, only to size.
 */
function BarList({
  items,
  emptyNote,
}: {
  items: { label: string; value: number }[]
  emptyNote: string
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyNote}</p>
  }

  const sorted = [...items].sort((a, b) => b.value - a.value)
  const max = Math.max(...sorted.map((i) => i.value), 1)
  const total = sorted.reduce((s, i) => s + i.value, 0)

  return (
    <ul className="flex flex-col gap-2.5">
      {sorted.map((item, i) => (
        <li key={item.label} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate">{item.label}</span>
            {/*
              The share is dimmer than the count, but by using the muted ink token
              rather than an opacity on top of it — stacking opacity on an already
              recessive colour pushed it under the contrast floor.
            */}
            <span className="tnum shrink-0 font-mono">
              {int(item.value)}
              <span className="ml-1.5 text-muted-foreground">
                {pct((item.value / total) * 100, 0)}
              </span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (item.value / max) * 100)}%`,
                background: `var(--chart-${Math.min(5, i + 1)})`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function gridSummary(g: GridSpec): string {
  return [
    `RR ${g.rewardRatios.join(", ")}`,
    `SL× ${g.slMultipliers.join(", ")}`,
    `CB× ${g.callbackMultipliers.join(", ")}`,
    `risk ${g.riskPerTradePcts.map((r) => `${(r * 100).toFixed(2)}%`).join(", ")}`,
  ].join("\n")
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[12px]">{value}</span>
    </span>
  )
}
