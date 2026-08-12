import type Database from 'better-sqlite3';
import { computeIndicatorSeriesCached } from './indicatorSeries';
import {
  ensureFunding,
  ensureKlines,
  getDb,
  getFunding,
  getIntrabar,
  getKlines,
  INTERVAL_MS,
  openReadOnly,
  type FundingRate,
  type Kline,
} from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';
import type { CandleInterval } from '../config/env';

/**
 * Bir backtest kosusunun ihtiyac duydugu TUM veriyi cache'ten yukler.
 *
 * Kritik ayrinti — WARMUP: strateji meta.warmupBars kadar kapali mum ister (mechanicalV0
 * icin 250: EMA200/SMA200/ADX/Fib bunu gerektirir). Bu mumlar backtest DONEMININ ONCESINDEN
 * gelmeli, yoksa donemin ilk 250 mumunda strateji hic karar veremez ve backtest sessizce
 * kisalir. Bu yuzden klines, startDate'ten warmup kadar GERIDEN yuklenir; ama karar
 * noktalari yine startDate'te baslar.
 */

export const WARMUP_BARS = 260; // meta.warmupBars (250) + emniyet payi

/** Bir kosunun gercekten okudugu ilk an: donemin basi EKSI warmup. */
export function fetchStartFor(startDate: number, interval: CandleInterval): number {
  return startDate - WARMUP_BARS * INTERVAL_MS[interval];
}

export interface Dataset {
  klines: Record<string, Kline[]>;
  indicators: Record<string, TechnicalIndicators[]>;
  funding: Record<string, FundingRate[]>;
  lsr: Record<string, { longShortRatio: number; longAccount: number; shortAccount: number }>;
  intrabar: (symbol: string, openTime: number, closeTime: number) => Kline[];
  /** Kapatma — worker'lar kendi read-only handle'ini acar. */
  close: () => void;
}

export interface LoadDatasetArgs {
  symbols: string[];
  interval: CandleInterval;
  startDate: number;
  endDate: number;
  /** Verilmezse yeni bir read-only handle acilir. */
  handle?: Database.Database;
}

export function loadDataset(args: LoadDatasetArgs): Dataset {
  const db = args.handle ?? openReadOnly();
  const ownsHandle = !args.handle;

  const fetchStart = fetchStartFor(args.startDate, args.interval);

  const klines: Record<string, Kline[]> = {};
  const indicators: Record<string, TechnicalIndicators[]> = {};
  const funding: Record<string, FundingRate[]> = {};

  for (const symbol of args.symbols) {
    const ks = getKlines(db, symbol, args.interval, fetchStart, args.endDate);
    klines[symbol] = ks;
    indicators[symbol] = computeIndicatorSeriesCached(symbol, args.interval, ks);
    funding[symbol] = getFunding(db, symbol, fetchStart, args.endDate);
  }

  return {
    klines,
    indicators,
    funding,
    // OI/LSR Binance'te yalnizca son 30 gun icin var — tarihsel backtest'te
    // neredeyse her zaman bos. Sample da bunu 'lsrSkipped' ile geciyordu.
    lsr: {},
    intrabar: (symbol, openTime, closeTime) => getIntrabar(db, symbol, openTime, closeTime),
    close: () => {
      if (ownsHandle) db.close();
    },
  };
}

/**
 * Kosunun ihtiyac duydugu araligi cache'te GARANTI eder (warmup dahil).
 *
 * Panelden 1h secildiginde cache'te yalnizca 4h varsa, eksigi burada indirilir. Bu adim
 * olmadan backtest sessizce BOS bir veri setiyle kosar: sifir karar, sifir islem, her
 * hucre "20 islemden az" diye elenir ve panel bunu bir STRATEJI basarisizligi gibi
 * gosterir. Veri yoklugu ile edge yoklugu ayni ekranda ayni sekilde gorunmemeli.
 *
 * ensureKlines zaten kapsanan araligi tekrar indirmez — bu cagri idempotenttir.
 */
export async function ensureDataset(args: {
  symbols: string[];
  interval: CandleInterval;
  startDate: number;
  endDate: number;
  /** Sembol basina ilerleme (panel/gece raporu icin). */
  onProgress?: (done: number, total: number, symbol: string) => void;
}): Promise<{ fetched: number }> {
  getDb();

  const from = fetchStartFor(args.startDate, args.interval);
  let fetched = 0;
  let done = 0;

  for (const symbol of args.symbols) {
    fetched += (await ensureKlines(symbol, args.interval, from, args.endDate)).fetched;
    await ensureFunding(symbol, from, args.endDate);
    args.onProgress?.(++done, args.symbols.length, symbol);
  }

  return { fetched };
}

/** Veri butunlugu kontrolu — sessizce eksik veriyle backtest kosmak en pahali hatadir. */
export function assertCoverage(ds: Dataset, args: LoadDatasetArgs): void {
  const problems: string[] = [];
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  for (const symbol of args.symbols) {
    const ks = ds.klines[symbol] ?? [];
    if (ks.length === 0) {
      problems.push(`${symbol} ${args.interval}: cache'te hic mum yok`);
      continue;
    }

    // Warmup mumlari donemin ONCESINDEN gelmeli; yoksa strateji donemin basinda
    // karar veremez ve backtest sessizce kisalir.
    const closed = ks.filter((k) => k.openTime < args.startDate).length;
    if (closed < WARMUP_BARS - 10) {
      problems.push(
        `${symbol} ${args.interval}: ${day(args.startDate)} oncesi yalnizca ${closed} mum var ` +
          `(>= ${WARMUP_BARS} gerekli). Cache ${day(ks[0]!.openTime)} tarihinden basliyor.`,
      );
    }

    // Asil delik: donemin ICINDE mum yok. Bu haliyle kosarsa her hucre sifir islem uretir.
    const inPeriod = ks.filter((k) => k.openTime >= args.startDate && k.openTime <= args.endDate);
    if (inPeriod.length === 0) {
      problems.push(
        `${symbol} ${args.interval}: ${day(args.startDate)} - ${day(args.endDate)} araliginda ` +
          `hic mum yok (cache ${day(ks[0]!.openTime)} - ${day(ks[ks.length - 1]!.openTime)}).`,
      );
    }
  }

  if (problems.length > 0) {
    const days = Math.max(1, Math.round((args.endDate - args.startDate) / 86_400_000));
    throw new Error(
      `Veri kapsami yetersiz — backtest kosturulmadi:\n  - ${problems.join('\n  - ')}\n` +
        `Duzeltmek icin: npm run sync -- --interval ${args.interval} --days ${days} ` +
        `--symbols ${args.symbols.join(',')}`,
    );
  }
}
