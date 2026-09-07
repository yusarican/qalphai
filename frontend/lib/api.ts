/**
 * The console's only point of contact with the engine (src/api/routes.ts).
 *
 * No number displayed anywhere in this app is computed here. Win rate, profit factor,
 * expectancy and every verdict arrive already calculated by the engine, from the same
 * functions the nightly promotion gate uses. A "panel-side" win rate would be a second
 * truth about the same account, and once the two disagreed nobody could say which one
 * was the real one.
 *
 * The second rule: null stays null. When the exchange cannot be read, a mark price
 * arrives as null and the console renders an em dash. It never renders 0 — telling an
 * operator a position is flat when its price is merely unknown is how people size the
 * next trade wrong.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api"

export type Side = "LONG" | "SHORT"
export type Verdict = "ROBUST" | "FRAGILE" | "FAILED"
export type Profile = "conservative" | "balanced" | "aggressive"
export type Interval = "1h" | "4h" | "1d"
export type ExitReason = "STOP" | "PROFIT" | "SIGNAL_CHANGE"

/* ------------------------------------------------------------------ trades --- */

export interface LoggedTrade {
  symbol: string
  side: Side
  championId: string
  entryTime: number
  exitTime: number
  entryFill: number
  qtyBase: number
  margin: number
  leverage: number
  confidence: number
  riskUSD: number
  reason: ExitReason
  realizedPnl: number
  /** Exchange P&L could not be read — this trade counts toward no statistic. */
  pnlUnknown: boolean
  /** Closed during a dry run. Not real money, kept apart from the real ledger. */
  dryRun: boolean
}

export interface LiveStats {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  totalPnl: number
  grossProfit: number
  grossLoss: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  expectancyR: number
  bestTrade: LoggedTrade | null
  worstTrade: LoggedTrade | null
  equity: { timestamp: number; cumulativePnl: number }[]
  unknownPnlTrades: number
}

export interface LivePosition {
  symbol: string
  side: Side
  entryTime: number
  entryFill: number
  qtyBase: number
  margin: number
  leverage: number
  confidence: number
  riskUSD: number
  initialStopPrice: number
  activationPrice?: number
  callbackRate?: number
  decisionBar: number
  /** null when the exchange could not be read. */
  markPrice: number | null
  unrealizedPnl: number | null
  /** Distance travelled in units of the entry stop. */
  rMultiple: number | null
}

/* ------------------------------------------------------------------ engine --- */

export interface EngineState {
  testnet: boolean
  liveTrading: boolean
  hasKeys: boolean
  lastRunAt?: number | null
  openPositions?: number
}

export interface Health {
  ok: boolean
  testnet: boolean
  liveTrading: boolean
  hasKeys: boolean
  interval: Interval
  nightlyCron: string
}

export interface ChampionEvaluation {
  verdict: string
  testPnlPct: number
  testMar: number
  testMaxDDPct: number
  testTrades: number
  windowsPositive: number
  windowCount: number
  stressPnlPct: number
  holdoutPnlPct: number
  holdoutMaxDDPct: number
  qualifiedNeighbors: number
  feeShareOfGross: number
}

export interface Overview {
  champion: {
    id: string
    name: string
    /** false → the built-in strategy is running, nothing has been promoted yet. */
    promoted: boolean
    author: "human" | "codex"
    version: number
    promotedAt: number | null
    profile: Profile
    interval: Interval
    params: Record<string, number | boolean>
    risk: Record<string, number>
    provenance: {
      arxivId?: string
      arxivTitle?: string
      hypothesis?: string
    } | null
    evaluation: ChampionEvaluation | null
    liveEnabled: boolean
    /**
     * The strategy's own grid axis — the parameters a backtest sweeps.
     *
     * A run's total is `sweep.cells × risk cells`, so the console needs this number to
     * tell the operator the truth before the run: a risk grid that looks small on its
     * own can be an order of magnitude over the ceiling once the strategy axis
     * multiplies it. Switching "fixed params" on drops the multiplier to 1.
     */
    sweep: {
      cells: number
      /** The strategy's own ceiling on its parameter grid (meta.maxSweepCells). */
      maxCells: number
      axes: { key: string; values: (number | boolean)[] }[]
    }
  }
  /** The full symbol set the champion was measured on. */
  universe: string[]
  /** Universe minus what the operator switched off. */
  symbols: string[]
  disabled: string[]
  engine: EngineState
  balance: { totalWalletBalance: number; availableBalance: number } | null
  stats: LiveStats
  hasData: boolean
}

