"use client"

import * as React from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  InfoIcon,
  ServerCrashIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { api, type ModelListing } from "@/lib/api"
import { DASH, baseAsset, dateTime, signedPct } from "@/lib/format"
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
import { Eyebrow, SpecRow } from "@/components/console/figure"

/**
 * Models — everything that can run as the champion, and a way to pick one by hand.
 *
 * This screen deliberately bypasses the promotion gate. That is its purpose: the gate
 * decides what gets promoted AUTOMATICALLY each night, and it is built to reject almost
 * everything, because its job is to eliminate luck rather than to find winners. An
 * operator looking at the same evidence may reasonably decide otherwise.
 *
 * What the screen must never do is let that decision be an uninformed one. So every row
 * carries the gate's verdict on that model, activating a rejected model takes a second,
 * explicit click that shows the blockers first, and the engine stamps the resulting
 * record with `activatedBy: "operator"` so no later report can read a manual pick as an
 * approval.
 *
 * Switching models does not close anything. Open positions carry over to the new model
 * and keep being managed to their stop or target.
 */
export default function ModelsPage() {
  const { data, error, loading, refresh } = usePoll(() => api.models(), 30_000)

  const [activating, setActivating] = React.useState<string | null>(null)
  /** Second click required for a model the gate rejected. */
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [inherited, setInherited] = React.useState<
    { symbol: string; side: string }[] | null
  >(null)

  async function activate(model: ModelListing) {
    setActivating(model.id)
    try {
      const res = await api.activateModel(model.id)
      setConfirming(null)
      setInherited(res.inheritedPositions)
      toast.success(`${res.champion.name} is the champion`, {
        description: res.gatePassed
          ? "This model passed the promotion gate."
          : "Picked by hand — the gate did not pass this model. Recorded as an operator decision.",
      })
      refresh()
    } catch (err) {
      toast.error("Could not switch model", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setActivating(null)
    }
  }

  if (loading && !data) return <ModelsSkeleton />

  if (!data) {
    return (
      <Alert variant="destructive">
        <ServerCrashIcon />
        <AlertTitle>The engine is not answering</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const models = data.models
  const champion = models.find((m) => m.isChampion)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Models</Eyebrow>
        <h1 className="text-2xl leading-tight font-semibold">
          Which strategy runs the money
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Everything that can run as the champion: the built-in strategy, every strategy
          promoted before, and every candidate that has been evaluated. Picking one here
          bypasses the promotion gate on purpose — the gate&rsquo;s verdict stays on each
          row so the choice is an informed one.
        </p>
      </div>

      {/* The incumbent failing its own gate is the one thing this screen must not let
          scroll past: it means the running strategy would be rejected as a candidate. */}
      {champion?.gate?.incumbentQualified === false ? (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>The running model does not pass its own gate</AlertTitle>
          <AlertDescription>
            As of its last evaluation, {champion.name} would be rejected if it were
            submitted as a candidate today. Keeping it is the default, not a verdict in
            its favour.
          </AlertDescription>
        </Alert>
      ) : null}

      {inherited ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>
            {inherited.length > 0
              ? "Positions carried over to the new model"
              : "No open positions to carry over"}
          </AlertTitle>
          <AlertDescription>
            {inherited.length > 0
              ? `${inherited
                  .map((p) => `${baseAsset(p.symbol)} ${p.side}`)
                  .join(", ")} stayed open and ${
                  inherited.length === 1 ? "is" : "are"
                } now managed by the new model to the stop or target. Switching models never exits a position.`
              : "The ledger was empty, so nothing changed on the exchange."}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-4">
        {models.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            busy={activating === m.id}
            confirming={confirming === m.id}
            onRequestConfirm={() => setConfirming(m.id)}
            onCancelConfirm={() => setConfirming(null)}
            onActivate={() => activate(m)}
          />
        ))}
      </div>
    </div>
  )
}

function ModelCard({
  model,
  busy,
  confirming,
  onRequestConfirm,
  onCancelConfirm,
  onActivate,
}: {
  model: ModelListing
  busy: boolean
  confirming: boolean
  onRequestConfirm: () => void
  onCancelConfirm: () => void
  onActivate: () => void
}) {
  const ev = model.evaluation
  const gate = model.gate

  return (
    <Card className={model.isChampion ? "border-primary/60" : undefined}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{model.name}</CardTitle>
          {model.isChampion ? <Badge>Live</Badge> : null}
          <Badge variant="outline">{model.origin}</Badge>
          {model.author === "codex" ? (
            <Badge variant="outline">codex</Badge>
          ) : null}
          <GateBadge gate={gate} />
          {model.activatedBy === "operator" ? (
            <Badge variant="outline">picked by hand</Badge>
          ) : null}
        </div>
        <CardDescription className="font-mono text-xs">
          {model.id}
          {model.at > 0 ? ` · ${dateTime(model.at)}` : null}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {ev ? (
          <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            <SpecRow label="verdict" value={ev.verdict} />
            <SpecRow label="test P&L" value={signedPct(ev.testPnlPct)} />
            <SpecRow label="test MAR" value={ev.testMar.toFixed(2)} />
            <SpecRow
              label="test drawdown"
              value={`${ev.testMaxDDPct.toFixed(1)}%`}
            />
            <SpecRow
              label="positive windows"
              value={`${ev.windowsPositive}/${ev.windowCount}`}
            />
            <SpecRow label="cost stress" value={signedPct(ev.stressPnlPct)} />
            <SpecRow label="HOLDOUT" value={signedPct(ev.holdoutPnlPct)} />
            <SpecRow label="test trades" value={String(ev.testTrades)} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Never evaluated — this is the system&rsquo;s starting point, not a strategy
            that sat an exam. No numbers are shown because there are none.
          </p>
        )}

        <Separator />

        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <SpecRow
            label="symbols"
            value={
              model.symbols.length
                ? model.symbols.map(baseAsset).join(", ")
                : DASH
            }
          />
          <SpecRow label="interval" value={model.interval} />
          <SpecRow label="profile" value={model.profile} />
          <SpecRow
            label="params"
            value={
              Object.keys(model.params).length
                ? Object.entries(model.params)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")
                : DASH
            }
          />
        </div>

        {model.provenance?.arxivId ? (
          <p className="text-muted-foreground text-xs">
            arXiv:{model.provenance.arxivId}
            {model.provenance.arxivTitle
              ? ` — ${model.provenance.arxivTitle}`
              : null}
          </p>
        ) : null}

        {/* Blockers are shown on the card, not only behind the confirm step: the point
            is that they are visible BEFORE anyone reaches for the button. */}
        {gate && gate.blockers.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs font-medium">
              Gate blockers
            </span>
            <ul className="text-muted-foreground list-disc pl-4 text-xs">
              {gate.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {!model.runnable ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Cannot be activated</AlertTitle>
            <AlertDescription>{model.blockedReason}</AlertDescription>
          </Alert>
        ) : null}

        {confirming ? (
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>Activate a model the gate rejected?</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>
                The gate did not pass this model. Activating it is recorded as your
                decision, not the gate&rsquo;s. Open positions stay open and are handed
                to the new model.
              </span>
              <span className="flex gap-2">
                <Button size="sm" onClick={onActivate} disabled={busy}>
                  {busy ? <Spinner /> : null}
                  Activate anyway
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelConfirm}>
                  Cancel
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      {!model.isChampion && model.runnable && !confirming ? (
        <CardContent className="pt-0">
          <Button
            onClick={gate?.promote ? onActivate : onRequestConfirm}
            disabled={busy}
            variant={gate?.promote ? "default" : "outline"}
          >
            {busy ? <Spinner /> : null}
            Make this the champion
          </Button>
        </CardContent>
      ) : null}
    </Card>
  )
}

function GateBadge({ gate }: { gate: ModelListing["gate"] }) {
  if (!gate) return <Badge variant="outline">not evaluated</Badge>
  if (gate.promote)
    return (
      <Badge variant="outline">
        <CheckCircle2Icon /> gate passed
      </Badge>
    )
  return (
    <Badge variant="destructive">
      gate rejected · {gate.blockers.length}{" "}
      {gate.blockers.length === 1 ? "blocker" : "blockers"}
    </Badge>
  )
}

function ModelsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
