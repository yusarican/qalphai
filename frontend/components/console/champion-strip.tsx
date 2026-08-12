import * as React from "react"
import { BotIcon, FileTextIcon, UserIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Overview } from "@/lib/api"
import { dateTime, int, pct, signedPct } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Eyebrow } from "@/components/console/figure"
import { GauntletLadder, gauntletFromEvaluation } from "@/components/console/gauntlet"
import { VerdictBadge } from "@/components/console/status"

/**
 * The champion strip — what is trading, where it came from, and what it survived.
 *
 * This is the console's opening claim, so it is built to be read top-down as an
 * argument: a paper produced a hypothesis, the hypothesis was written into code by
 * an author (usually the model), the code cleared a gauntlet ending in a sealed
 * window, and only then did it get to place orders. Strip any of those steps out and
 * the remaining number is just a backtest.
 *
 * The unpromoted case is rendered as its own state, not as an empty version of this
 * one. "The built-in baseline is running" is a real and specific situation, and it
 * should not look like a champion whose fields failed to load.
 */
export function ChampionStrip({
  champion,
  universe,
  disabled,
}: {
  champion: Overview["champion"]
  universe: string[]
  disabled: string[]
}) {
  const evaluation = champion.evaluation
  const provenance = champion.provenance

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <Eyebrow>{champion.promoted ? "Champion" : "Baseline"}</Eyebrow>

            <div className="flex flex-wrap items-center gap-2.5">
              {/*
                Amber is spent here and on the live-order chip only. The champion's
                name is the one identity on the page worth a colour.
              */}
              <h1 className="font-mono text-xl leading-none font-semibold text-amber-ink">
                {champion.name}
              </h1>
              {champion.promoted ? (
                <Badge variant="outline" className="font-mono text-[10px]">
                  v{champion.version}
                </Badge>
              ) : null}
              <AuthorBadge author={champion.author} promoted={champion.promoted} />
            </div>

            <p className="font-mono text-[11px] text-muted-foreground">
              {champion.id}
            </p>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            {evaluation ? <VerdictBadge verdict={evaluation.verdict} /> : null}
            <p className="text-xs text-muted-foreground">
              {champion.promoted
                ? `Promoted ${dateTime(champion.promotedAt)}`
                : "Nothing promoted yet — the nightly loop has not shipped a strategy"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <Spec label="Profile" value={champion.profile} />
          <Spec label="Candle" value={champion.interval} />
          <Spec
            label="Universe"
            value={`${universe.length - disabled.length} of ${universe.length} symbols`}
          />
          <Spec
            label="Live entries"
            value={champion.liveEnabled ? "enabled" : "paused"}
            tone={champion.liveEnabled ? "up" : "muted"}
          />
        </div>

        {provenance?.arxivId || provenance?.hypothesis ? (
          <div className="flex gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
            <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <Eyebrow>Where it came from</Eyebrow>
              {provenance.arxivTitle ? (
                <p className="text-sm leading-snug">
                  {provenance.arxivTitle}
                  {provenance.arxivId ? (
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                      arXiv:{provenance.arxivId}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {provenance.hypothesis ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {provenance.hypothesis}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {evaluation ? (
        <>
          <Separator />
          <div className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Eyebrow>What it survived</Eyebrow>
              <p className="text-xs text-muted-foreground">
                <span className="tnum font-mono text-foreground">
                  {int(evaluation.windowsPositive)}/{int(evaluation.windowCount)}
                </span>{" "}
                walk-forward windows positive ·{" "}
                <span className="tnum font-mono text-foreground">
                  {int(evaluation.qualifiedNeighbors)}
                </span>{" "}
                qualifying neighbours on the parameter plateau
              </p>
            </div>

            <GauntletLadder rungs={gauntletFromEvaluation(evaluation)} />

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Costs ate{" "}
              <span className="tnum font-mono text-foreground">
                {pct(evaluation.feeShareOfGross * 100)}
              </span>{" "}
              of gross profit on the test slice. Above 50% the edge is going to the
              exchange rather than the account.
            </p>
          </div>
        </>
      ) : null}
    </Card>
  )
}

function Spec({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: string
  tone?: "default" | "up" | "muted"
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="eyebrow">{label}</span>
      <span
        className={cn(
          "font-mono text-[12px]",
          tone === "up" && "text-jade-ink",
          tone === "muted" && "text-muted-foreground",
          tone === "default" && "text-foreground"
        )}
      >
        {value}
      </span>
    </span>
  )
}

function AuthorBadge({
  author,
  promoted,
}: {
  author: "human" | "codex"
  promoted: boolean
}) {
  if (!promoted) {
    return (
      <Badge variant="outline" className="gap-1 font-mono text-[10px]">
        BUILT-IN
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 font-mono text-[10px]">
      {author === "codex" ? <BotIcon /> : <UserIcon />}
      {author === "codex" ? "WRITTEN BY MODEL" : "WRITTEN BY HUMAN"}
    </Badge>
  )
}

/** Reusable one-line summary of the champion for pages other than the overview. */
export function ChampionLine({
  name,
  id,
  profile,
  interval,
  className,
}: {
  name: string
  id: string
  profile: string
  interval: string
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1", className)}>
      <span className="font-mono text-sm font-medium text-amber-ink">{name}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{id}</span>
      <span className="text-xs text-muted-foreground">
        {profile} · {interval}
      </span>
    </div>
  )
}

/** Kept beside the strip so the two never disagree about what "unknown" looks like. */
export const CHAMPION_EMPTY_HINT =
  "The engine has not promoted a strategy yet, so the built-in baseline is what trades."

export function EvaluationSummary({
  evaluation,
}: {
  evaluation: Overview["champion"]["evaluation"]
}) {
  if (!evaluation) return null
  return (
    <p className="text-xs text-muted-foreground">
      Test {signedPct(evaluation.testPnlPct)} · MAR{" "}
      <span className="tnum font-mono">{evaluation.testMar.toFixed(2)}</span> · max DD{" "}
      {pct(evaluation.testMaxDDPct)} over {int(evaluation.testTrades)} trades
    </p>
  )
}
