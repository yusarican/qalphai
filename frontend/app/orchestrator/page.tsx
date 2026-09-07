"use client"

import * as React from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  BrainIcon,
  CheckCircle2Icon,
  ClockIcon,
  FileTextIcon,
  PowerOffIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Directive,
  type OrchestratorRunSummary,
  type OrchestratorStatus,
} from "@/lib/api"
import { DASH, dateTime, int, rMultiple, signedUsd, since } from "@/lib/format"
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
import { Textarea } from "@/components/ui/textarea"
import { Eyebrow, Figure, SpecRow } from "@/components/console/figure"

/**
 * Orchestrator — the layer that watches everything else.
 *
 * The nightly loop asks one question ("what is on arXiv today?"). This screen is about
 * the questions it cannot ask: is the live model degrading, is something in the library
 * worth developing, did Codex miss something, and which of a model's own filters are
 * actually earning their keep.
 *
 * The single most important thing this screen must communicate: **the orchestrator
 * cannot put anything live.** It produces candidates and they queue up on /models
 * behind a human decision. That is a structural limit in the engine — there is no
 * activation tool in its tool list — and the copy here says so rather than leaving an
 * operator to wonder what ran unattended overnight.
 */
export default function OrchestratorPage() {
  const { data: status, error: statusError } = usePoll(
    () => api.orchestrator(),
    10_000,
  )
  const { data: runsView, refresh: refreshRuns } = usePoll(
    () => api.orchestratorRuns(),
    10_000,
  )
  const { data: directives, refresh: refreshDirectives } = usePoll(
    () => api.directives(),
    30_000,
  )

  const [task, setTask] = React.useState("")
  const [starting, setStarting] = React.useState(false)

  const running = status?.running ?? false

  async function start(body: { task?: string; preset?: "pre-nightly" | "post-nightly" }) {
    setStarting(true)
    try {
      const res = await api.runOrchestrator(body)
      toast.success(`Run started: ${res.runId}`)
      setTask("")
      refreshRuns()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  if (statusError) {
    return (
      <Alert variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>Engine unreachable</AlertTitle>
        <AlertDescription>{statusError}</AlertDescription>
      </Alert>
    )
  }

  if (!status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header status={status} />

      {!status.enabled ? (
        <Disabled />
      ) : (
        <Launcher
          task={task}
          setTask={setTask}
          starting={starting}
          running={running}
          onStart={start}
        />
      )}

      <LiveHealthCard status={status} />
      <Directives directives={directives ?? null} onChange={refreshDirectives} />
      <Runs runs={runsView?.runs ?? null} currentRunId={runsView?.currentRunId ?? null} />
    </div>
  )
}

/* ------------------------------------------------------------------ header --- */

function Header({ status }: { status: OrchestratorStatus }) {
  const q = status.queue

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BrainIcon className="size-4" />
              Main Orchestrator
            </CardTitle>
            <CardDescription>
              Reads the live account and the model library, runs autopsies, measures what
              each gate costs, produces candidates, and steers the nightly research.
            </CardDescription>
          </div>
          <Badge variant={status.enabled ? (status.running ? "default" : "secondary") : "outline"}>
            {status.enabled ? (status.running ? "RUNNING" : "IDLE") : "DISABLED"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="provider" value={status.enabled ? status.provider : DASH} size="sm" />
          <Figure label="model" value={status.enabled ? status.model : DASH} size="sm" />
          <Figure label="pre-nightly" value={status.preCron} size="sm" sub="UTC" />
          <Figure label="post-nightly" value={status.postCron} size="sm" sub="UTC" />
        </div>

        <Separator />

        {/*
          The compute queue is shared by three claimants — the nightly loop, panel
          backtests and the orchestrator — because they contend for one CPU. Showing it
          answers the question an operator would otherwise ask as "why is nothing
          happening?".
        */}
        <div>
          <Eyebrow>compute queue</Eyebrow>
          <div className="mt-2 space-y-1 font-mono text-xs">
            {q.depth === 0 ? (
              <p className="text-muted-foreground">idle</p>
            ) : (
              <>
                {q.active ? (
                  <p>
                    <span className="text-amber-ink">running</span> · {q.active.kind} ·{" "}
                    {q.active.label}
                  </p>
                ) : null}
                {q.waiting.map((w) => (
                  <p key={w.id} className="text-muted-foreground">
                    queued · {w.kind} · {w.label}
                  </p>
                ))}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function Disabled() {
  return (
    <Alert>
      <PowerOffIcon />
      <AlertTitle>Orchestrator is off</AlertTitle>
      <AlertDescription>
        Set <code>ORCH_ENABLED=true</code> and <code>ORCH_API_KEY</code> in the engine&apos;s{" "}
        <code>.env</code> (see <code>.env.example</code>), then restart. While it is off the
        rest of the system behaves exactly as it did before: the nightly loop, the paper
        selector and the Codex briefs produce byte-identical output.
      </AlertDescription>
    </Alert>
  )
}

/* ---------------------------------------------------------------- launcher --- */

function Launcher({
  task,
  setTask,
  starting,
  running,
  onStart,
}: {
  task: string
  setTask: (v: string) => void
  starting: boolean
  running: boolean
  onStart: (body: { task?: string; preset?: "pre-nightly" | "post-nightly" }) => void
}) {
  const busy = starting || running

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a run</CardTitle>
        <CardDescription>
          A run can take hours. It is fire-and-forget — progress appears below.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onStart({ preset: "pre-nightly" })}>
            Pre-nightly review
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onStart({ preset: "post-nightly" })}>
            Post-nightly audit
          </Button>
        </div>

        <div className="space-y-2">
          <Eyebrow>custom task</Eyebrow>
          <Textarea
            rows={3}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Run an autopsy on the champion for 2026-03-01 .. 2026-06-01 and tell me whether the drawdown is the model or the regime."
            disabled={busy}
          />
          <Button disabled={busy || task.trim().length === 0} onClick={() => onStart({ task })}>
            {busy ? <Spinner /> : null}
            {running ? "A run is already in progress" : "Run"}
          </Button>
        </div>

        {/*
          Stated on the screen, not only in the docs. An operator watching an agent work
          unattended overnight needs to know exactly where its authority stops.
        */}
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>Nothing here can go live</AlertTitle>
          <AlertDescription>
            The orchestrator has no tool that activates a model. Anything it produces is
            saved as a candidate and waits for you on <strong>Models</strong>. It can
            steer the nightly research (directives below), which is reversible and risks
            no money.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------- live health --- */

function LiveHealthCard({ status }: { status: OrchestratorStatus }) {
  const h = status.liveHealth

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="size-4" />
          Live health trigger
        </CardTitle>
        <CardDescription>
          When closed live trades breach a threshold, an autopsy starts on its own.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="closed trades" value={int(h.stats.trades)} size="sm" />
          <Figure
            label="expectancy"
            value={rMultiple(h.stats.expectancyR)}
            tone={h.stats.expectancyR > 0 ? "up" : h.stats.expectancyR < 0 ? "down" : "flat"}
            size="sm"
          />
          <Figure
            label="cumulative"
            value={signedUsd(h.stats.totalPnl)}
            tone={h.stats.totalPnl > 0 ? "up" : h.stats.totalPnl < 0 ? "down" : "flat"}
            size="sm"
          />
          <Figure label="losing streak" value={int(h.stats.consecutiveLosses)} size="sm" />
        </div>

        {h.breached ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Threshold breached</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {h.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          /*
            Absent is not healthy. With no closed live trades this trigger has nothing to
            measure, and saying "healthy" here would be the panel inventing a fact — the
            same rule that makes an unreadable mark price render as a dash.
          */
          <p className="text-xs text-muted-foreground">
            {h.stats.trades === 0
              ? "No closed live trades yet, so this trigger has nothing to measure. That is not the same as healthy — live trading is off by default. The orchestrator measures degradation with rolling-window backtests instead."
              : "No threshold breached."}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------- directives --- */

const TARGET_LABEL: Record<Directive["target"], string> = {
  "arxiv-queries": "arXiv query",
  "paper-triage": "paper triage",
  "paper-final": "paper selection",
  "codex-new": "Codex · new strategy",
  "codex-refine": "Codex · refine",
}

function Directives({
  directives,
  onChange,
}: {
  directives: Directive[] | null
  onChange: () => void
}) {
  const [revoking, setRevoking] = React.useState<string | null>(null)

  async function revoke(id: string) {
    setRevoking(id)
    try {
      await api.revokeDirective(id)
      toast.success("Directive revoked")
      onChange()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRevoking(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active directives</CardTitle>
        <CardDescription>
          Text the orchestrator injects into the nightly loop — arXiv queries, the paper
          selector&apos;s prompts, Codex&apos;s brief. A directive states a{" "}
          <strong>priority, not a permission</strong>: it is placed before the hard rules
          and cannot loosen any of them. The walls are enforced by the validator, the
          gauntlet and the promotion gate, not by prompt text.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {directives === null ? (
          <Skeleton className="h-16 w-full" />
        ) : directives.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None. The nightly loop is running with its stock prompts.
          </p>
        ) : (
          <div className="space-y-3">
            {directives.map((d) => (
              <div key={d.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{TARGET_LABEL[d.target]}</Badge>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {d.createdBy} · {d.expiresAt ? `expires ${dateTime(d.expiresAt)}` : "no expiry"}
                      </span>
                    </div>
                    <p className="font-mono text-xs">{d.text}</p>
                    {d.rationale ? (
                      <p className="text-xs text-muted-foreground">why: {d.rationale}</p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoking === d.id}
                    onClick={() => revoke(d.id)}
                  >
                    {revoking === d.id ? <Spinner /> : <XCircleIcon />}
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------- runs --- */

const STATUS_VARIANT: Record<
  OrchestratorRunSummary["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  running: "default",
  done: "secondary",
  stopped: "outline",
  failed: "destructive",
}

function Runs({
  runs,
  currentRunId,
}: {
  runs: OrchestratorRunSummary[] | null
  currentRunId: string | null
}) {
  const [open, setOpen] = React.useState<string | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClockIcon className="size-4" />
          Runs
        </CardTitle>
      </CardHeader>

      <CardContent>
        {runs === null ? (
          <Skeleton className="h-24 w-full" />
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="space-y-3">
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                isCurrent={r.id === currentRunId}
                open={open === r.id}
                onToggle={() => setOpen(open === r.id ? null : r.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RunRow({
  run,
  isCurrent,
  open,
  onToggle,
}: {
  run: OrchestratorRunSummary
  isCurrent: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[run.status]}>{run.status.toUpperCase()}</Badge>
            <Badge variant="outline">{run.trigger}</Badge>
            <span className="font-mono text-xs">{run.id}</span>
            {isCurrent ? <Spinner /> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {since(run.startedAt)} · {run.stepCount} steps · {int(run.tokensUsed)} tokens ·{" "}
            {run.backtestsRun} heavy runs
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {run.producedCandidates.length > 0 ? (
            <p className="text-amber-ink">
              {run.producedCandidates.length} candidate
              {run.producedCandidates.length === 1 ? "" : "s"} → Models
            </p>
          ) : null}
          {run.directives.length > 0 ? <p>{run.directives.length} directive(s)</p> : null}
        </div>
      </button>

      {open ? <RunDetail id={run.id} fallback={run} /> : null}
    </div>
  )
}

function RunDetail({
  id,
  fallback,
}: {
  id: string
  fallback: OrchestratorRunSummary
}) {
  // A running run is polled; a finished one settles and stops (use-poll's stopWhen).
  const { data, error } = usePoll(() => api.orchestratorRun(id), 8_000, [id], {
    stopWhen: (r) => r.status !== "running",
  })

  if (error) {
    return <p className="border-t p-3 text-xs text-clay-ink">{error}</p>
  }
  if (!data) {
    return (
      <div className="border-t p-3">
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4 border-t p-3">
      <div>
        <Eyebrow>task</Eyebrow>
        <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
          {data.task}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SpecRow label="model" value={`${data.provider}/${data.model}`} />
        <SpecRow label="started" value={dateTime(data.startedAt)} />
        <SpecRow label="finished" value={data.finishedAt ? dateTime(data.finishedAt) : DASH} />
        <SpecRow label="report" value={data.reportPath ?? DASH} />
      </div>

      {data.error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Run did not finish cleanly</AlertTitle>
          <AlertDescription>{data.error}</AlertDescription>
        </Alert>
      ) : null}

      {data.producedCandidates.length > 0 ? (
        <Alert>
          <FileTextIcon />
          <AlertTitle>Candidates waiting on Models</AlertTitle>
          <AlertDescription>
            {data.producedCandidates.join(", ")} — evaluated through the full exam, and{" "}
            <strong>not live</strong>. Activation is yours.
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Eyebrow>steps</Eyebrow>
        <div className="mt-2 space-y-2">
          {(data.steps ?? []).map((s) => (
            <div key={s.n} className="rounded border p-2">
              <p className="font-mono text-[11px] text-muted-foreground">
                #{s.n} · {dateTime(s.at)} · {s.usage.inTokens}/{s.usage.outTokens} tok
              </p>
              {s.text ? <p className="mt-1 whitespace-pre-wrap text-xs">{s.text}</p> : null}
              {s.toolCalls.map((c, i) => (
                <p key={i} className="mt-1 font-mono text-[11px]">
                  <span className={c.ok ? "text-jade-ink" : "text-clay-ink"}>
                    {c.ok ? "ok " : "err"}
                  </span>{" "}
                  {c.name} ({Math.round(c.ms / 100) / 10}s) — {c.summary}
                </p>
              ))}
            </div>
          ))}
        </div>
      </div>

      {data.summary ?? fallback.summary ? (
        <div>
          <Eyebrow>summary</Eyebrow>
          <p className="mt-1 whitespace-pre-wrap text-xs">{data.summary ?? fallback.summary}</p>
        </div>
      ) : null}
    </div>
  )
}