export interface LiveView {
  champion: { id: string; name: string; interval: Interval; profile: Profile }
  engine: EngineState
  lastRunAt: number | null
  positions: LivePosition[]
  stats: LiveStats
  trades: LoggedTrade[]
  hasData: boolean
}

export interface LiveAction {
  symbol: string
  side: Side
  kind: "OPENED" | "SKIPPED" | "CLOSED" | "BREAKEVEN" | "FAILED"
  reason?: string
  qtyBase?: number
  margin?: number
  leverage?: number
  entryFill?: number
  stopPrice?: number
  takeProfitPrice?: number
  riskUSD?: number
}

export interface Allocation {
  symbol: string
  side: Side
  confidence: number
  leverage: number
  allocationPercent: number
  reason: string
}

export interface Rejection {
  symbol: string
  rule: string
  side?: Side
  confidence?: number
  note?: string
}

export interface LiveRunResult {
  decisionBar: number
  dryRun: boolean
  testnet: boolean
  champion: string
  balance: number
  availableMargin: number
  symbols: string[]
  disabled: string[]
  allocations: Allocation[]
  rejections: Rejection[]
  /** Evaluated, produced neither a signal nor a veto — the strategy said "wait". */
  noSignal: string[]
  actions: LiveAction[]
  /** Open on the exchange but absent from the ledger. The engine will not touch these. */
  unmanaged: string[]
  /** Positions the backtest would have taken and the exchange refused. */
  divergences: LiveAction[]
  /** Decision bars that closed while the engine was down and were never evaluated. */
  skippedBars: number
}

/* --------------------------------------------------------------- portfolio --- */

export interface PortfolioAsset {
  symbol: string
  enabled: boolean
  hasOpenPosition: boolean
  price: number | null
  change24h: number | null
  volume24h: number | null
  live: { trades: number; winRate: number | null; pnl: number }
}

export interface PortfolioView {
  champion: { id: string; name: string; profile: Profile; interval: Interval }
  assets: PortfolioAsset[]
  disabled: string[]
  updatedAt: number | null
  profileSpec: {
    leverageByVol: [number, number, number]
    baseAllocationPct: number
    maxTotalAllocationPct: number
  }
  maxLeverage: number
  engine: { liveTrading: boolean; testnet: boolean }
}

export interface PortfolioSaveResult {
  disabled: string[]
  updatedAt: number
  enabled: string[]
  /** Switched off while a position is still open — it keeps being managed. */
  openOnDisabled: { symbol: string; side: Side }[]
}

/* ------------------------------------------------------------------ models --- */

/** The promotion gate's verdict on a model. Shown, never enforced, on this screen. */
export interface ModelGate {
  promote: boolean
  blockers: string[]
  warnings: string[]
  /** Would the CURRENT champion pass the same gate today? null when not evaluated. */
  incumbentQualified: boolean | null
}

export interface ModelEvaluation {
  verdict: string
  testPnlPct: number
  testMar: number
  testMaxDDPct: number
  testTrades: number
  windowsPositive: number
  windowCount: number
  stressPnlPct: number
  holdoutPnlPct: number
  holdoutMaxDDPct: number
  qualifiedNeighbors: number
  feeShareOfGross: number
}

