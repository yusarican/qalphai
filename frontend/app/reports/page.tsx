"use client"

import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { MoonStarIcon, ScrollTextIcon, ServerCrashIcon } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { usePoll } from "@/hooks/use-poll"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Eyebrow } from "@/components/console/figure"

/**
 * Nightly reports.
 *
 * Each file is the engine's own account of one research cycle: what it read, what it
 * wrote, what the gauntlet said, and whether it promoted anything. This page is the
 * only place in the console showing prose rather than figures, so it is set in the
 * body face and given a real measure — a wall of monospace would make the one
 * narrative artefact in the system the hardest thing to read.
 */
export default function ReportsPage() {
  const list = usePoll(() => api.reports(), 60_000)

  // The most recent night is open until the reader picks another — derived, so the
  // pane is never briefly empty while an effect catches up.
  const [chosen, setChosen] = React.useState<string | null>(null)
  const selected = chosen ?? list.data?.[0] ?? null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>Reports</Eyebrow>
          <h1 className="text-2xl leading-tight font-semibold">
            What the engine did last night
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every cycle the engine reads recent research, writes a strategy variant,
            runs it through the gauntlet and decides whether to promote it. It files a
            report either way — including the nights it changed nothing.
          </p>
        </div>
        <RunNightlyButton />
      </div>

      {list.error && !list.data ? (
        <Alert variant="destructive">
          <ServerCrashIcon />
          <AlertTitle>The engine is not answering</AlertTitle>
          <AlertDescription>{list.error}</AlertDescription>
        </Alert>
      ) : list.loading && !list.data ? (
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : (list.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent>
            <Empty className="border-0 py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ScrollTextIcon />
                </EmptyMedia>
                <EmptyTitle>No reports yet</EmptyTitle>
                <EmptyDescription>
                  The first report is written after the first nightly cycle completes.
                  You can start one now with the button above — it takes hours, not
                  minutes.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card size="sm" className="gap-0 self-start py-0">
            <CardHeader className="p-4">
              <CardTitle className="text-sm">Nights</CardTitle>
            </CardHeader>
            <Separator />
            <ul className="max-h-[520px] divide-y overflow-auto">
              {list.data!.map((name) => {
                const active = name === selected
                return (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => setChosen(name)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "w-full px-4 py-2.5 text-left font-mono text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
                      )}
                    >
                      {name.replace(/\.md$/, "")}
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>

          <div className="min-w-0">
            {selected ? <ReportView key={selected} name={selected} /> : null}
          </div>
        </div>
      )}
    </div>
  )
}

function ReportView({ name }: { name: string }) {
  // A written report never changes, so this fetches once (interval 0) rather than
  // polling. Keyed on the file name by the caller, so switching nights refetches.
  const { data: content, error } = usePoll(() => api.report(name), 0, [name])

  if (error) {
    return (
      <Alert variant="destructive">
        <ServerCrashIcon />
        <AlertTitle>Could not load {name}</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (content === null) return <Skeleton className="h-96 w-full rounded-xl" />

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm">{name}</CardTitle>
      </CardHeader>
      <CardContent>
        <MarkdownBody source={content} />
      </CardContent>
    </Card>
  )
}

/**
 * Markdown mapped onto the console's own type and colour, component by component.
 * Nothing here is a generic prose reset: the tables in these reports hold figures, so
 * they get the same tabular monospace treatment every other table in the app has.
 */
function MarkdownBody({ source }: { source: string }) {
  return (
    <div className="max-w-[72ch] text-sm leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-8 mb-3 text-xl font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-7 mb-2.5 text-base font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="eyebrow mt-6 mb-2 first:mt-0">{children}</h3>
          ),
          p: ({ children }) => <p className="my-3 first:mt-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-3 flex list-disc flex-col gap-1.5 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 flex list-decimal flex-col gap-1.5 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-amber-ink underline underline-offset-4 hover:no-underline"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          code: ({ children }) => (
            <code className="rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[12px]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-4 overflow-x-auto rounded-lg bg-muted p-3.5 font-mono text-[12px] leading-relaxed">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-border pl-4 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-border" />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-3 py-2 text-left font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="tnum border-b border-border px-3 py-2 font-mono">
              {children}
            </td>
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  )
}

function RunNightlyButton() {
  const [starting, setStarting] = React.useState(false)

  async function run() {
    setStarting(true)
    try {
      await api.runNightly()
      toast.success("Nightly cycle started", {
        description:
          "The engine is reading papers and rebuilding the champion. The report appears here when it finishes.",
      })
    } catch (err) {
      toast.error("Could not start the nightly cycle", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button variant="outline" onClick={run} disabled={starting}>
        {starting ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <MoonStarIcon data-icon="inline-start" />
        )}
        Run a cycle now
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Normally runs on its own schedule, overnight.
      </p>
    </div>
  )
}
