# Tech stack

Everything qalphai runs on, and — where it matters — why that choice and not the obvious
alternative. Two independent packages: the engine at the repo root and the console under
`frontend/`.

## At a glance

| Layer | Choice |
|---|---|
| Language | TypeScript 5.7, `strict` + `noImplicitOverride` |
| Runtime | Node ≥ 20.11 — CommonJS on the engine, ESM in the console |
| Engine dev/exec | `tsx` (watch + direct `.ts` execution), `tsc` for builds |
| HTTP | Express 4 + `cors` |
| Scheduling | `node-cron`, pinned to `Etc/UTC` |
| Storage | SQLite via `better-sqlite3` (WAL) + JSON / JSONL files |
| Isolation | `node:worker_threads` + `node:vm` realms |
| Static analysis | TypeScript Compiler API (AST walk + in-memory compile) |
| Validation | `zod` (LLM responses) |
| HTTP client | `axios` |
| XML | `fast-xml-parser` (arXiv Atom) |
| AI — code | `codex app-server` over JSON-RPC on stdio, `gpt-5.6-sol`, effort `high` |
| AI — selection | OpenAI-compatible route (LiteLLM proxy → `gemini-3.6-flash`) |
| Market data | Binance USDⓈ-M Futures REST (public: mainnet · signed: testnet by default) |
| Research source | arXiv Atom API (abstracts only) |
| Tests | `vitest` 2 — 12 files, 159 tests |
| Console | Next.js 16 (App Router) · React 19 · Tailwind v4 · shadcn/ui on `@base-ui/react` |
| Charts | Recharts 3 |
| Console extras | `next-themes`, `sonner`, `lucide-react`, `react-markdown` + `remark-gfm`, `clsx`, `tailwind-merge`, `class-variance-authority` |
| Console tooling | ESLint 9 (`eslint-config-next`), Prettier 3 + `prettier-plugin-tailwindcss` |

Scale: ~18.1k lines of TypeScript across `src/`, `scripts/` and `tests/`; ~8.1k in the
console.

---

## Engine

### TypeScript, CommonJS, `tsx`

`tsconfig.json` targets ES2022 and emits CommonJS with `strict`. CommonJS is not
incidental: the sandbox host loads its worker with `--require tsx/cjs` in development,
because the ESM path (`--import tsx`) cannot resolve the extensionless relative imports
this codebase uses. `tsconfig.strict.json` is a second, stricter profile run separately
(`npm run typecheck:strict`) so tightening it does not block the normal build.

`tsx` runs `.ts` directly in dev, in the CLI scripts and in the sandbox worker; `tsc` is
only for `dist/`. The sandbox host detects which mode it is in from its own `__filename`
extension and picks the matching worker file.

### Express 4 + cors

A thin JSON API. It is a *transport*, not a layer with opinions: no endpoint computes a
metric. Win rate, profit factor, verdicts and the promotion decision all come out of engine
functions, so the console and the nightly report cannot disagree about the same account.
CORS origin is pinned to `FRONTEND_URL` rather than left open.

Long work never blocks a request: backtests and nightly runs return an id or a `202` and
are polled. Both have a single-flight lock — two grids on one CPU starve each other and
corrupt the duration measurements.

### node-cron, UTC

Two schedules. The nightly loop at `NIGHTLY_CRON` (default 02:30 UTC — daily candle closed,
funding settled). The live executor at every candle close plus one minute (`1 */4 * * *` for
4h), giving Binance time to serve the closed candle without changing which bar the strategy
sees.

`timezone: 'Etc/UTC'` is deliberate: Binance candles close on UTC boundaries, and a local
timezone means the loop runs a candle off across a DST transition — the kind of bug found
months later as "why was that week strange?". Both schedules hold a re-entrancy lock, since
two processes must never write the same champion file or send a second order on the same
decision bar.

### better-sqlite3, not Firestore

The intrabar resolver needs **1-minute** candles to answer "this candle touched both TP and
SL — which came first?". A year × 6 symbols at 1m is ~3M rows; in Firestore that is 3M
document writes.

But the real reason is architectural, not cost: **SQLite reads are synchronous.** In the
reference implementation the only `async` leaf in the simulator was a lazy network fetch of
1m candles, and that single leaf made the whole replay grid impossible to parallelise. With
the data sitting locally the simulator is fully synchronous and CPU-bound, which is exactly
what a worker pool can spread. WAL mode lets every worker open its own read-only handle
concurrently.

State that is not time series stays in plain files, deliberately chosen per access pattern:
`live-state.json` (the ledger — a gate state, pruned every run), `live-trades.jsonl`
(append-only history, one closed trade per line, a corrupt line skipped rather than
dropping the whole past), `strategies/champion.json` + immutable per-version strategy
sources, `data/backtests/*.json`, `reports/*.md`.

### worker_threads + vm

One mechanism, two jobs. Untrusted strategy code **must** run off the main thread, because
an infinite loop inside a `vm` context can only be stopped by `worker.terminate()`. The same
pool then parallelises the grid's RECORD dimension — the price paid for isolation buys the
speed back.