export interface ModelListing {
  id: string
  origin: "builtin" | "candidate" | "champion"
  name: string
  strategyId: string
  version: number
  author: "human" | "codex"
  codePath: string
  codeSha256: string
  isChampion: boolean
  /** false → cannot be activated; blockedReason says why (missing code, sha mismatch). */
  runnable: boolean
  blockedReason?: string
  params: Record<string, number | boolean>
  risk: Record<string, number>
  symbols: string[]
  interval: string
  profile: string
  provenance?: { arxivId?: string; arxivTitle?: string; hypothesis?: string }
  /** null for the builtin: it never sat an exam, and inventing numbers would be worse. */
  evaluation: ModelEvaluation | null
  gate: ModelGate | null
  at: number
  activatedBy?: "gate" | "operator"
}

export interface ActivateResult {
  champion: { id: string; name: string; version: number }
  activatedBy: "gate" | "operator"
  /** false → the operator knowingly picked a model the gate rejected. */
  gatePassed: boolean
  gate: ModelGate | null
  /** Positions carried over. Switching models never closes anything. */
  inheritedPositions: { symbol: string; side: Side }[]
  liveEnabled: boolean
}

/* ---------------------------------------------------------------- backtest --- */

/**
 * The risk axes the engine sweeps. Values must be ascending — the engine sorts them on
 * the way in, because the plateau score reads ±1 on an axis as "the next value tried",
 * and an unsorted axis would make that neighbourhood measure nothing.
 */
export interface GridSpec {
  rewardRatios: number[]
  slMultipliers: number[]
  callbackMultipliers: number[]
  /** Fraction of balance risked per trade. 0.05 = 5%. */
  riskPerTradePcts: number[]
}

export const DEFAULT_GRID: GridSpec = {
  rewardRatios: [2, 3.5, 5, 6.5],
  slMultipliers: [0.8, 1.5, 2.2],
  callbackMultipliers: [0.8, 1.5],
  riskPerTradePcts: [0.01, 0.02, 0.035, 0.05],
}

/**
 * The engine's ceiling on total cells (strategy × risk), mirrored so the console can
 * refuse an oversized grid before the operator waits through a data sync. The engine
 * checks it again on the way in — this copy exists for the message, not the authority.
 */
export const MAX_CELLS = 20_000

export interface BacktestParams {
  symbols: string[]
  interval: Interval
  days: number
  profile: Profile
  initialBalance: number
  noCosts: boolean
  fixedParams: boolean
  /** Absent when the run used the engine's default grid. */
  grid?: GridSpec
}

export interface GridAxis {
  name: string
  values: Array<number | boolean>
}

/** One swept combination, as the report shows it. */
export interface GridCellRow {
  /** Position on each axis, in the same order as `axes`. */
  idx: number[]
  /** Set when the cell was disqualified — every score below is then null. */
  dq: string | null
  /** Plateau-pooled final score. The winner is the argmax of this. */
  score: number | null
  testPnlPct: number
  testDDPct: number
  testTrades: number
  testWinRate: number
  testSharpe: number
  trainPnlPct: number
  trainDDPct: number
  fullPnlPct: number
  /** Day-normalised test/train P&L ratio. Null when train is ~flat. */
  testTrainRatio: number | null
  windowsPositive: number
  windowCount: number
  dqNeighbors: number
}

export interface BacktestResults {
  finalBalance: number
  totalPnl: number
  totalPnlPercent: number
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  maxDrawdown: number
  maxDrawdownPercent: number
  sharpeRatio: number
  sortinoRatio: number
  mar: number
  cagr: number
  profitFactor: number
  avgTradeReturn: number
  expectancyR: number
  totalFeesUSD: number
  totalFundingUSD: number
  feeShareOfGross: number
  turnoverUSD: number
  bestTrade: { symbol: string; pnl: number; pnlPercent: number } | null
  worstTrade: { symbol: string; pnl: number; pnlPercent: number } | null
}

