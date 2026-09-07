# qalphai

A mechanical quant engine that researches, writes, tests and promotes its own trading
strategies — one cycle per night — plus an orchestrator that watches the whole thing,
and the operator console it is all driven from.

Every night the engine reads new arXiv papers, has Codex turn one of them into a
sandboxed TypeScript strategy, puts that candidate through a static validator, a
behavioural gauntlet, a grid sweep, walk-forward windows, a cost-stress run and a sealed
holdout window, and only then decides whether the current champion should be replaced.
The strategy that trades live is a file on disk with a sha256 in the champion record; the
executor refuses to trade if the two disagree.

> **Trading real money is off by default and stays off until three separate things are
> changed by hand:** `BINANCE_TESTNET=false`, `LIVE_TRADING=true`, and an explicit
> `--allow-mainnet` flag on the calling script. There is deliberately no "go live" button
> in the UI. This is research software operating on leveraged perpetual futures — you can
> lose everything you fund it with.

---

## The nightly loop

`src/orchestrator/nightly.ts` — one function, six stages. **The governing rule is: on any
failure, nothing changes.** arXiv goes down, Codex drops the connection, the candidate
will not compile, the gauntlet rejects it, the gate blocks it — in all of those the
champion is left untouched and the night reports why. Re-running the same `runId` is
harmless.

```
1  DATA        Binance mainnet klines + funding → local SQLite cache
2  CHAMPION    the incumbent is re-run tonight, on tonight's data, at tonight's costs
                 (apples to apples — its numbers are never read from an old record)
3  RESEARCH    3 arXiv queries (2 fixed + 1 of 5 rotating by day) → one pool → an LLM
                 picks the night's paper
                 and writes the hypothesis (falls back to a keyword ranker, then to REFINE)
4  CODEX       isolated temp workspace, one thread, up to 2 repair rounds fed the
                 validator's / gauntlet's own complaints
5  VALIDATION  validator → typecheck → gauntlet → grid sweep → cost stress → holdout
6  GATE        promote, or keep the champion and say which conditions failed
```

If the paper turns out to be inexpressible in our contract, Codex says so, the paper is
marked permanently seen, and the same thread is re-briefed to improve the champion against
a diagnosed weakness instead — so a night still produces a candidate. A night that learns
nothing is treated as a bug, not as a quiet no-op.

Output: `reports/nightly-YYYY-MM-DD.md`, plus the candidate and its evaluation under
`strategies/candidates/<runId>/`.

## The orchestrator

`src/orchestrator/agent/`. The nightly loop asks one question — *what is on arXiv today?*
The orchestrator asks the ones it cannot: is the live model degrading, is something in the
library worth developing, did Codex miss something, and **which of a model's own filters
are actually earning their keep**.

It runs on its own schedule (`ORCH_PRE_CRON` before the night, `ORCH_POST_CRON` after),
on a manual trigger from `/orchestrator`, or on its own when live performance breaches a
threshold. Provider-agnostic: Anthropic, any OpenAI-compatible route, or Gemini
(`src/lib/providers/`).

**It cannot put anything live, and that is structural rather than requested.** There is no
activation tool in its tool list. What it produces is written to
`strategies/candidates/` and waits on `/models` behind the same two-click operator
decision as everything else. What it *can* do unattended is steer the nightly research —
reversible, and risking no money.

| It can | It cannot |
|---|---|
| Backtest **any** model in the library, over any window | Change the champion |
| Run a six-method autopsy on a period | Send an order |
| Measure what every gate costs, in R | Weaken any wall — the validator, gauntlet and gate ignore its text |
| Produce candidates (gate surgery, or a brief to Codex) | Promote one |
| Inject directives into the nightly prompts | Loosen the rules those prompts carry |

Off by default. With `ORCH_ENABLED=false` the rest of the system is byte-identical to
before it existed — `tests/directives.test.ts` pins that, down to a single newline.

## The gate balance

`src/engine/gateAnalysis.ts`. The contract file has always told Codex that its veto rules
would be measured — *"the system runs a counterfactual for every veto rule and reports in R
whether the filter cost you money or saved you from a loss"* (`src/strategy/types.ts:182`).
That code did not exist. Every night we asked for meaningful veto rules and measured none
of them.

