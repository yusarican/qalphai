/**
 * Formatting for a console where a wrong number is worse than no number.
 *
 * Every formatter here takes `number | null | undefined` and returns DASH for the
 * absent case. That is the whole point of the module: the "unknown → em dash" rule
 * lives in one place, so no screen can quietly decide to print 0 instead. A zero P&L
 * and an unreadable P&L look nothing alike and must never render alike.
 */

/** Figure dash — same width as a digit, so columns stay aligned. */
export const DASH = "‒"

const nz = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v)

export function usd(v: number | null | undefined, digits = 2): string {
  if (!nz(v)) return DASH
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Money that carries direction: always shows its sign, including +. */
export function signedUsd(v: number | null | undefined, digits = 2): string {
  if (!nz(v)) return DASH
  return `${v >= 0 ? "+" : "-"}${usd(Math.abs(v), digits)}`
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (!nz(v)) return DASH
  return `${v.toFixed(digits)}%`
}

export function signedPct(v: number | null | undefined, digits = 1): string {
  if (!nz(v)) return DASH
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`
}

export function num(v: number | null | undefined, digits = 2): string {
  if (!nz(v)) return DASH
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function int(v: number | null | undefined): string {
  if (!nz(v)) return DASH
  return Math.round(v).toLocaleString("en-US")
}

export function rMultiple(v: number | null | undefined, digits = 2): string {
  if (!nz(v)) return DASH
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}R`
}

/**
 * Profit factor is grossProfit/grossLoss, so a run with no losing trade yields
 * Infinity. That is a real, meaningful state ("nothing lost yet"), not an error, and
 * it deserves its own glyph rather than a misleading huge number.
 */
export function profitFactor(v: number | null | undefined): string {
  if (typeof v === "number" && v === Infinity) return "∞"
  if (!nz(v)) return DASH
  return v.toFixed(2)
}

/** Prices span BTC at 118,000 and XRP at 0.60 — precision follows magnitude. */
export function price(v: number | null | undefined): string {
  if (!nz(v)) return DASH
  const abs = Math.abs(v)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function compactUsd(v: number | null | undefined): string {
  if (!nz(v)) return DASH
  const abs = Math.abs(v)
  const sign = v < 0 ? "-" : ""
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

/* -------------------------------------------------------------------- time --- */

export function dateTime(ts: number | null | undefined): string {
  if (!nz(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function dateOnly(ts: number | null | undefined): string {
  if (!nz(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

export function clock(ts: number | null | undefined): string {
  if (!nz(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

/** "4m ago" / "3h ago". Used only next to an absolute timestamp, never instead of one. */
export function since(ts: number | null | undefined, now = Date.now()): string {
  if (!nz(ts) || ts <= 0) return DASH
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function duration(ms: number | null | undefined): string {
  if (!nz(ms) || ms < 0) return DASH
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/* -------------------------------------------------------------------- misc --- */

/** BTCUSDT → BTC. The quote is always USDT here; repeating it costs column width. */
export function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, "")
}

/**
 * Engine codes rendered as English.
 *
 * The generic transform (lowercase, capitalise) mangles the short ones — "SL" becomes
 * "Sl" and "TP" becomes "Tp", which look like typos in the middle of a results table.
 * The codes that appear in the UI are a small, closed set, so they are spelled out
 * here and anything unrecognised falls back to the generic form.
 */
const RULE_LABELS: Record<string, string> = {
  // Exit reasons (engine/costModel).
  TP: "Take profit",
  SL: "Stop loss",
  TRAIL: "Trailing stop",
  BE: "Breakeven",
  SIGNAL_CHANGE: "Signal change",
  END_OF_BACKTEST: "Period end",
  // Entry rejections (engine/portfolio).
  ALLOCATION_CAP: "Allocation cap",
  MIN_CONF: "Confidence too low",
  COOLDOWN: "Cooldown after a stop",
  RISK_CAP: "Portfolio risk cap",
  MIN_MARGIN: "Margin below minimum",
  NO_ATR_SIZING: "No ATR to size with",
}

export function humanizeRule(rule: string): string {
  const known = RULE_LABELS[rule]
  if (known) return known
  const s = rule.replace(/_/g, " ").toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Direction of a value, for choosing jade / clay / neutral ink. */
export function tone(v: number | null | undefined): "up" | "down" | "flat" {
  if (!nz(v) || v === 0) return "flat"
  return v > 0 ? "up" : "down"
}
