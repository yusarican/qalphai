import * as React from "react"
import { LockKeyholeIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Side, Verdict } from "@/lib/api"

/**
 * Verdict of the walk-forward gauntlet.
 *
 * Each verdict ships with its word, not just its colour — a deuteranope reading this
 * console must be able to tell ROBUST from FAILED, and the two hues sit close together
 * under simulated deuteranopia. The word is the carrier; the colour is the accelerant.
 */
export function VerdictBadge({
  verdict,
  className,
}: {
  verdict: Verdict | string | null | undefined
  className?: string
}) {
  if (!verdict) {
    return (
      <Badge variant="outline" className={cn("font-mono text-[10px]", className)}>
        NO VERDICT
      </Badge>
    )
  }

  const style =
    verdict === "ROBUST"
      ? "border-jade/40 bg-jade/12 text-jade-ink"
      : verdict === "FRAGILE"
        ? "border-amber/40 bg-amber/12 text-amber-ink"
        : "border-clay/40 bg-clay/12 text-clay-ink"

  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-mono text-[10px] tracking-wide", style, className)}
    >
      {verdict === "FRAGILE" ? <TriangleAlertIcon /> : null}
      {verdict === "FAILED" ? <ShieldAlertIcon /> : null}
      {verdict}
    </Badge>
  )
}

export function SideBadge({ side }: { side: Side }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[4px] px-1.5 font-mono text-[10px] font-medium tracking-wide",
        side === "LONG"
          ? "bg-jade/12 text-jade-ink"
          : "bg-clay/12 text-clay-ink"
      )}
    >
      {side}
    </span>
  )
}

/**
 * The one thing on this console that must never be misread: is the engine sending
 * real orders, or narrating what it would have done?
 *
 * Amber and a pulse are spent here and on the champion's identity, nowhere else. The
 * pulse only runs when orders are actually going out, so movement on the page always
 * carries the same meaning.
 */
export function LiveStateChip({
  liveTrading,
  testnet,
  hasKeys,
  className,
}: {
  liveTrading: boolean
  testnet: boolean
  hasKeys: boolean
  className?: string
}) {
  const sending = liveTrading && hasKeys

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "inline-flex h-7 cursor-default items-center gap-2 rounded-md border px-2.5",
              sending
                ? "border-amber/40 bg-amber/10"
                : "border-border bg-muted/40",
              className
            )}
          />
        }
      >
        <span className="relative flex size-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              sending ? "bg-amber-ink qa-pulse" : "bg-muted-foreground"
            )}
          />
        </span>
        <span
          className={cn(
            "font-mono text-[11px] font-medium tracking-wide",
            sending ? "text-amber-ink" : "text-muted-foreground"
          )}
        >
          {sending ? "SENDING ORDERS" : "DRY RUN"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {sending
          ? `The engine places real orders on Binance ${testnet ? "testnet" : "mainnet"}. Live trading is enabled on the server and API keys are present.`
          : !liveTrading
            ? "The engine evaluates every bar and logs what it would do, but places no orders. Enable it on the server with LIVE_TRADING=true — the console cannot switch it on."
            : "Live trading is enabled but no API keys are configured, so no order can be placed."}
      </TooltipContent>
    </Tooltip>
  )
}

export function NetworkChip({ testnet }: { testnet: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-7 cursor-default items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] tracking-wide",
              testnet
                ? "border-border bg-muted/40 text-muted-foreground"
                : "border-clay/40 bg-clay/10 text-clay-ink"
            )}
          />
        }
      >
        {!testnet ? <TriangleAlertIcon className="size-3" /> : null}
        {testnet ? "TESTNET" : "MAINNET"}
      </TooltipTrigger>
      <TooltipContent>
        {testnet
          ? "Binance futures testnet. Positions are simulated by the exchange; no real funds are at risk."
          : "Binance futures mainnet. Orders move real money."}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Marks a figure the engine could not measure. Used where an em dash alone would look
 * like a rendering bug rather than a deliberate refusal to guess.
 */
export function UnknownHint({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help font-mono text-muted-foreground underline decoration-dotted underline-offset-4" />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        Not measured. The engine reports no value here, so the console shows none — this
        is not a zero.
      </TooltipContent>
    </Tooltip>
  )
}

export function SealedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[3px] border border-dashed border-border px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-muted-foreground",
        className
      )}
    >
      <LockKeyholeIcon className="size-2.5" />
      SEALED
    </span>
  )
}