It exists now, and it needed no new machinery: `StrategyVeto` already carries `wouldBe`,
because the contract was designed for exactly this. Lifting a rule turns its veto into a
signal in that direction and the rest of the pipeline — allocation, simulator, costs,
intrabar resolution — runs untouched. One RECORD pass per rule; replay is already free.

Three places it refuses to guess:

- The confidence given to a lifted veto is an **assumption** (the model's own median
  signal), and every report says so — a vetoed bar never produced a confidence.
- A rule without `wouldBe` has **no counterfactual**. It is reported as unmeasurable with
  the reason, never filled in with a direction.
- If the baseline liquidated, **every verdict is meaningless** — −100% is a floor, so no
  lifting can look worse and everything reads "neutral". The analysis says this in place
  of its results rather than under them.

```bash
npx tsx scripts/gateReport.ts --days 300
```

## The five walls

Codex-written code is untrusted code that will run on the same machine as your API keys.
Five independent layers stand between it and anything that matters:

| Wall | Where | What it does |
|---|---|---|
| 1 · filesystem | `src/codex/workspace.ts` | Codex's cwd is a fresh temp dir holding the contract, a brief, two examples and an empty candidate file. No engine, no gate, no `.env`, no keys, no git history. It cannot cheat on an exam it cannot see. |
| 2 · static AST | `src/strategy/validator.ts` | TypeScript AST walk, not regex. Bans `process`/`require`/`fetch`/`eval`/`Function`/`Date`/`crypto`/timers/`Promise`, `.constructor`, `__proto__`, module-level mutable state, non-`./strategy-api` imports, oversized files. |
| 3 · type check | same file | Compiled against `strategy-api.d.ts` with `"types": []`, `lib: ES2022`. `evaluate()` does not return a `Promise`, so an `async` implementation cannot compile — no await, no I/O. |
| 4 · vm realm | `src/strategy/sandbox/worker.ts` | Runs in a `vm` context with `codeGeneration` disabled, in a worker thread. **No host object ever crosses the boundary** — the context arrives as a JSON string and is rebuilt with the realm's own `JSON.parse`, so there is no prototype chain to climb. The thread also makes an infinite loop killable. |
| 5 · behavioural | `src/strategy/gauntlet.ts` | Measures what the code *does*: determinism (two fresh processes, same output), look-ahead (every bar after the decision point is poisoned — decisions must not move), performance (ms/bar ceiling), sanity (produces signals, is selective, confidence in [0,1]). Failing here means the candidate never reaches a backtest. |

The honest caveat, stated in the code as well: Node's `vm` is not a security boundary. This
stack reliably stops accidental non-determinism, evaluation gaming and ordinary escape; it
is not proof against a determined adversary holding a fresh V8 CVE. The "adversary" is a
model we chose to run, which makes that the right trade.

## The promotion gate

`src/engine/promotion.ts`. The existential risk here is not bugs, it is multiple testing:
365 nights × ~1700 grid cells ≈ 620,000 attempts against one price history. At that scale a
random strategy generator eventually finds a cell that looks magnificent. **The gate's job
is not to find good strategies — it is to eliminate luck.**

Standalone conditions, applied *identically* to the candidate and to the incumbent:

- a grid cell actually passed the scoring filters (no highest-PnL fallback winner)
- walk-forward verdict is `ROBUST` — recomputed from the numbers, not read off a label
- ≥ 30 test trades
- still profitable under cost stress (fees ×1.5, slippage ×2)
- **holdout**: profitable, drawdown ≤ 40%, ≥ 20 trades, in a window no sweep, scoring or
  selection step ever saw
- plateau, not spike: the winning cell's neighbourhood qualifies at ≥ 1.5× the grid-wide
  rate (relative, so it survives changes in grid shape and axis count)

Comparative conditions against the champion: MAR must beat it by ≥ 10%, and entry-signal
Jaccard overlap must stay under 90% — otherwise it is the same strategy wearing a
different hat.

