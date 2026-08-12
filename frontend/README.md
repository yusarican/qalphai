# qalphai — operator console

The panel the engine is watched and driven from. Next.js 16 (App Router) + React 19 +
Tailwind v4 + shadcn/ui, dark only.

## Running it

The console is a client for the engine's HTTP API and computes nothing on its own, so
the engine has to be up first.

```bash
# terminal 1 — the engine (repo root), serves http://localhost:3001/api
npm run dev

# terminal 2 — the console, serves http://localhost:3000
cd frontend
npm install
npm run dev
```

If the engine lives somewhere else, point the console at it:

```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=https://your-engine.example.com/api
```

`NEXT_PUBLIC_*` variables are baked into the browser bundle at build time, so this
belongs in `frontend/.env.local` — not in the engine's root `.env`.

Checks: `npm run typecheck`, `npm run lint`, `npm run build`.

## Pages

| Route        | What it answers                                                             |
| ------------ | --------------------------------------------------------------------------- |
| `/`          | What is trading right now, what it holds, what it has actually made          |
| `/portfolio` | Which of the champion's symbols may take new entries                         |
| `/backtest`  | Put a strategy through the real gauntlet and read the verdict                |
| `/reports`   | The engine's own account of each nightly research cycle                      |

## Two rules the code follows

**Every number comes from the engine.** Win rate, profit factor, expectancy and every
verdict arrive already computed, from the same functions the nightly promotion gate
uses. There is no panel-side arithmetic. A second implementation of "win rate" would be
a second truth about the same account, and once the two disagreed nobody could say
which was real.

**Absent is not zero.** When the exchange cannot be read, a mark price arrives as
`null` and the console renders an em dash. `lib/format.ts` is the single place that
rule lives — every formatter takes `number | null | undefined` and returns `‒` for the
absent case. Telling an operator a position is flat when its price is merely unknown is
how the next trade gets sized wrong.

## Layout

```
app/            one file per route, all client components (the console is live data)
components/
  console/      domain components — champion strip, gauntlet ladder, tables, charts
  ui/           shadcn/ui primitives (base-ui flavour: `render` prop, not `asChild`)
hooks/use-poll  polling with visibility pausing and last-good-data retention
lib/api.ts      the only place that talks to the engine; types mirror src/api/routes.ts
lib/format.ts   number and date formatting, and the null-stays-null rule
app/globals.css the palette and type tokens
```

### The gauntlet ladder

`components/console/gauntlet.tsx` is the one component worth knowing. Every strategy
here is judged on four windows of increasing severity — full period, test slice, cost
stress, and a sealed holdout no part of the selection path ever saw — and the whole
argument for trusting a number rests on which window produced it. The ladder draws all
four together on one shared scale with a common zero baseline, so a strategy that earns
its money only on the left and collapses to the right is visible as a shape before you
read a digit.

It appears on the champion header (three rungs, from the promotion record) and on every
backtest report (four rungs, from the run).

### Colour

Dark only, and deliberately rationed. Amber belongs to exactly two things — the
champion's identity and the live-order state — so a glance tells you whether real
orders are going out. Jade and clay carry P&L and verdicts. Everything else is
achromatic.

The chart steps in `globals.css` are validated against the panel surface: OKLCH
lightness inside the dark band, chroma above the floor, adjacent-pair separation under
simulated deuteranopia, and contrast ≥ 3:1. Verdicts and sides always ship their word
alongside the colour, so identity never rests on hue alone.
