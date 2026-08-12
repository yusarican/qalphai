"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { usePoll } from "@/hooks/use-poll"
import { LiveStateChip, NetworkChip } from "@/components/console/status"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The ladder mark: four rungs of falling height, the shape of a strategy surviving
 * progressively harsher tests. It is the same figure the gauntlet draws on every
 * results panel, shrunk to a glyph.
 */
function LadderMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 16"
      fill="none"
      aria-hidden
      className={cn("size-[18px]", className)}
    >
      <rect x="0.5" y="1" width="3" height="14" rx="1" fill="currentColor" />
      <rect
        x="6"
        y="4"
        width="3"
        height="11"
        rx="1"
        fill="currentColor"
        opacity="0.75"
      />
      <rect
        x="11.5"
        y="7"
        width="3"
        height="8"
        rx="1"
        fill="currentColor"
        opacity="0.5"
      />
      <rect
        x="17"
        y="10"
        width="3"
        height="5"
        rx="1"
        fill="currentColor"
        opacity="0.3"
      />
    </svg>
  )
}

const NAV = [
  { href: "/", label: "Live" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/backtest", label: "Backtest" },
  { href: "/reports", label: "Reports" },
] as const

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // /health is the cheap endpoint — it reads configuration only and never calls the
  // exchange, so the chrome can poll it without spending the engine's rate budget.
  const { data: health, error } = usePoll(() => api.health(), 20_000)

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LadderMark className="text-foreground" />
            <span className="font-mono text-[15px] leading-none font-semibold tracking-tight">
              qalphai
            </span>
          </Link>

          <span
            aria-hidden
            className="hidden h-4 w-px bg-border sm:block"
          />

          <p className="hidden text-xs text-muted-foreground sm:block">
            Mechanical quant engine · rewrites itself nightly
          </p>

          <div className="ml-auto flex items-center gap-2">
            {error ? (
              <span className="font-mono text-[11px] text-clay-ink">
                ENGINE OFFLINE
              </span>
            ) : !health ? (
              <Skeleton className="h-7 w-40" />
            ) : (
              <>
                <NetworkChip testnet={health.testnet} />
                <LiveStateChip
                  liveTrading={health.liveTrading}
                  testnet={health.testnet}
                  hasKeys={health.hasKeys}
                />
              </>
            )}
          </div>
        </div>

        <nav className="mx-auto w-full max-w-[1400px] px-4 sm:px-6">
          <ul className="-mb-px flex items-center gap-1">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex h-9 items-center border-b-2 px-3 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      active
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>

      <footer className="mx-auto w-full max-w-[1400px] px-4 pb-10 sm:px-6">
        <p className="text-[11px] text-muted-foreground">
          Every figure on this console is computed by the engine, never by the console.
          Where the engine reports no value, the console shows a dash — not a zero.
        </p>
      </footer>
    </div>
  )
}