Two things the gate reports rather than enforces: whether the **incumbent would pass its
own gate today** (if not: rejecting the candidate is not a validation of the champion, and
the conservative action is to go flat), and whether the winning cell sits on the grid
boundary.

Shared limits live in exactly one place, `src/engine/riskLimits.ts` — `MAX_DRAWDOWN_PCT =
40`, `MIN_WINDOW_WIN_RATE = 0.75`. They used to be copied into three files and the copies
diverged, which meant the search space was selecting winners the gate could never accept.

## Backtest realism

- **Costs are modelled**: taker fee 4.5 bps both ways, ATR-proportional slippage (worse on
  stop-type exits), funding accrued while a position is open, isolated-margin liquidation
  floor. A costless backtest promotes high-frequency strategies that die on fees.
- **Mark-to-market equity curve** on every candle, not only on trade closes — so drawdown
  suffered *inside* an open position is visible. This makes historical drawdowns look
  worse, on purpose.
- **Intrabar resolution** from 1-minute candles: when one candle touches both TP and SL,
  which came first is looked up, not guessed (fallback is pessimistic).
- **Holdout is physically cut** from the selection window. Grid, walk-forward, scoring and
  cell selection all stop at `holdoutStart`.
- **RECORD × REPLAY grid**: strategy params change the decision stream (one run each);
  risk params (rr × sl × cb × risk-per-trade) replay a fixed decision stream, which makes
  that dimension nearly free. Ceiling 20,000 cells total.
- **Warmup** of 260 bars is loaded from *before* the period, so the strategy has EMA200 /
  ADX / Fibonacci history on the very first decision point.

## Live execution parity

The nastiest failure mode in a system like this is a second, "simplified" live decision
path: both sides work, both sides are green, and the strategy you measured is not the
strategy managing money. So there is no second path — live runs the same sandbox worker,
same context slice, same allocation code as the backtest, with a decision-point list of
length one (`src/engine/liveDecider.ts`).

Two places where exchange physics force a break, both written down rather than hidden:
quantity derives from the *modelled* fill (it must be known before the order) while TP/SL
derive from the *actual* fill; and breakeven is carried by us, per candle close, because
Binance has no "move stop to entry at +1R" order type.

The remaining risk is data and bar selection, which is what `scripts/parity.ts` exists to
catch. **Nothing goes to the exchange before parity is green.**

Live gates run in the same order as the simulator (`src/engine/livePlan.ts`, pure and
tested), with the exchange-only gates last — a skip there means "the backtest would have
taken this position and the exchange refused", which is logged as a divergence rather than
swallowed.

## Getting started

Requirements: **Node ≥ 20.11**, and the `codex` CLI on `PATH` if you want the nightly loop
to generate candidates.

```bash
git clone <this repo> && cd qalphai
npm install
cp .env.example .env        # Binance keys stay blank for a dry run
./start.sh                  # engine :3001 + console :3000, Ctrl+C stops both
```

`start.sh` checks the Node version, warns about missing credentials, refuses to start on a
busy port (a shifted console port would show up as blocked CORS requests instead of a
message), waits for `/api/health`, prints whether real orders are enabled, and takes both
sides down together — a console left attached to a dead engine keeps rendering stale
numbers as if they were fresh.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | engine only, watch mode (`:3001`) |
| `npm run nightly:once` | run one full research cycle now |
| `npm run live:once` | evaluate the current bar — **dry run by default**; `-- --execute` sends orders |
| `npm run backtest` | one backtest to stdout (`--days`, `--symbols`, `--no-costs`, `--single`) |
| `npm run sync` | pull klines/funding into the local cache (`--intrabar` for 1m data) |
| `npm test` | vitest — 17 files, 219 tests |
| `npm run typecheck` / `typecheck:strict` | tsc, normal and strict profile |
| `npx tsx scripts/parity.ts` | live-vs-backtest signal parity — the gate before any order |
| `npx tsx scripts/challenge.ts <file>` | race one candidate against the champion by hand |
| `npx tsx scripts/gateReport.ts` | what every gate costs, in R (`--model`, `--days`, `--risk-per-trade`) |
| `npx tsx scripts/codexSmoke.ts` | end-to-end check of the Codex integration |

