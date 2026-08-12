import * as React from "react"
import { CircleSlashIcon, InboxIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { LiveStats, LivePosition, LoggedTrade } from "@/lib/api"
import {
  DASH,
  baseAsset,
  clock,
  dateTime,
  num,
  price,
  rMultiple,
  signedUsd,
  usd,
} from "@/lib/format"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SideBadge } from "@/components/console/status"

/** Numeric cells are right-aligned and tabular so the column reads as a column. */
const numCell = "tnum text-right font-mono text-[13px]"
const numHead = "text-right"

function pnlTone(v: number | null | undefined) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "text-muted-foreground"
  if (v > 0) return "text-jade-ink"
  if (v < 0) return "text-clay-ink"
  return "text-foreground"
}

/* --------------------------------------------------------------- positions --- */

export function PositionsTable({ positions }: { positions: LivePosition[] }) {
  if (positions.length === 0) {
    return (
      <Empty className="border-0 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>No open positions</EmptyTitle>
          <EmptyDescription>
            The champion holds nothing right now. Positions appear here the moment the
            engine opens one on a bar close.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead className={numHead}>Entry</TableHead>
            <TableHead className={numHead}>Mark</TableHead>
            <TableHead className={numHead}>Size</TableHead>
            <TableHead className={numHead}>Lev</TableHead>
            <TableHead className={numHead}>Margin</TableHead>
            <TableHead className={numHead}>Stop</TableHead>
            <TableHead className={numHead}>Risk</TableHead>
            <TableHead className={numHead}>Unrealized</TableHead>
            <TableHead className={numHead}>R</TableHead>
            <TableHead className={numHead}>Opened</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((p) => (
            <TableRow key={`${p.symbol}-${p.entryTime}`}>
              <TableCell className="font-mono text-[13px] font-medium">
                {baseAsset(p.symbol)}
              </TableCell>
              <TableCell>
                <SideBadge side={p.side} />
              </TableCell>
              <TableCell className={numCell}>{price(p.entryFill)}</TableCell>
              <TableCell className={cn(numCell, p.markPrice === null && "text-muted-foreground")}>
                {p.markPrice === null ? <UnreadableMark /> : price(p.markPrice)}
              </TableCell>
              <TableCell className={numCell}>{num(p.qtyBase, 4)}</TableCell>
              <TableCell className={numCell}>{p.leverage}×</TableCell>
              <TableCell className={numCell}>{usd(p.margin)}</TableCell>
              <TableCell className={cn(numCell, "text-muted-foreground")}>
                {price(p.initialStopPrice)}
              </TableCell>
              <TableCell className={numCell}>{usd(p.riskUSD)}</TableCell>
              <TableCell className={cn(numCell, pnlTone(p.unrealizedPnl))}>
                {p.unrealizedPnl === null ? DASH : signedUsd(p.unrealizedPnl)}
              </TableCell>
              <TableCell className={cn(numCell, pnlTone(p.rMultiple))}>
                {rMultiple(p.rMultiple)}
              </TableCell>
              <TableCell className={cn(numCell, "text-muted-foreground")}>
                {dateTime(p.entryTime)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function UnreadableMark() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-4" />}>
        {DASH}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        The exchange could not be read on the last poll, so there is no mark price for
        this position. The position itself is unaffected — only this figure is unknown.
      </TooltipContent>
    </Tooltip>
  )
}

/* ------------------------------------------------------------------ trades --- */

export function TradesTable({
  trades,
  limit = 25,
}: {
  trades: LoggedTrade[]
  limit?: number
}) {
  const rows = trades.slice(0, limit)

  if (rows.length === 0) {
    return (
      <Empty className="border-0 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleSlashIcon />
          </EmptyMedia>
          <EmptyTitle>No closed trades</EmptyTitle>
          <EmptyDescription>
            Nothing has closed yet. This ledger is append-only — once a trade lands here
            it stays, which is why the statistics above never shift under you.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Closed</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Exit</TableHead>
            <TableHead className={numHead}>Entry</TableHead>
            <TableHead className={numHead}>Lev</TableHead>
            <TableHead className={numHead}>Conf</TableHead>
            <TableHead className={numHead}>Risk</TableHead>
            <TableHead className={numHead}>Realized</TableHead>
            <TableHead className={numHead}>R</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t, i) => {
            const r =
              t.riskUSD > 0 && !t.pnlUnknown ? t.realizedPnl / t.riskUSD : null
            return (
              <TableRow
                key={`${t.symbol}-${t.exitTime}-${i}`}
                className={cn(t.dryRun && "opacity-60")}
              >
                <TableCell className="font-mono text-[12px] whitespace-nowrap text-muted-foreground">
                  <span className="text-foreground">{dateTime(t.exitTime)}</span>
                  <span className="ml-1.5">{clock(t.exitTime).slice(6)}</span>
                </TableCell>
                <TableCell className="font-mono text-[13px] font-medium">
                  <span className="flex items-center gap-1.5">
                    {baseAsset(t.symbol)}
                    {t.dryRun ? (
                      <Badge variant="outline" className="font-mono text-[9px]">
                        DRY
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <SideBadge side={t.side} />
                </TableCell>
                <TableCell>
                  <ExitReasonTag reason={t.reason} />
                </TableCell>
                <TableCell className={numCell}>{price(t.entryFill)}</TableCell>
                <TableCell className={numCell}>{t.leverage}×</TableCell>
                <TableCell className={cn(numCell, "text-muted-foreground")}>
                  {num(t.confidence, 2)}
                </TableCell>
                <TableCell className={cn(numCell, "text-muted-foreground")}>
                  {usd(t.riskUSD)}
                </TableCell>
                <TableCell
                  className={cn(
                    numCell,
                    t.pnlUnknown ? "text-muted-foreground" : pnlTone(t.realizedPnl)
                  )}
                >
                  {t.pnlUnknown ? <UnknownPnl /> : signedUsd(t.realizedPnl)}
                </TableCell>
                <TableCell className={cn(numCell, pnlTone(r))}>
                  {rMultiple(r)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function UnknownPnl() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-4" />}>
        {DASH}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        The exchange did not return a realized P&amp;L for this trade. It is excluded
        from every statistic above rather than counted as a loss — a guessed number
        would quietly bend the win rate.
      </TooltipContent>
    </Tooltip>
  )
}

function ExitReasonTag({ reason }: { reason: LoggedTrade["reason"] }) {
  const label =
    reason === "STOP" ? "Stop" : reason === "PROFIT" ? "Target" : "Signal"
  return (
    <span
      className={cn(
        "font-mono text-[11px]",
        reason === "PROFIT"
          ? "text-jade-ink"
          : reason === "STOP"
            ? "text-clay-ink"
            : "text-muted-foreground"
      )}
    >
      {label}
    </span>
  )
}

/* ------------------------------------------------------------- unknown note --- */

/**
 * Shown under the statistics whenever the ledger holds trades the exchange never
 * priced. It is deliberately loud: a win rate computed over 40 of 47 trades is a
 * different claim from one computed over all 47, and the reader is entitled to know
 * which one they are looking at.
 */
export function UnknownPnlNote({ stats }: { stats: LiveStats }) {
  if (stats.unknownPnlTrades === 0) return null
  return (
    <p className="text-[11px] text-muted-foreground">
      <span className="tnum font-mono text-foreground">
        {stats.unknownPnlTrades}
      </span>{" "}
      closed {stats.unknownPnlTrades === 1 ? "trade" : "trades"} had no readable P&amp;L
      and {stats.unknownPnlTrades === 1 ? "is" : "are"} excluded from every figure above.
    </p>
  )
}