export interface BacktestRunResult {
  id: string
  strategyName: string
  params: BacktestParams
  startedAt: number
  finishedAt: number
  durationMs: number
  verdict: Verdict
  /** The winning cell failed the scoring filters — this is a best-effort result. */
  fallbackUsed: boolean
  full: BacktestResults
  /** The slice selection never used. This is the number that counts. */
  test: BacktestResults
  /** Test slice under fee x1.5 / slippage x2. */
  stress: BacktestResults | null
  /** The window no part of the selection path ever saw. */
  holdout: BacktestResults | null
  best: {
    params: Record<string, number | boolean>
    risk: Record<string, number>
    plateauScore: number | null
    windowsPositive: number
    windowCount: number
    qualifiedNeighbors: number
  }
  equityCurve: { timestamp: number; balance: number }[]
  trades: {
    symbol: string
    side: Side
    entryTime: number
    exitTime: number
    exitReason: string
    leverage: number
    pnl: number
    pnlPercent: number
    pnlR: number | null
    confidence: number
  }[]
  exitReasons: { reason: string; count: number }[]
  skips: { rule: string; count: number }[]
  disqualifications: { reason: string; label: string; count: number }[]
  gridCells: number
  /**
   * The whole grid, not just the winner. A plateau is a property of a neighbourhood,
   * so showing the chosen cell without the cells around it would make the plateau
   * score an assertion nobody can check.
   *
   * Optional because runs written before the engine started storing the grid are still
   * on disk and still worth reading. The report hides the surface for those rather than
   * inventing one.
   */
  axes?: GridAxis[]
  cells?: GridCellRow[]
  bestIndex?: number
}

export interface BacktestRunSummary {
  id: string
  status: "running" | "done" | "failed"
  params: BacktestParams
  strategyName: string
  startedAt: number
  finishedAt?: number
  verdict?: Verdict
  testPnlPct?: number
}

export interface BacktestJobView {
  id: string
  status: "running" | "done" | "failed"
  stage: string
  done: number
  total: number
  error: string | null
  params: BacktestParams
  strategyName: string
  result: BacktestRunResult | null
}

/* ------------------------------------------------------------------- fetch --- */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: { "content-type": "application/json", ...init?.headers },
    })
  } catch {
    // A dead engine is a specific, actionable condition — not a generic failure.
    throw new ApiError(`Engine unreachable at ${API_BASE}`, 0)
  }

  if (!res.ok) {
    // The engine sends {error} for everything it rejects on purpose. Surfacing that
    // text verbatim matters: "symbol not in the champion's universe" tells the
    // operator what to do, "Request failed" does not.
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      /* not JSON — keep the status line */
    }
    throw new ApiError(message, res.status)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/* ----------------------------------------------------------- orchestrator --- */

export type DirectiveTarget =
  | "arxiv-queries"
  | "paper-triage"
  | "paper-final"
  | "codex-new"
  | "codex-refine"

export interface Directive {
  id: string
  target: DirectiveTarget
  text: string
  rationale: string
  createdAt: number
  expiresAt: number | null
  createdBy: "orchestrator" | "operator"
  runId: string
  revoked: boolean
}

export interface QueueEntry {
  id: number
  kind: "nightly" | "panel-backtest" | "orchestrator"
  label: string
  enqueuedAt: number
  startedAt?: number | null
}

export interface QueueStatus {
  active: QueueEntry | null
  waiting: QueueEntry[]
  depth: number
}

export interface LiveHealth {
  breached: boolean
  reasons: string[]
  stats: {
    trades: number
    expectancyR: number
    totalPnl: number
    consecutiveLosses: number
  }
}

export interface OrchestratorStatus {
  enabled: boolean
  provider: string
  model: string
  running: boolean
  currentRunId: string | null
  preCron: string
  postCron: string
  maxSteps: number
  maxBacktests: number
  webSearch: string | null
  queue: QueueStatus
  liveHealth: LiveHealth
}

export interface RunStep {
  n: number
  at: number
  text: string
  toolCalls: Array<{
    name: string
    input: unknown
    ok: boolean
    summary: string
    ms: number
  }>
  usage: { inTokens: number; outTokens: number }
}