### Configuration

All of it is in `.env` (see `.env.example`, which documents every key). The ones that
change behaviour most:

| Key | Default | Meaning |
|---|---|---|
| `BINANCE_TESTNET` | `true` | Order traffic target. Public market data is **always** read from mainnet — testnet history is too sparse to backtest on. |
| `LIVE_TRADING` | `false` | `false` still runs the scheduler every candle close, but dry: it logs what it would do and sends nothing. |
| `SYMBOLS` / `CANDLE_INTERVAL` | 5 majors / `4h` | The champion's universe. |
| `BACKTEST_DAYS` / `HOLDOUT_DAYS` | `540` / `90` | Selection window and sealed window. |
| `NIGHTLY_CRON` | `30 2 * * *` | UTC, pinned — local time would drift a candle at DST. |
| `LLM_*` | LiteLLM proxy / `gemini-3.6-flash` | The paper selector. Empty `LLM_BASE_URL` disables it and the night falls back to the deterministic ranker. |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT` | `gpt-5.6-sol` / `high` | The candidate writer. 30-minute turn budget. |
| `ORCH_*` | off / `anthropic` | The orchestrator. `ORCH_ENABLED=false` keeps it out of the process entirely. |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `serviceaccount.json` | Loader exists and is wired to nothing yet (see *Known gaps*). |

The console reads `NEXT_PUBLIC_API_URL`, which belongs in `frontend/.env.local` — not in
the engine's `.env`. It defaults to `http://localhost:3001/api`.

## Operator console

Next.js 16 / React 19 / Tailwind v4 / shadcn-ui, dark only. See
[`frontend/README.md`](frontend/README.md).

| Route | What it answers |
|---|---|
| `/` | What is trading right now, what it holds, what it has actually made |
| `/portfolio` | Which of the champion's symbols may take new entries |
| `/backtest` | Put a strategy through the real gauntlet and read the verdict |
| `/models` | What could go live — builtin, past champions, evaluated candidates — with the gate's verdict on each |
| `/orchestrator` | What the orchestrator is doing, what it steered, what it produced |
| `/reports` | The engine's own account of each nightly cycle |

Two rules the console follows. **Every number comes from the engine** — win rate, profit
factor, expectancy and every verdict arrive already computed from the same functions the
promotion gate uses, because a panel-side "win rate" would be a second truth about the same
account. **Absent is not zero** — an unreadable mark price renders as an em dash, never as
`0`, since telling an operator a position is flat when its price is merely unknown is how
the next trade gets sized wrong.

Manual activation on `/models` deliberately bypasses the promotion gate — that is the point
of the screen — but the record keeps `activatedBy: "operator"` alongside the gate's
blockers, so no later report can read a manual pick as an approval. Switching models never
closes a position; the inherited positions keep being managed.

## HTTP API

Express, mounted at `/api` (`src/api/routes.ts`). This layer computes nothing; it calls the
engine.

```
GET  /health                     mode, network, keys, interval, cron
GET  /overview                   champion record, universe, wallet, live stats
GET  /live                       open positions (+ exchange marks), closed trades, stats
POST /live/run                   evaluate the current bar now
GET  /portfolio                  per-symbol tickers, live history, profile spec
PUT  /portfolio                  enable/disable symbols (champion's universe only)
GET  /models                     everything activatable, with the gate's verdict
POST /models/:id/activate        make one the champion (audited bypass)
GET  /backtest/runs              history + whether one is running
POST /backtest/runs              start a run (one at a time)
GET  /backtest/runs/:id          progress, then the full report incl. the whole grid
GET  /reports  ·  /reports/:name nightly reports
POST /nightly/run                trigger a research cycle (202, fire-and-forget)
GET  /orchestrator               status, compute queue, live-health trigger
POST /orchestrator/run           start a run (202, fire-and-forget, single-flight)
GET  /orchestrator/runs  ·  /:id history, then steps and tool calls
GET  /orchestrator/directives    what is currently steering the nightly loop
DEL  /orchestrator/directives/:id  revoke one
```

`POST /backtest/runs` takes an optional `modelId` (anything from `/models`) and `endDate`.
Without them it behaves exactly as before: the champion, ending now.

