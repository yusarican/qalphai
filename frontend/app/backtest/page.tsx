"use client"

import * as React from "react"
import { FlaskConicalIcon, PlayIcon, ServerCrashIcon } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  api,
  DEFAULT_GRID,
  MAX_CELLS,
  type BacktestJobView,
  type BacktestRunSummary,
  type GridSpec,
  type Interval,
  type Profile,
} from "@/lib/api"
import { baseAsset, dateTime, duration, int, pct, signedPct } from "@/lib/format"
import { usePoll } from "@/hooks/use-poll"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { BacktestReport } from "@/components/console/backtest-report"
import { Eyebrow } from "@/components/console/figure"
import { VerdictBadge } from "@/components/console/status"

const INTERVALS: Interval[] = ["1h", "4h", "1d"]
const PROFILES: Profile[] = ["conservative", "balanced", "aggressive"]

/**
 * Backtest console.
 *
 * The run this page starts is the engine's real evaluation path (engine/challenge) —
 * the same grid, the same walk-forward, the same verdict function the nightly
 * promotion gate uses. There is no lighter "panel backtest", because a friendlier
 * number here would be a number that never justified anything.
 *
 * Runs are serialised by the engine: two grids on one CPU starve each other and the
 * timing measurements come out dirty. A second start returns 409 and this page says so
 * rather than pretending to queue.
 */