export interface OrchestratorRunSummary {
  id: string
  task: string
  trigger: "pre-nightly" | "post-nightly" | "manual" | "live-threshold"
  status: "running" | "done" | "failed" | "stopped"
  startedAt: number
  finishedAt?: number
  provider: string
  model: string
  tokensUsed: number
  backtestsRun: number
  summary?: string
  error?: string
  /** Candidate ids the run produced. None of them is live — activation stays manual. */
  producedCandidates: string[]
  directives: string[]
  reportPath?: string
  stepCount: number
}

export type OrchestratorRun = Omit<OrchestratorRunSummary, "stepCount"> & {
  steps: RunStep[]
}

export const api = {
  health: () => request<Health>("/health"),
  overview: () => request<Overview>("/overview"),

  live: () => request<LiveView>("/live"),
  /**
   * Ask the engine to evaluate the current bar now.
   *
   * Whether this sends real orders is decided by the engine's LIVE_TRADING deploy
   * flag, never by the console. There is deliberately no "trade for real" switch in
   * this UI: sending money is a deployment decision, not a click.
   */
  runLive: () => request<LiveRunResult>("/live/run", { method: "POST" }),

  portfolio: () => request<PortfolioView>("/portfolio"),
  savePortfolio: (disabled: string[]) =>
    request<PortfolioSaveResult>("/portfolio", {
      method: "PUT",
      body: JSON.stringify({ disabled }),
    }),

  models: () => request<{ models: ModelListing[] }>("/models"),
  /**
   * Make a model the champion. Deliberately bypasses the promotion gate — that is the
   * point of the screen — but the engine records `activatedBy: "operator"` and keeps
   * the gate's verdict on the record, so no report can later read a manual pick as an
   * approval. Open positions are carried over, never closed.
   */
  activateModel: (id: string) =>
    request<ActivateResult>(`/models/${encodeURIComponent(id)}/activate`, {
      method: "POST",
    }),

  backtestRuns: () =>
    request<{ running: boolean; runs: BacktestRunSummary[] }>("/backtest/runs"),
  startBacktest: (params: Partial<BacktestParams>) =>
    request<{ id: string; status: string }>("/backtest/runs", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  backtestRun: (id: string) => request<BacktestJobView>(`/backtest/runs/${id}`),

  /**
   * Start the nightly research loop by hand. Fire-and-forget on the engine side —
   * a full night is grid + walk-forward + Codex and runs for hours, so this returns
   * as soon as the run is accepted, not when it finishes.
   */
  runNightly: () => request<{ status: string }>("/nightly/run", { method: "POST" }),

  /**
   * The orchestrator's status: whether it is configured, what it is running, and the
   * shared compute queue behind it. Cheap — reads configuration and local files only.
   */
  orchestrator: () => request<OrchestratorStatus>("/orchestrator"),

  /**
   * Start an orchestrator run. Fire-and-forget: a run can take hours, so this returns
   * as soon as the run is accepted.
   *
   * There is deliberately **no** way to activate a model from here, or from anywhere
   * the orchestrator can reach. It produces candidates; a human promotes them on
   * /models. That is a structural limit in the engine, not a rule of this UI.
   */
  runOrchestrator: (body: { task?: string; preset?: "pre-nightly" | "post-nightly" }) =>
    request<{ runId: string; status: string }>("/orchestrator/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  orchestratorRuns: () =>
    request<{
      running: boolean
      currentRunId: string | null
      runs: OrchestratorRunSummary[]
    }>("/orchestrator/runs"),

  orchestratorRun: (id: string) =>
    request<OrchestratorRun>(`/orchestrator/runs/${encodeURIComponent(id)}`),

  directives: () => request<Directive[]>("/orchestrator/directives"),
  revokeDirective: (id: string) =>
    request<{ status: string }>(`/orchestrator/directives/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  reports: () => request<string[]>("/reports"),
  report: async (name: string) => {
    const res = await fetch(`${API_BASE}/reports/${encodeURIComponent(name)}`, {
      cache: "no-store",
    })
    if (!res.ok) throw new ApiError(`Report not found: ${name}`, res.status)
    return res.text()
  },
}
