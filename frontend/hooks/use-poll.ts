"use client"

import * as React from "react"

import { ApiError } from "@/lib/api"

export interface PollState<T> {
  data: T | null
  error: string | null
  /** True only until the first response. Refreshes must not blank the screen. */
  loading: boolean
  /** A refresh is in flight over data already on screen. */
  refreshing: boolean
  lastUpdatedAt: number | null
  refresh: () => void
}

/**
 * Polls an engine endpoint on an interval.
 *
 * Two behaviours matter more than they look:
 *
 * 1. A failed refresh keeps the last good data on screen and raises the error beside
 *    it. Blanking a filled console because one poll timed out would hide open
 *    positions from the operator at exactly the moment the link is flaky.
 * 2. Polling pauses while the tab is hidden. The engine talks to Binance under a
 *    weight budget (services/binanceClient rate limiter); a forgotten background tab
 *    quietly spending that budget is how the live run gets throttled.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList = [],
  options: {
    /**
     * Stop scheduling once the response says the work is over — a finished backtest
     * does not change again, and polling a terminal state forever is pure noise on
     * the engine.
     */
    stopWhen?: (data: T) => boolean
  } = {}
): PollState<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState<number | null>(null)
  const [tick, setTick] = React.useState(0)

  // The fetcher is usually an inline closure, so it is a new function every render.
  // Holding it in a ref keeps the polling effect from tearing down and restarting on
  // each render. The ref is written in an effect, never during render.
  const ref = React.useRef(fetcher)
  React.useEffect(() => {
    ref.current = fetcher
  })

  const stopRef = React.useRef(options.stopWhen)
  React.useEffect(() => {
    stopRef.current = options.stopWhen
  })

  const done = React.useRef(false)

  // Guards a late response from a superseded request overwriting a newer one.
  const seq = React.useRef(0)

  const load = React.useCallback(async () => {
    const id = ++seq.current
    setRefreshing(true)
    try {
      const next = await ref.current()
      if (id !== seq.current) return
      setData(next)
      setError(null)
      setLastUpdatedAt(Date.now())
      if (stopRef.current?.(next)) done.current = true
    } catch (err) {
      if (id !== seq.current) return
      setError(
        err instanceof ApiError ? err.message : (err as Error)?.message ?? "Request failed"
      )
    } finally {
      if (id === seq.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  React.useEffect(() => {
    done.current = false

    /*
     * This effect's whole job is to synchronise with an external system — the engine's
     * HTTP API — which is exactly what effects are for. The lint rule cannot see that
     * and flags the state written when the request resolves.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()

    if (intervalMs <= 0) return

    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer === null) {
        timer = setInterval(() => {
          if (done.current) {
            stop()
            return
          }
          void load()
        }, intervalMs)
      }
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }

    const onVisibility = () => {
      if (document.hidden || done.current) {
        stop()
      } else {
        // Catch up immediately — the data on screen is as stale as the hidden spell.
        void load()
        start()
      }
    }

    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, intervalMs, tick, ...deps])

  const refresh = React.useCallback(() => setTick((t) => t + 1), [])

  return { data, error, loading, refreshing, lastUpdatedAt, refresh }
}

/** Re-renders on an interval so "4m ago" labels stay honest without a data fetch. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