export default function BacktestPage() {
  const overview = usePoll(() => api.overview(), 60_000)
  const runs = usePoll(() => api.backtestRuns(), 8_000)

  const universe = overview.data?.universe ?? []

  /*
   * The newest run is shown until the operator picks another. Deriving that during
   * render, rather than seeding state from an effect, means there is never a frame
   * where history exists and the panel is blank.
   */
  const [chosenId, setChosenId] = React.useState<string | null>(null)
  const activeId = chosenId ?? runs.data?.runs[0]?.id ?? null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Backtest</Eyebrow>
        <h1 className="text-2xl leading-tight font-semibold">
          Put a strategy through the gauntlet
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          This runs the engine&apos;s own evaluation path — parameter grid, walk-forward
          windows, a stress pass and a sealed holdout — and returns the same verdict the
          nightly promotion gate would give.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <NewRunCard
            universe={universe}
            sweepCells={overview.data?.champion.sweep.cells ?? null}
            defaultInterval={overview.data?.champion.interval ?? "4h"}
            defaultProfile={overview.data?.champion.profile ?? "balanced"}
            running={runs.data?.running ?? false}
            onStarted={(id) => {
              setChosenId(id)
              runs.refresh()
            }}
          />

          <RunHistory
            runs={runs.data?.runs ?? []}
            loading={runs.loading}
            activeId={activeId}
            onSelect={setChosenId}
          />
        </div>

        <div className="min-w-0">
          {activeId ? (
            <RunPanel key={activeId} id={activeId} />
          ) : runs.loading ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <Card>
              <CardContent>
                <Empty className="border-0 py-14">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FlaskConicalIcon />
                    </EmptyMedia>
                    <EmptyTitle>No runs yet</EmptyTitle>
                    <EmptyDescription>
                      Start one on the left. A full grid takes minutes, and the page
                      follows its progress stage by stage.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function NewRunCard({
  universe,
  sweepCells,
  defaultInterval,
  defaultProfile,
  running,
  onStarted,
}: {
  universe: string[]
  /** Champion's strategy-grid size — the multiplier on the risk grid. null until loaded. */
  sweepCells: number | null
  defaultInterval: Interval
  defaultProfile: Profile
  running: boolean
  onStarted: (id: string) => void
}) {
  /*
   * The champion's settings are the defaults, and they arrive asynchronously. Each
   * control holds null until the operator touches it, and falls back to the engine's
   * value — so a late-arriving champion cannot overwrite a choice already made, and a
   * choice already made cannot be undone by a refresh.
   */
  const [symbolsChoice, setSymbols] = React.useState<string[] | null>(null)
  const [intervalChoice, setInterval] = React.useState<Interval | null>(null)
  const [profileChoice, setProfile] = React.useState<Profile | null>(null)

  const symbols = symbolsChoice ?? universe
  const interval = intervalChoice ?? defaultInterval
  const profile = profileChoice ?? defaultProfile

  const [days, setDays] = React.useState("540")
  const [balance, setBalance] = React.useState("10000")
  const [noCosts, setNoCosts] = React.useState(false)
  const [fixedParams, setFixedParams] = React.useState(false)
  const [starting, setStarting] = React.useState(false)

  const [gridText, setGridText] = React.useState<Record<GridAxisKey, string>>(() => ({
    rewardRatios: DEFAULT_GRID.rewardRatios.join(", "),
    slMultipliers: DEFAULT_GRID.slMultipliers.join(", "),
    callbackMultipliers: DEFAULT_GRID.callbackMultipliers.join(", "),
    riskPerTradePcts: DEFAULT_GRID.riskPerTradePcts.join(", "),
  }))
  const grid = React.useMemo(() => parseGridText(gridText), [gridText])

  /*
   * What the run will actually cost, in cells.
   *
   * The risk grid is only one factor: the engine reruns the whole strategy for every
   * combination of its swept parameters, so the real total is that count times this one.
   * The console used to check the risk axes alone against the ceiling, which meant a
   * grid it called legal (768 cells) was rejected by the engine as 13,824 — after the
   * candle sync, minutes into the run. Fixed params removes the strategy axis entirely,
   * which is why it shows up here as a multiplier of 1.
   */
  const paramCells = fixedParams ? 1 : sweepCells
  const totalCells = paramCells === null ? null : paramCells * grid.cellCount
  const overCeiling = totalCells !== null && totalCells > MAX_CELLS

  async function start() {
    setStarting(true)
    try {
      const res = await api.startBacktest({
        symbols,
        interval,
        profile,
        days: Number(days) || undefined,
        initialBalance: Number(balance) || undefined,
        noCosts,
        fixedParams,
        // Only sent when the operator actually changed it, so a run's stored params say
        // "default grid" rather than carrying a copy that merely happens to match today's
        // default and would silently drift from it later.
        ...(grid.spec && grid.edited ? { grid: grid.spec } : {}),
      })
      toast.success("Backtest started", {
        description: "Progress appears on the right, stage by stage.",
      })
      onStarted(res.id)
    } catch (err) {
      // 409 is the engine refusing a second concurrent grid — a normal condition,
      // worth explaining rather than reporting as a failure.
      toast.error("Could not start the backtest", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setStarting(false)
    }
  }

  const disabled =
    starting || running || symbols.length === 0 || grid.spec === null || overCeiling

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">New run</CardTitle>
        <CardDescription className="text-xs">
          Defaults follow the current champion.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel>Symbols</FieldLabel>
            {universe.length === 0 ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <ToggleGroup
                multiple
                value={symbols}
                onValueChange={(v) => setSymbols(v as string[])}
                variant="outline"
                size="sm"
                className="flex-wrap"
              >
                {universe.map((s) => (
                  <ToggleGroupItem key={s} value={s} className="font-mono text-[11px]">
                    {baseAsset(s)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            <FieldDescription>
              {symbols.length === 0
                ? "Pick at least one symbol."
                : `${symbols.length} of ${universe.length} selected.`}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Candle</FieldLabel>
            <ToggleGroup
              value={[interval]}
              onValueChange={(v) => v[0] && setInterval(v[0] as Interval)}
              variant="outline"
              size="sm"
            >
              {INTERVALS.map((i) => (
                <ToggleGroupItem key={i} value={i} className="font-mono text-[11px]">
                  {i}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel>Risk profile</FieldLabel>
            <ToggleGroup
              value={[profile]}
              onValueChange={(v) => v[0] && setProfile(v[0] as Profile)}
              variant="outline"
              size="sm"
              className="flex-wrap"
            >
              {PROFILES.map((p) => (
                <ToggleGroupItem key={p} value={p} className="text-[11px] capitalize">
                  {p}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="days">History</FieldLabel>
            <Input
              id="days"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="font-mono"
            />
            <FieldDescription>
              Days of candles. The last 90 are held back as the sealed window.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="balance">Starting balance</FieldLabel>
            <Input
              id="balance"
              inputMode="numeric"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="font-mono"
            />
          </Field>

          {/*
            The risk grid, editable. It used to be a constant in the engine, which meant
            the answer to "is 2.5x ATR better than 2.2x" was "the code never asked". The
            axes stay separate fields rather than one blob because a typo in a blob is
            invisible, and a bad axis here costs an hour of grinding.
          */}
          <Field>
            <FieldLabel>Risk grid</FieldLabel>
            <div className="flex flex-col gap-2">
              {GRID_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">
                    {f.label}
                  </span>
                  <Input
                    value={gridText[f.key]}
                    onChange={(e) =>
                      setGridText((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                    aria-invalid={grid.errors[f.key] ? true : undefined}
                    className="h-8 font-mono text-[12px]"
                  />
                </label>
              ))}
            </div>
            <FieldDescription>
              {grid.spec === null ? (
                <span className="text-destructive">
                  {Object.values(grid.errors).find(Boolean)}
                </span>
              ) : (
                <>
                  {int(grid.cellCount)} risk cells
                  {grid.edited ? " · custom" : " · engine default"}. Values are sorted
                  ascending; risk is a fraction, so 0.05 is 5%.
                </>
              )}
            </FieldDescription>
          </Field>

          {/*
            The cell count the engine will actually grind, spelled out as the product it
            is. It sits under the grid because that is where the operator is when the
            number changes, and it names both levers — trim an axis, or fix the params.
          */}
          {grid.spec !== null && paramCells !== null && totalCells !== null ? (
            <p
              className={cn(
                "font-mono text-[11px] leading-relaxed",
                overCeiling ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {int(paramCells)} strategy × {int(grid.cellCount)} risk ={" "}
              {int(totalCells)} cells
              {overCeiling
                ? ` — over the ${int(MAX_CELLS)} ceiling. Trim a risk axis, or switch on fixed params below to drop the strategy factor to 1.`
                : totalCells > 4_000
                  ? " — a grid this size grinds for many minutes."
                  : ""}
            </p>
          ) : null}

          <Field orientation="horizontal">
            <Switch
              id="fixed-params"
              checked={fixedParams}
              onCheckedChange={setFixedParams}
            />
            <FieldLabel htmlFor="fixed-params" className="font-normal">
              Skip the strategy grid, use the champion&apos;s parameters
            </FieldLabel>
          </Field>

          <Field orientation="horizontal">
            <Switch id="no-costs" checked={noCosts} onCheckedChange={setNoCosts} />
            <FieldLabel htmlFor="no-costs" className="font-normal">
              Turn costs off
            </FieldLabel>
          </Field>
        </FieldGroup>

        {noCosts ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            With costs off the result is a diagnostic, not a forecast: it measures how
            much of the edge fees and slippage were eating.
          </p>
        ) : null}

        <Button onClick={start} disabled={disabled} className="w-full">
          {starting ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {running ? "A run is already going" : "Start backtest"}
        </Button>
      </CardContent>
    </Card>
  )
}

type GridAxisKey = keyof GridSpec

const GRID_FIELDS: { key: GridAxisKey; label: string }[] = [
  { key: "rewardRatios", label: "RR" },
  { key: "slMultipliers", label: "SL × ATR" },
  { key: "callbackMultipliers", label: "CB × ATR" },
  { key: "riskPerTradePcts", label: "Risk/trade" },
]

/**
 * Turns the four text fields into a grid, or into the reason it is not one.
 *
 * Validation is deliberately the same shape as the engine's (routes.ts parseGrid): the
 * console rejects early to save the operator a wait, but it is not the authority — the
 * engine re-checks everything it is handed.
 *
 * The cell ceiling is NOT checked here: it applies to strategy × risk, and this function
 * only sees the risk axes. The caller multiplies in the strategy factor.
 */
function parseGridText(text: Record<GridAxisKey, string>): {
  spec: GridSpec | null
  errors: Partial<Record<GridAxisKey, string>>
  cellCount: number
  edited: boolean
} {
  const errors: Partial<Record<GridAxisKey, string>> = {}
  const parsed = {} as Record<GridAxisKey, number[]>

  for (const { key, label } of GRID_FIELDS) {
    const raw = text[key]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)

    if (raw.length === 0) {
      errors[key] = `${label} needs at least one value.`
      continue
    }

    const nums: number[] = []
    for (const token of raw) {
      const n = Number(token)
      if (!Number.isFinite(n) || n <= 0) {
        errors[key] = `${label}: "${token}" is not a positive number.`
        break
      }
      nums.push(n)
    }
    if (errors[key]) continue

    if (key === "riskPerTradePcts" && nums.some((n) => n >= 1)) {
      errors[key] = "Risk/trade is a fraction — 0.05 means 5%."
      continue
    }

    // Ascending and deduplicated, because the plateau score reads a step along an axis
    // as "the next value tried". An unsorted axis makes that neighbourhood meaningless.
    parsed[key] = [...new Set(nums)].sort((a, b) => a - b)
  }

  if (Object.values(errors).some(Boolean)) {
    return { spec: null, errors, cellCount: 0, edited: true }
  }

  const spec: GridSpec = {
    rewardRatios: parsed.rewardRatios,
    slMultipliers: parsed.slMultipliers,
    callbackMultipliers: parsed.callbackMultipliers,
    riskPerTradePcts: parsed.riskPerTradePcts,
  }

  const cellCount = GRID_FIELDS.reduce((n, f) => n * parsed[f.key].length, 1)

  const edited = GRID_FIELDS.some(
    (f) => parsed[f.key].join(",") !== DEFAULT_GRID[f.key].join(",")
  )

  return { spec, errors, cellCount, edited }
}

/** Follows one run: progress while it is going, the full report when it lands. */
function RunPanel({ id }: { id: string }) {
  /*
   * Poll hard while the grid is grinding, then stop dead. A finished run is immutable
   * — the engine writes it to disk once — so there is nothing left to ask about, and
   * the history list picks it up on its own schedule.
   */
  const { data, error, loading } = usePoll(
    () => api.backtestRun(id),
    2_000,
    [id],
    { stopWhen: (run) => run.status !== "running" }
  )

  if (loading && !data) return <Skeleton className="h-96 w-full rounded-xl" />

  if (!data) {
    return (
      <Alert variant="destructive">
        <ServerCrashIcon />
        <AlertTitle>Could not load this run</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (data.status === "running") return <RunningCard job={data} />

  if (data.status === "failed") {
    return (
      <Alert variant="destructive">
        <ServerCrashIcon />
        <AlertTitle>The run failed</AlertTitle>
        <AlertDescription>{data.error ?? "The engine reported no reason."}</AlertDescription>
      </Alert>
    )
  }

  if (!data.result) {
    return (
      <Alert>
        <ServerCrashIcon />
        <AlertTitle>The run finished without a result</AlertTitle>
        <AlertDescription>
          The engine marked this run done but stored nothing for it.
        </AlertDescription>
      </Alert>
    )
  }

  return <BacktestReport run={data.result} />
}

/**
 * The engine's stage keys, spelled out. The engine names its stages in the language it
 * is written in; the console does the translating rather than the engine renaming its
 * own internals for a UI.
 */
const STAGES: Record<string, { label: string; note: string }> = {
  baslatiliyor: { label: "Starting", note: "Loading the champion and its source." },
  veri: {
    label: "Market data",
    note: "Downloading any candles and funding this window needs that are not cached yet. A first run on a new interval fetches a year of history.",
  },
  gauntlet: {
    label: "Gauntlet",
    note: "Checking the candidate for determinism and look-ahead before it is allowed near the grid.",
  },
  grid: {
    label: "Parameter grid",
    note: "Sweeping the parameter grid and re-running every cell across the walk-forward windows. This is the slow part, and it is the part that makes the verdict mean anything.",
  },
  stres: {
    label: "Cost stress",
    note: "Re-running the winning cell at 1.5x fees and 2x slippage.",
  },
  kasa: {
    label: "Sealed holdout",
    note: "Running the winning cell on the window no selection step has seen.",
  },
  bitti: { label: "Done", note: "Writing the run to disk." },
}

function RunningCard({ job }: { job: BacktestJobView }) {
  const percent = job.total > 0 ? (job.done / job.total) * 100 : 0
  const stage = STAGES[job.stage] ?? { label: job.stage, note: "" }
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Spinner />
          <CardTitle>Running the gauntlet</CardTitle>
        </div>
        <CardDescription>
          {job.strategyName} · {job.params.symbols.length} symbols ·{" "}
          {job.params.interval} · {job.params.days} days
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-sm">{stage.label}</span>
            <span className="tnum font-mono text-xs text-muted-foreground">
              {int(job.done)} / {int(job.total)} · {pct(percent, 0)}
            </span>
          </div>
          <Progress value={percent} />
        </div>
        {stage.note ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{stage.note}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RunHistory({
  runs,
  loading,
  activeId,
  onSelect,
}: {
  runs: BacktestRunSummary[]
  loading: boolean
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <Card size="sm" className="gap-0 py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-sm">History</CardTitle>
        <CardDescription className="text-xs">
          {loading ? "Loading…" : `${int(runs.length)} stored`}
        </CardDescription>
      </CardHeader>
      <Separator />
      {runs.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">
          Finished runs are written to disk and listed here.
        </p>
      ) : (
        <ul className="max-h-[420px] divide-y overflow-auto">
          {runs.map((run) => {
            const active = run.id === activeId
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelect(run.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    active ? "bg-muted" : "hover:bg-muted/50"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {dateTime(run.startedAt)}
                    </span>
                    {run.status === "running" ? (
                      <Spinner className="size-3" />
                    ) : (
                      <VerdictBadge verdict={run.verdict} />
                    )}
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[12px]">
                      {run.params.symbols.length}× {run.params.interval} ·{" "}
                      {run.params.days}d
                    </span>
                    <span
                      className={cn(
                        "tnum shrink-0 font-mono text-[12px]",
                        run.testPnlPct === undefined || run.testPnlPct === 0
                          ? "text-muted-foreground"
                          : run.testPnlPct > 0
                            ? "text-jade-ink"
                            : "text-clay-ink"
                      )}
                    >
                      {signedPct(run.testPnlPct)}
                    </span>
                  </div>
                  {run.finishedAt ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      took {duration(run.finishedAt - run.startedAt)}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