Inside each worker, a `vm` context created from `Object.create(null)` with
`codeGeneration: { strings: false, wasm: false }`, seeded with only deterministic
intrinsics: `Math`, `JSON`, `Object`, `Array`, `Number`, `String`, `Boolean`, `Map`, `Set`,
`Error` and the numeric parsers. No `Date`, no `console`, no timers, no `Math.random` path
that matters.

The load-bearing rule: **no host object ever crosses into the realm.** The strategy context
is passed as a JSON *string* and rebuilt by the realm's own `JSON.parse`, with the realm's
own `Object` prototype. Hand a plain host object in and a strategy reaches the host through
`ctx.constructor.constructor('return process')()` — the standard `vm` escape. Node's `vm` is
not a security boundary and the code says so; the stack is calibrated against accidental
non-determinism and evaluation gaming, not against a fresh V8 CVE.

### TypeScript Compiler API as a validator

`src/strategy/validator.ts` walks the AST rather than matching text. Regex produces both
false positives (`eval` inside a comment) and false negatives
(`globalThis['ev'+'al']`); in an AST an identifier either *is* `eval` or is not. It also
compiles the candidate in memory against a generated `strategy-api.d.ts` with
`"types": []` and `lib: ["ES2022"]`, so `process` / `require` / `fetch` / `Buffer` cannot
even type-check.

The contract file `src/strategy/types.ts` has **zero imports** on purpose, so it can be
copied verbatim into the sandbox workspace as `strategy-api.d.ts`. Constraints are
structural, not requested politely in a prompt: `evaluate()` does not return a `Promise`
(async cannot compile → no await → no I/O), and the return type has no `size`, `leverage`,
`stopLoss` or `takeProfit` fields, so a strategy is physically unable to express position
sizing or leverage. Those belong to the harness alone.

### Codex over JSON-RPC

`codex app-server` is spawned as a child process and driven over newline-framed JSON-RPC on
stdio (`src/codex/appServer.ts`, `driver.ts`) in headless mode — no browser, no stdin. Turn
timeout 30 minutes, because the REFINE fallback runs as a *second* turn in the same thread
and high-effort reasoning overruns a single-turn budget.

Protocol field names were read from `codex app-server generate-json-schema`, not guessed:
the reasoning-effort field is `effort`, not `modelReasoningEffort`. A wrong key would be
silently ignored and the night would quietly run at a lower effort than intended — so the
driver additionally *verifies* the model the turn reports and fails loudly on a mismatch.

Repair rounds reuse the same thread, so Codex keeps its reasoning context while it is fed
the validator's or the gauntlet's own complaints.

### LLM paper selection

A ~60-line `axios` client (`src/lib/llm.ts`) against an OpenAI-compatible route rather than
a vendor SDK — the need is "send a system + user message, get JSON back", and an SDK would
enlarge the version surface for nothing.

Two things it hard-codes. **Parsing JSON is a contract**: the response is tolerantly
extracted (models wrap in fences, models write preambles) and then validated with `zod`; a
schema miss throws rather than handing a half-correct object onward. **Every failure must be
recoverable**: 429/5xx/timeout are retried, and exhaustion throws cleanly so the caller can
drop to the deterministic path. Note that a thinking model spends reasoning tokens from the
same `max_tokens` budget, so the default is generous — a tight budget returns empty JSON
with `finish_reason: length`.

Selection itself is map-reduce: triage the whole pool in batches of 20 with shortened
abstracts (easy per-paper judgement), then compare a handful of finalists on full abstracts
in one call (the real judgement). One call over 300 abstracts puts the decision exactly
where attention is weakest, and the pick drifts toward the top of the list.

`src/research/ranker.ts` is the keyword fallback, kept for when the proxy is down. Its own
comments are the evidence log for why it was demoted.

### Binance: two clients on purpose

