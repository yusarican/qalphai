import type { Metadata } from "next"
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google"

import "./globals.css"
import { cn } from "@/lib/utils"
import { AppShell } from "@/components/console/shell"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

/*
 * Two faces, split by job.
 *
 * IBM Plex Mono carries every number, label and status word. It was drawn for
 * technical documentation and it holds a column of figures dead straight, which is
 * most of what this console does. Instrument Sans carries prose and headings — the
 * few places a sentence has to be read rather than scanned.
 *
 * The console leans on the mono far more than a dashboard usually would. That is the
 * point: an instrument should look like an instrument, and the type is doing that work
 * so the colour does not have to.
 */
const display = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
})

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
})

export const metadata: Metadata = {
  title: "qalphai — operator console",
  description:
    "Operator console for a mechanical quant engine that researches, tests and promotes its own trading strategies nightly.",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * `dark` is hardcoded rather than provided by a theme switcher. This console has
     * one appearance on purpose: there is no light palette to keep in step, and no way
     * for a P&L colour to be validated against one surface and rendered on another.
     */
    <html
      lang="en"
      className={cn("dark antialiased", display.variable, mono.variable)}
      suppressHydrationWarning
    >
      <body className="font-sans">
        <TooltipProvider delay={200}>
          <AppShell>{children}</AppShell>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </body>
    </html>
  )
}
