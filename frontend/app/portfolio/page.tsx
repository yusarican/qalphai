"use client"

import * as React from "react"
import { InfoIcon, RotateCcwIcon, SaveIcon, ServerCrashIcon } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { api, type PortfolioAsset, type PortfolioView } from "@/lib/api"
import {
  DASH,
  baseAsset,
  compactUsd,
  dateTime,
  int,
  pct,
  price,
  signedPct,
  signedUsd,
} from "@/lib/format"
import { usePoll } from "@/hooks/use-poll"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ChampionLine } from "@/components/console/champion-strip"
import { Eyebrow, SpecRow } from "@/components/console/figure"

/**
 * Portfolio — which of the champion's symbols may take new entries.
 *
 * The universe is the set the champion was measured on, and this page can only ever
 * NARROW it. There is no "add symbol" control, because adding one would put money into
 * a market the backtest never looked at while the console kept displaying that
 * backtest's numbers as if they still applied.
 *
 * Switching a symbol off means "take no new entry here". It does not close anything:
 * an open position keeps being managed to its stop or target, which is why the save
 * response calls out positions still open on symbols that were just switched off.
 */
export default function PortfolioPage() {
  const { data, error, loading, refresh } = usePoll(() => api.portfolio(), 30_000)

  // Local edit state. Seeded from the engine, then owned by the operator until saved
  // or reverted — a poll landing mid-edit must not silently undo a toggle.
  const [draft, setDraft] = React.useState<Set<string> | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [openOnDisabled, setOpenOnDisabled] = React.useState<
    { symbol: string; side: string }[]
  >([])

  const serverDisabled = React.useMemo(
    () => new Set(data?.disabled ?? []),
    [data?.disabled]
  )

  const disabled = draft ?? serverDisabled
  const dirty =
    draft !== null &&
    (draft.size !== serverDisabled.size ||
      [...draft].some((s) => !serverDisabled.has(s)))

  function toggle(symbol: string, enabled: boolean) {
    const next = new Set(disabled)
    if (enabled) next.delete(symbol)
    else next.add(symbol)
    setDraft(next)
  }

  async function save() {
    if (!data) return
    setSaving(true)
    try {
      const res = await api.savePortfolio([...disabled])
      setDraft(null)
      setOpenOnDisabled(res.openOnDisabled)
      toast.success(
        `Portfolio saved — ${res.enabled.length} of ${data.assets.length} symbols take entries`
      )
      refresh()
    } catch (err) {
      toast.error("Could not save the portfolio", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <PortfolioSkeleton />

  if (!data) {
    return (
      <Alert variant="destructive">
        <ServerCrashIcon />
        <AlertTitle>The engine is not answering</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const enabledCount = data.assets.length - disabled.size

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Portfolio</Eyebrow>
        <h1 className="text-2xl leading-tight font-semibold">
          Where the champion may trade
        </h1>
        <ChampionLine
          name={data.champion.name}
          id={data.champion.id}
          profile={data.champion.profile}
          interval={data.champion.interval}
        />
      </div>

      {openOnDisabled.length > 0 ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>Still open on switched-off symbols</AlertTitle>
          <AlertDescription>
            {openOnDisabled
              .map((p) => `${baseAsset(p.symbol)} ${p.side}`)
              .join(", ")}{" "}
            {openOnDisabled.length === 1 ? "remains" : "remain"} open and the engine
            keeps managing{" "}
            {openOnDisabled.length === 1 ? "it" : "them"} to the stop or target.
            Switching a symbol off stops new entries; it does not exit a position.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
        <Card className="gap-0 py-0">
          <CardHeader className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>
                  {int(enabledCount)} of {int(data.assets.length)} symbols enabled
                </CardTitle>
                <CardDescription>
                  The universe is fixed by the champion&apos;s backtest. You can narrow
                  it here, never widen it.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {dirty ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft(null)}
                    disabled={saving}
                  >
                    <RotateCcwIcon data-icon="inline-start" />
                    Revert
                  </Button>
                ) : null}
                <Button size="sm" onClick={save} disabled={!dirty || saving}>
                  {saving ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  {saving ? "Saving" : "Save portfolio"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <Separator />

          {/*
            A table, not a list of labelled cards: with six rows the per-row captions
            repeated six times and the eye had to re-read the same word to find the
            same column. One header row does that job once.
          */}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">24h</TableHead>
                  <TableHead className="text-right">24h volume</TableHead>
                  <TableHead className="text-right">Live trades</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                  <TableHead className="text-right">Live P&amp;L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.assets.map((asset) => (
                  <AssetRow
                    key={asset.symbol}
                    asset={asset}
                    enabled={!disabled.has(asset.symbol)}
                    changed={
                      draft !== null &&
                      disabled.has(asset.symbol) !== serverDisabled.has(asset.symbol)
                    }
                    onToggle={(v) => toggle(asset.symbol, v)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {data.updatedAt ? (
            <>
              <Separator />
              <p className="p-4 text-[11px] text-muted-foreground">
                Last change {dateTime(data.updatedAt)}
              </p>
            </>
          ) : null}
        </Card>

        <div className="flex flex-col gap-6">
          <ProfileCard data={data} />
        </div>
      </div>
    </div>
  )
}

function AssetRow({
  asset,
  enabled,
  changed,
  onToggle,
}: {
  asset: PortfolioAsset
  enabled: boolean
  changed: boolean
  onToggle: (enabled: boolean) => void
}) {
  const switchId = `enable-${asset.symbol}`
  const numCell = "tnum text-right font-mono text-[13px]"

  return (
    <TableRow
      className={cn(
        "transition-colors",
        !enabled && "bg-muted/25",
        // Unsaved edits are marked, so it is obvious what "Save portfolio" will change.
        changed && "bg-amber/5"
      )}
    >
      <TableCell>
        <div className="flex items-center gap-2.5">
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={`Take new entries on ${asset.symbol}`}
          />
          <label
            htmlFor={switchId}
            className={cn(
              "cursor-pointer font-mono text-[13px] font-medium",
              !enabled && "text-muted-foreground"
            )}
          >
            {baseAsset(asset.symbol)}
          </label>
          {asset.hasOpenPosition ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    variant="outline"
                    className="cursor-default font-mono text-[9px]"
                  />
                }
              >
                OPEN
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                A position is open here. Switching the symbol off stops new entries;
                this one keeps being managed until it hits its stop or target.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TableCell>

      <TableCell className={numCell}>{price(asset.price)}</TableCell>

      <TableCell
        className={cn(
          numCell,
          asset.change24h === null
            ? "text-muted-foreground"
            : asset.change24h > 0
              ? "text-jade-ink"
              : asset.change24h < 0
                ? "text-clay-ink"
                : "text-foreground"
        )}
      >
        {signedPct(asset.change24h, 2)}
      </TableCell>

      <TableCell className={cn(numCell, "text-muted-foreground")}>
        {compactUsd(asset.volume24h)}
      </TableCell>

      {/*
        The live record for this symbol — what actually happened, not what a backtest
        projected. A symbol can look excellent in the grid and lose money here, and
        that is the number worth acting on.
      */}
      <TableCell className={numCell}>{int(asset.live.trades)}</TableCell>

      <TableCell className={cn(numCell, "text-muted-foreground")}>
        {asset.live.winRate === null ? DASH : pct(asset.live.winRate)}
      </TableCell>

      <TableCell
        className={cn(
          numCell,
          "font-medium",
          asset.live.trades === 0
            ? "text-muted-foreground"
            : asset.live.pnl > 0
              ? "text-jade-ink"
              : asset.live.pnl < 0
                ? "text-clay-ink"
                : "text-foreground"
        )}
      >
        {asset.live.trades === 0 ? DASH : signedUsd(asset.live.pnl)}
      </TableCell>
    </TableRow>
  )
}

function ProfileCard({ data }: { data: PortfolioView }) {
  const [low, mid, high] = data.profileSpec.leverageByVol
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">
          <span className="capitalize">{data.champion.profile}</span> profile
        </CardTitle>
        <CardDescription className="text-xs">
          Set by the champion, shown here — not editable from the console.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <Eyebrow>Leverage by volatility</Eyebrow>
        <SpecRow label="Low vol" value={`${low}×`} />
        <SpecRow label="Medium vol" value={`${mid}×`} />
        <SpecRow label="High vol" value={`${high}×`} />
        <Separator />
        <SpecRow
          label="Hard cap"
          value={`${data.maxLeverage}×`}
          tone={low > data.maxLeverage ? "accent" : "flat"}
        />
        {low > data.maxLeverage ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The profile asks for more than the cap allows, so the engine clamps to{" "}
            {data.maxLeverage}×.
          </p>
        ) : null}
        <Separator />
        <Eyebrow>Allocation</Eyebrow>
        <SpecRow
          label="Base per position"
          value={`${data.profileSpec.baseAllocationPct}%`}
        />
        <SpecRow
          label="Total ceiling"
          value={`${data.profileSpec.maxTotalAllocationPct}%`}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Base allocation is scaled by the strategy&apos;s confidence on each signal.
        </p>
      </CardContent>
    </Card>
  )
}

function PortfolioSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-20 w-80 rounded-lg" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  )
}
