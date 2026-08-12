import * as React from "react"

import { cn } from "@/lib/utils"
import { DASH } from "@/lib/format"

export type Tone = "up" | "down" | "flat" | "accent"

export const toneText: Record<Tone, string> = {
  up: "text-jade-ink",
  down: "text-clay-ink",
  flat: "text-foreground",
  accent: "text-amber-ink",
}

/**
 * A labelled number.
 *
 * The label sits above the value in small monospaced caps and the value is set in
 * tabular figures, so a row of these reads as a column of numbers rather than a row
 * of sentences. Tone is applied to the value only — never to the label — because the
 * label is text and text wears text colour; the figure is the thing carrying the
 * direction.
 *
 * When `value` is the em dash the tone is dropped: an unknown number is neither good
 * nor bad, and painting it green would invent a fact.
 */
export function Figure({
  label,
  value,
  tone = "flat",
  sub,
  size = "default",
  className,
}: {
  label: string
  value: React.ReactNode
  tone?: Tone
  sub?: React.ReactNode
  size?: "default" | "lg" | "sm"
  className?: string
}) {
  const absent = value === DASH || value === null || value === undefined
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="eyebrow truncate">{label}</span>
      <span
        className={cn(
          "tnum truncate font-mono leading-none font-medium",
          size === "lg" && "text-3xl",
          size === "default" && "text-xl",
          size === "sm" && "text-base",
          absent ? "text-muted-foreground" : toneText[tone]
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className="truncate text-xs text-muted-foreground">{sub}</span>
      ) : null}
    </div>
  )
}

/**
 * A key/value line for dense specification blocks (champion params, risk settings).
 * The dotted leader is not decoration — it carries the eye across a wide gap to the
 * right-aligned value, which is what makes a long spec list scannable.
 */
export function SpecRow({
  label,
  value,
  tone = "flat",
  mono = true,
}: {
  label: string
  value: React.ReactNode
  tone?: Tone
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        aria-hidden
        className="min-w-4 flex-1 translate-y-[-0.2em] border-b border-dashed border-border"
      />
      <span
        className={cn(
          "tnum shrink-0 text-right",
          mono && "font-mono text-[13px]",
          toneText[tone]
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** Section label used above a group inside a card. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn("eyebrow", className)}>{children}</div>
}
