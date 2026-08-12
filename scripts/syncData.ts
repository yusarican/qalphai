import { ensureFunding, ensureKlines, getDb, type KlineInterval } from '../src/lib/klineStore';
import { env } from '../src/config/env';

/**
 * Mum + funding verisini yerel SQLite cache'ine ceker.
 *
 *   npx tsx scripts/syncData.ts --days 180 --symbols BTCUSDT,ETHUSDT --intrabar
 *
 * --intrabar 1 DAKIKALIK mumlari da ceker. Bunlar sadece intrabar cozumlemesi icin
 * gerekli (bir mum hem TP hem SL'ye degdiginde hangisi once vuruldu?) ve veri hacminin
 * neredeyse tamami onlardir: 180 gun x 1 sembol x 1m = ~260 bin satir. 1m yoksa
 * simulator kotumser fallback'e duser (SL once vuruldu varsayar) — calisir ama
 * sonuclar bir miktar kotumser olur.
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const days = Number(arg('days', '180'));
  const symbols = (arg('symbols') ?? env.nightly.symbols.join(',')).split(',').map((s) => s.trim());
  const interval = (arg('interval', env.nightly.interval) ?? '4h') as KlineInterval;
  const withIntrabar = flag('intrabar');

  const endDate = Date.now();
  const startDate = endDate - days * DAY_MS;

  // Warmup: strateji 250 mum gecmis istiyor, o mumlar startDate'ten ONCE olmali.
  const INTERVAL_MS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
  const warmupMs = 260 * (INTERVAL_MS[interval] ?? 14_400_000);
  const fetchStart = startDate - warmupMs;

  getDb();

  console.log(`Senkron: ${symbols.join(', ')} | ${interval} | ${days} gun` + (withIntrabar ? ' | +1m intrabar' : ''));
  console.log(`Aralik: ${new Date(fetchStart).toISOString().slice(0, 10)} -> ${new Date(endDate).toISOString().slice(0, 10)}\n`);

  for (const symbol of symbols) {
    const k = await ensureKlines(symbol, interval, fetchStart, endDate);
    const f = await ensureFunding(symbol, fetchStart, endDate);
    console.log(`  ${symbol.padEnd(10)} ${interval}: +${k.fetched} mum, funding: +${f.fetched} settle`);

    if (withIntrabar) {
      // 1m yalnizca ASIL donem icin (warmup'ta pozisyon yok, intrabar'a gerek yok).
      const m1 = await ensureKlines(symbol, '1m', startDate, endDate);
      console.log(`  ${symbol.padEnd(10)} 1m:  +${m1.fetched} mum`);
    }
  }

  const db = getDb();
  const klineCount = db.prepare('SELECT COUNT(*) AS n FROM klines').get() as { n: number };
  const fundingCount = db.prepare('SELECT COUNT(*) AS n FROM funding').get() as { n: number };
  console.log(`\nCache toplam: ${klineCount.n.toLocaleString()} mum, ${fundingCount.n.toLocaleString()} funding kaydi`);
}

main().catch((err) => {
  console.error('Senkron hatasi:', err instanceof Error ? err.message : err);
  process.exit(1);
});
