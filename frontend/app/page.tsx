"use client"

import * as React from "react"
import { RefreshCwIcon, ServerCrashIcon } from "lucide-react"

import { API_BASE, api } from "@/lib/api"
import {
  DASH,
  int,
  pct,
  profitFactor,
  signedUsd,
  since,
  usd,
} from "@/lib/format"
import { usePoll, useNow } from "@/hooks/use-poll"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ChampionStrip } from "@/components/console/champion-strip"
import { EquityChart } from "@/components/console/equity-chart"
import { Eyebrow, Figure, SpecRow } from "@/components/console/figure"
import { RunLive } from "@/components/console/run-live"
import { PositionsTable, TradesTable, UnknownPnlNote } from "@/components/console/tables"

/**
 * The live console.
 *
 * Reads two endpoints on different clocks: /live carries positions and the ledger and
 * is polled often; /overview carries the champion record and the wallet and changes
 * rarely. Both hit the exchange, and the engine runs under a weight budget, so
 * "refresh everything every second" is not free — it competes with the live executor
 * for the same rate limit.
 */
export default function LivePage() {
  const overview = usePoll(() => api.overview(), 30_000)
  const live = usePoll(() => api.live(), 15_000)
  const now = useNow(15_000)

  const refreshAll = React.useCallback(() => {
    overview.refresh()
    live.refresh()
  }, [overview, live])

  // The engine is unreachable and we have nothing cached to show.
  if (!overview.data && !live.data && (overview.error || live.error)) {
    return <EngineOffline message={overview.error ?? live.error ?? ""} onRetry={refreshAll} />
  }

  if (!overview.data || !live.data) return <LiveSkeleton />

  const { champion, universe, disabled, balance, engine } = overview.data
  const stats = live.data.stats
  const positions = live.data.positions
  const lastRunAt = live.data.lastRunAt

  const equity = stats.equity.map((p) => ({
    timestamp: p.timestamp,
    value: p.cumulativePnl,
  }))

  const unrealized = positions.reduce<number | null>((sum, p) => {
    // One unreadable position makes the total unknown. Summing the readable ones and
    // calling it "unrealized P&L" would understate the book by a silent amount.
    if (sum === null || p.unrealizedPnl === null) return null
    return sum + p.unrealizedPnl
  }, 0)

  return (
    <div className="flex flex-col gap-6">
      {(overview.error || live.error) && (
        <Alert variant="destructive">
          <ServerCrashIcon />
          <AlertTitle>Showing the last good data</AlertTitle>
          <AlertDescription>
            {overview.error ?? live.error}. The figures below are from{" "}
            {since(live.lastUpdatedAt, now)}.
          </AlertDescription>
        </Alert>
      )}

      <ChampionStrip champion={champion} universe={universe} disabled={disabled} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle>Realized performance</CardTitle>
                  <CardDescription>
                    Closed trades only, from the append-only live ledger.
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={refreshAll}
                  disabled={live.refreshing}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {live.refreshing ? "Refreshing" : "Refresh"}
                </Button>
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
                <Figure
                  label="Realized P&L"
                  value={stats.totalTrades > 0 ? signedUsd(stats.totalPnl) : DASH}
                  tone={stats.totalPnl > 0 ? "up" : stats.totalPnl < 0 ? "down" : "flat"}
                  size="lg"
                  sub={`${int(stats.totalTrades)} closed`}
                />
                <Figure
                  label="Win rate"
                  value={stats.totalTrades > 0 ? pct(stats.winRate) : DASH}
                  sub={
                    stats.totalTrades > 0
                      ? `${int(stats.winningTrades)}W / ${int(stats.losingTrades)}L`
                      : "no closed trades"
                  }
                />
                <Figure
                  label="Profit factor"
                  value={stats.totalTrades > 0 ? profitFactor(stats.profitFactor) : DASH}
                  sub="gross profit ÷ gross loss"
                />
                <Figure
                  label="Expectancy"
                  value={
                    stats.totalTrades > 0
                      ? `${stats.expectancyR >= 0 ? "+" : ""}${stats.expectancyR.toFixed(2)}R`
                      : DASH
                  }
                  tone={stats.expectancyR > 0 ? "up" : stats.expectancyR < 0 ? "down" : "flat"}
                  sub="per trade, in units of risk"
                />
                <Figure
                  label="Open risk"
                  value={
                    positions.length > 0
                      ? usd(positions.reduce((s, p) => s + p.riskUSD, 0))
                      : DASH
                  }
                  sub={`${int(positions.length)} position${positions.length === 1 ? "" : "s"}`}
                />
              </div>

              <UnknownPnlNote stats={stats} />

              <Separator />

              {equity.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <Eyebrow>Cumulative realized P&amp;L</Eyebrow>
                  <EquityChart data={equity} baseline={0} />
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  The equity curve starts at the first closed trade.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Account</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {/*
                No keys means no account to read — an explicit statement, not a $0.00
                wallet that would read as a funded-but-empty account.
              */}
              {!engine.hasKeys ? (
                <p className="text-xs text-muted-foreground">
                  No exchange keys configured, so there is no account to read.
                </p>
              ) : balance === null ? (
                <p className="text-xs text-muted-foreground">
                  The exchange could not be reached on the last poll. Balance unknown.
                </p>
              ) : (
                <>
                  <SpecRow label="Wallet" value={usd(balance.totalWalletBalance)} />
                  <SpecRow label="Available" value={usd(balance.availableBalance)} />
                  <SpecRow
                    label="In margin"
                    value={usd(
                      balance.totalWalletBalance - balance.availableBalance
                    )}
                  />
                </>
              )}
              <Separator />
              <SpecRow
                label="Unrealized"
                value={unrealized === null ? DASH : signedUsd(unrealized)}
                tone={
                  unrealized === null
                    ? "flat"
                    : unrealized > 0
                      ? "up"
                      : unrealized < 0
                        ? "down"
                        : "flat"
                }
              />
              <SpecRow label="Open positions" value={int(positions.length)} />
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Engine</CardTitle>
              <CardDescription className="text-xs">
                Last bar evaluated {since(lastRunAt, now)}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <RunLive onComplete={refreshAll} />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                The engine already runs itself on every candle close. This button asks
                it to evaluate the current bar immediately — useful for a demo, not
                required for it to trade.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="p-5">
          <CardTitle>Open positions</CardTitle>
          <CardDescription>
            Size and stop come from the engine&apos;s ledger; mark price and unrealized
            P&amp;L come from the exchange.
          </CardDescription>
        </CardHeader>
        <Separator />
        <PositionsTable positions={positions} />
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="p-5">
          <CardTitle>Closed trades</CardTitle>
          <CardDescription>
            The 25 most recent, newest first.
          </CardDescription>
        </CardHeader>
        <Separator />
        <TradesTable trades={live.data.trades} limit={25} />
      </Card>
    </div>
  )
}

function EngineOffline({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-16">
      <Alert variant="destructive">
        <ServerCrashIcon />
        <AlertTitle>The engine is not answering</AlertTitle>
        <AlertDescription>
          <p>{message}</p>
          <p>
            The console reads everything from the engine and computes nothing on its
            own, so there is nothing to show until it is running.
          </p>
        </AlertDescription>
      </Alert>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Start the engine</CardTitle>
          <CardDescription className="text-xs">
            From the repository root:
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
            npm run dev
          </pre>
          <p className="text-xs text-muted-foreground">
            The console expects it at{" "}
            <span className="font-mono text-foreground">{API_BASE}</span>. Point it
            elsewhere with{" "}
            <span className="font-mono text-foreground">NEXT_PUBLIC_API_URL</span>.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry} className="self-start">
            <RefreshCwIcon data-icon="inline-start" />
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function LiveSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-64 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-96 w-full rounded-xl" />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-52 w-full rounded-xl" />
        </div>
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  )
}