- `binanceClient.ts` — **public** data, always from `fapi.binance.com` (mainnet), even when
  testnet is enabled, because testnet's historical candles are sparse and unreliable. Holds
  a weight budget (1800/min of Binance's 2400, leaving room for other processes), reads
  `x-mbx-used-weight-1m`, backs off on 429, and **fails loudly on 418** — retrying an IP ban
  extends it.
- `binanceOrders.ts` — **signed** traffic, which goes to testnet whenever
  `BINANCE_TESTNET=true`. Two files rather than one so "which environment am I sending to?"
  is answerable in a single line.

The order client differs from a naive implementation in four ways that each cost money to
learn: errors **throw** instead of returning `{ price: 0 }` (a silent zero is the shortest
path to a wrongly sized order); exchange filters are enforced (`LOT_SIZE.stepSize`,
`MIN_NOTIONAL`, `PRICE_FILTER.tickSize`, quantity rounded **down**); orders carry a
`clientOrderId` and a dropped POST is re-queried rather than blindly retried (a blind retry
is a double position); and server clock skew is compensated once, since Binance rejects
timestamps outside `recvWindow` with -1021.

### arXiv

Atom API, **abstracts only, never PDFs** — title plus summary is enough to decide whether an
edge is expressible in our contract, and PDF parsing buys a parsing hell plus a ToS grey
area. arXiv wants ≥ 3s between requests and answers a violation with 503, so a
module-level single-flight queue enforces the gap whether or not the caller remembers.

### vitest

Chosen for speed and for running `.ts` with no build step. The suite is weighted toward
places where a silent bug is expensive: golden fixtures pinning ported cost / metric /
decider maths bit-for-bit against the reference implementation, sandbox escape attempts,
a look-ahead test that itself is verified to go red when a poisoned candle leaks, an
infinite loop that must kill its worker without deadlocking the pool, promotion-gate
boundaries, and live-vs-backtest decider parity.

### Installed but not yet wired

`firebase-admin` (a validated service-account loader exists at `src/config/firebase.ts`;
nothing imports it), `nodemailer` (notification mail — `SMTP_*` keys are read, never used),
`sharp` (heatmap rendering). All state is currently local.

---

## Console (`frontend/`)

### Next.js 16 App Router · React 19

Every route is a client component, because the console is live data: five pages
(`/`, `/portfolio`, `/backtest`, `/models`, `/reports`), each polling on its own clock via
`hooks/use-poll.ts` — which pauses when the tab is hidden and retains last-good data
through an error. The clocks are separate on purpose: `/live` changes constantly, the
champion record and wallet do not, and both hit the exchange under the engine's shared
weight budget, so "refresh everything every second" competes with the live executor for the
same rate limit.

`lib/api.ts` is the single point of contact with the engine and mirrors `src/api/routes.ts`
as types. Its two rules: a dead engine is reported as a specific, actionable condition
(`Engine unreachable at …`), and the engine's own `{error}` text is surfaced verbatim —
"symbol not in the champion's universe" tells the operator what to do, "Request failed" does
not.

There is deliberately **no live-trading switch in the UI**. Sending money is a deployment
decision (`LIVE_TRADING` in `.env`), not a click.

### Tailwind v4 · shadcn/ui on base-ui

Tailwind v4 via `@tailwindcss/postcss`; tokens (palette, type) live in
`app/globals.css`. The shadcn primitives are the `@base-ui/react` flavour, so composition
uses the `render` prop, not `asChild`.

**Dark only, hardcoded** on `<html>` in `app/layout.tsx` — not a theme switcher. One
appearance means there is no second palette to keep in step, and no way for a P&L colour
validated on one surface to be rendered on another. (`next-themes` and
`components/theme-provider.tsx` are leftovers from the scaffold; nothing imports them.)

Colour is rationed: amber belongs to exactly two things, the champion's identity and the
live-order state, so a glance answers whether real orders are going out. Jade and clay carry
P&L and verdicts; everything else is achromatic. The chart steps are validated against the
panel surface — OKLCH lightness inside the dark band, chroma above the floor,
adjacent-pair separation under simulated deuteranopia, contrast ≥ 3:1 — and verdicts and
sides always ship their word alongside the colour, so identity never rests on hue alone.

Type: IBM Plex Mono for every number, label and status word (drawn for technical
documentation; holds a column of figures straight), Instrument Sans for prose and headings.
The console leans on mono much harder than a dashboard usually would, which is the point —
the type does the work so the colour does not have to.

### Recharts 3

Wrapped by `components/ui/chart.tsx`, consumed by `equity-chart.tsx`. The two most
characteristic figures — the grid heatmap and the gauntlet ladder — are hand-built from
divs and inline SVG instead, because both are fixed-geometry diagrams rather than plots and
a chart library would only stand between the data and the pixels.

The ladder is the component worth knowing: four windows of increasing severity (full period, test slice, cost stress, sealed
holdout) drawn on one shared scale with a common zero baseline, so a strategy that earns its
money only on the left and collapses on the right is visible as a shape before you read a
digit.

### `lib/format.ts`

The one place the **absent-is-not-zero** rule lives: every formatter takes
`number | null | undefined` and returns `‒` for the absent case. An unreadable mark price
must never render as `0` — telling an operator a position is flat when its price is merely
unknown is how the next trade gets sized wrong.

---

## Deliberate non-choices

| Not used | Why |
|---|---|
| A trading library (ccxt et al.) | The cost model, exchange filters, idempotent orders and the ledger are the parts that had to be exactly right; a generic abstraction over them hides the specifics that cost money. |
| An ORM / migration tool | Two tables of time series and a handful of JSON files. |
| An LLM SDK | One call shape ("messages in, JSON out"); `axios` was already a dependency. |
| Docker / k8s | Single-node by design — the SQLite cache and the champion file are local, and the schedulers assume one writer. |
| Redis / a job queue | Both long jobs are single-flight on one machine; an in-process lock is the honest expression of that. |
| A frontend state library | Server data with polling; `use-poll` plus local state is the whole requirement. |
| Light mode | See above — an unvalidated second palette on a screen where colour carries P&L. |
| A separate "simple" live decision path | The single most dangerous refactor available here: two paths that both pass their own tests while the measured strategy and the funded strategy quietly diverge. |
