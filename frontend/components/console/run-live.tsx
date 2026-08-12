"use client"

import * as React from "react"
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  PlayIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { api, type LiveAction, type LiveRunResult } from "@/lib/api"
import { baseAsset, dateTime, humanizeRule, num, price, usd } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Eyebrow } from "@/components/console/figure"
import { SideBadge } from "@/components/console/status"

/**
 * Evaluate the current bar on demand.
 *
 * The console can ask the engine to think; it cannot ask it to trade. Whether this
 * run places orders is decided entirely by LIVE_TRADING on the server. There is no
 * switch here for that on purpose — moving money should take a deploy, not a click,
 * and a button that could do it would eventually be clicked by accident during a demo.
 */
export function RunLive({ onComplete }: { onComplete?: () => void }) {
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<LiveRunResult | null>(null)

  async function run() {
    setRunning(true)
    try {
      const res = await api.runLive()
      setResult(res)
      const opened = res.actions.filter((a) => a.kind === "OPENED").length
      const failed = res.actions.filter((a) => a.kind === "FAILED").length
      toast.success(
        opened > 0
          ? `Run complete — ${opened} position${opened === 1 ? "" : "s"} opened`
          : "Run complete — no entry taken",
        {
          description: failed > 0 ? `${failed} action failed. Check the log below.` : undefined,
        }
      )
      onComplete?.()
    } catch (err) {
      toast.error("Run failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={run} disabled={running} size="lg">
        {running ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <PlayIcon data-icon="inline-start" />
        )}
        {running ? "Evaluating the bar…" : "Run the engine now"}
      </Button>

      {result ? (
        <RunReport result={result} onDismiss={() => setResult(null)} />
      ) : null}
    </div>
  )
}

function RunReport({
  result,
  onDismiss,
}: {
  result: LiveRunResult
  onDismiss: () => void
}) {
  const opened = result.actions.filter((a) => a.kind === "OPENED")
  const closed = result.actions.filter((a) => a.kind === "CLOSED")
  const breakeven = result.actions.filter((a) => a.kind === "BREAKEVEN")
  const failed = result.actions.filter((a) => a.kind === "FAILED")

  return (
    <Card size="sm">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="font-mono text-sm">
            Bar {dateTime(result.decisionBar)}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {result.dryRun
              ? "Dry run — the engine reported what it would do and sent nothing."
              : "Live run — orders were sent to the exchange."}{" "}
            Balance {usd(result.balance)} · {usd(result.availableMargin)} free
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label="Dismiss run report"
        >
          <XIcon />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/*
          Divergence is the loudest thing this panel can say. It means the exchange
          refused something the backtest would have taken, so this run and the measured
          strategy are no longer the same strategy — and the live numbers stop being
          comparable to the backtest that justified them.
        */}
        {result.divergences.length > 0 ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>This run diverged from the backtest</AlertTitle>
            <AlertDescription>
              <p>
                The exchange refused {result.divergences.length}{" "}
                {result.divergences.length === 1 ? "entry" : "entries"} the simulated
                strategy would have taken. Live results from this bar are not
                comparable to the backtest.
              </p>
              <ul className="flex flex-col gap-0.5 font-mono text-xs">
                {result.divergences.map((d, i) => (
                  <li key={i}>
                    {baseAsset(d.symbol)} {d.side} — {d.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {result.unmanaged.length > 0 ? (
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>Positions the engine will not touch</AlertTitle>
            <AlertDescription>
              {result.unmanaged.map(baseAsset).join(", ")}{" "}
              {result.unmanaged.length === 1 ? "is" : "are"} open on the exchange but
              absent from the ledger, so the engine leaves{" "}
              {result.unmanaged.length === 1 ? "it" : "them"} alone. Close{" "}
              {result.unmanaged.length === 1 ? "it" : "them"} by hand or adopt{" "}
              {result.unmanaged.length === 1 ? "it" : "them"} on the exchange.
            </AlertDescription>
          </Alert>
        ) : null}

        {failed.length > 0 ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Actions that failed</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-0.5 font-mono text-xs">
                {failed.map((a, i) => (
                  <li key={i}>
                    {baseAsset(a.symbol)} {a.side} — {a.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Section title="Allocations" count={result.allocations.length}>
            {result.allocations.length === 0 ? (
              <Muted>No symbol cleared the entry gates on this bar.</Muted>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {result.allocations.map((a) => (
                  <li
                    key={a.symbol}
                    className="flex items-center gap-2 font-mono text-xs"
                  >
                    <span className="w-10 font-medium">{baseAsset(a.symbol)}</span>
                    <SideBadge side={a.side} />
                    <span className="tnum text-muted-foreground">
                      conf {num(a.confidence, 2)}
                    </span>
                    <span className="tnum text-muted-foreground">
                      {a.leverage}× · {num(a.allocationPercent, 0)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Opened" count={opened.length}>
            {opened.length === 0 ? (
              <Muted>Nothing was opened.</Muted>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {opened.map((a, i) => (
                  <ActionLine key={i} action={a} />
                ))}
              </ul>
            )}
          </Section>

          {closed.length > 0 ? (
            <Section title="Closed" count={closed.length}>
              <ul className="flex flex-col gap-1.5">
                {closed.map((a, i) => (
                  <li key={i} className="flex items-center gap-2 font-mono text-xs">
                    <span className="w-10 font-medium">{baseAsset(a.symbol)}</span>
                    <SideBadge side={a.side} />
                    <span className="text-muted-foreground">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {breakeven.length > 0 ? (
            <Section title="Stops moved" count={breakeven.length}>
              <ul className="flex flex-col gap-1.5">
                {breakeven.map((a, i) => (
                  <li key={i} className="flex items-center gap-2 font-mono text-xs">
                    <span className="w-10 font-medium">{baseAsset(a.symbol)}</span>
                    <span className="text-muted-foreground">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {/*
            Why NOTHING happened is the question this panel exists to answer. A run
            with zero allocations and no reasons listed is indistinguishable from a
            broken engine.
          */}
          <Section title="Rejected" count={result.rejections.length}>
            {result.rejections.length === 0 ? (
              <Muted>No entry was vetoed.</Muted>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {result.rejections.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 font-mono text-xs">
                    <span className="w-10 shrink-0 font-medium">
                      {baseAsset(r.symbol)}
                    </span>
                    <span className="text-muted-foreground">
                      {humanizeRule(r.rule)}
                      {r.note ? ` — ${r.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="No signal" count={result.noSignal.length}>
            {result.noSignal.length === 0 ? (
              <Muted>Every symbol produced a signal or a veto.</Muted>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">
                {result.noSignal.map(baseAsset).join(" · ")}
              </p>
            )}
          </Section>
        </div>

        {result.disabled.length > 0 ? (
          <>
            <Separator />
            <p className="text-[11px] text-muted-foreground">
              Not evaluated (switched off in Portfolio):{" "}
              <span className="font-mono">
                {result.disabled.map(baseAsset).join(", ")}
              </span>
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ActionLine({ action }: { action: LiveAction }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
      <CircleCheckIcon className="size-3 text-jade-ink" />
      <span className="font-medium">{baseAsset(action.symbol)}</span>
      <SideBadge side={action.side} />
      {action.entryFill != null ? (
        <span className="tnum text-muted-foreground">@ {price(action.entryFill)}</span>
      ) : null}
      {action.stopPrice != null ? (
        <span className="tnum inline-flex items-center gap-1 text-muted-foreground">
          <ArrowRightIcon className="size-3" />
          stop {price(action.stopPrice)}
        </span>
      ) : null}
      {action.riskUSD != null ? (
        <span className="tnum text-muted-foreground">risk {usd(action.riskUSD)}</span>
      ) : null}
      {action.reason ? (
        <Badge variant="outline" className="font-mono text-[9px]">
          {action.reason}
        </Badge>
      ) : null}
    </li>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <Eyebrow>{title}</Eyebrow>
        <span className={cn("tnum font-mono text-[11px]", count > 0 ? "text-foreground" : "text-muted-foreground")}>
          {count}
        </span>
      </div>
      {children}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}