Heavy work from all three claimants — the nightly loop, panel backtests and the
orchestrator — passes through one FIFO (`src/engine/computeQueue.ts`) and its depth is on
`/health`. Two grids on one CPU starve each other and corrupt the duration measurements;
the three single-flight locks that already existed did not know about each other.

## Repo layout

```
src/
  index.ts            express app + both cron schedulers
  config/             env, portfolio (operator's on/off list), firebase loader
  orchestrator/       nightly loop, champion record, model ledger, report, weakness diagnosis
    agent/            the orchestrator — loop, tools, system prompt, run state
                      autopsy.ts (six methods) · directives.ts (nightly steering)
  research/           arXiv client, query rotation, LLM selector, keyword fallback ranker
  codex/              app-server JSON-RPC client, driver, isolated workspace, prompts
  strategy/           the contract (types.ts), validator, sandbox host/worker, gauntlet,
                      gate surgery (AST: turn a filter into a swept parameter)
    builtin/          mechanicalV0 — the seed champion, and Codex's worked example
  engine/             backtest grid, simulator, cost model, walk-forward, scoring,
                      promotion gate, portfolio/risk, live decider/plan/executor,
                      gate balance (counterfactuals), market context, compute queue
  services/           binanceClient (public, mainnet) · binanceOrders (signed, testnet)
  lib/                SQLite kline store, live ledger, trade log, LLM client, rate limiter,
                      agentLlm + providers/ (tool-calling, three vendors), web search
  vendor/             technical indicators
scripts/              backtest · challenge · liveOnce · parity · syncData · codexSmoke
                      gateReport
tests/                17 vitest files, incl. golden fixtures ported from the reference impl
frontend/             the operator console (its own package.json)
```

Runtime state, all gitignored and all regenerable: `data/market.db` (klines, funding, 1m
intrabar), `data/live-state.json` (the ledger), `data/live-trades.jsonl` (append-only
history), `data/backtests/`, `data/orchestrator/` (runs + directives), `.cache/` (indicator series), `strategies/` (champion record,
immutable champion sources, candidates, seen papers), `reports/`, `.codex-work/`.

## Tests

```bash
npm test        # 219 tests, ~10s
```

The suite covers the parts where a silent bug would be expensive rather than the parts that
are easy to test: golden fixtures pinning the ported cost/metric/decider maths bit-for-bit,
validator and sandbox escape attempts (including "the look-ahead test would go red if the
poisoned candle leaked", and an infinite loop that must kill its worker without deadlocking
the pool), promotion-gate boundaries, live-plan gate ordering, and live/backtest decider
parity.

## Going live — the actual order

1. `npm run sync -- --intrabar` and let the cache fill.
2. `npm test` and `npm run typecheck:strict`.
3. `npx tsx scripts/parity.ts` — **must be green.** If it is not, the live engine is
   running a different strategy from the one that was measured, and every number the gate
   produced is about something else.
4. Watch it dry (`LIVE_TRADING=false`) for several candle closes and read the decision
   reports: "0 positions" has four completely different causes and the report names which.
5. Testnet keys, `LIVE_TRADING=true`, `BINANCE_TESTNET=true`.
6. Mainnet only after that, and only by deliberately setting `BINANCE_TESTNET=false` plus
   passing `--allow-mainnet`.

## Known gaps

- **Firebase is unwired.** `firebase-admin` is installed and `src/config/firebase.ts` loads
  and validates a service account, but nothing imports it — all state is local files and
  SQLite. `start.sh` and `.env.example` still warn about a missing `serviceaccount.json`;
  in current code that warning is harmless.
- **`nodemailer` and `sharp` are installed but unused** — notification mail and heatmap
  rendering are configured (`SMTP_*`, `NOTIFICATION_EMAIL`) but not yet called.
- **Package name drift**: root `package.json` still says `tradecraftai`; the console,
  `start.sh` and the docs say `qalphai`.
- The keyword ranker (`src/research/ranker.ts`) is a fallback whose own comments record why
  it was demoted — it answers "is this paper implementable in our contract?" by counting
  words, and that question is not answerable that way.
