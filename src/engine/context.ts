import type { FundingRate, Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';
import type { CandleInterval } from '../config/env';
import type { StrategyContext, StrategyIndicators } from '../strategy/types';

/**
 * StrategyContext insasi — LOOK-AHEAD DISIPLININ TEK SAHIBI.
 *
 * Sistemde "gelecegi gorme" ihtimali olan tek yer burasidir. Baska hicbir kod mum
 * dilimlemez; strateji ne gorurse burada kesilen seyi gorur. Bu yuzden:
 *
 *   - Kesim her yerde KATI `<`: openTime < t. `<=` olsaydi henuz KAPANMAMIS mum
 *     stratejiye sizardi (sample de bu disiplini koruyordu: backtestExecutor.ts:910, :1543).
 *   - Indikator serisi mumlarla 1:1 hizali; ayni j indeksiyle kesilir.
 *   - Donen ctx DERIN DONDURULUR. Strateji ctx'i mutate edip bir sonraki mumda
 *     kendine mesaj birakamaz (gauntlet'in statelessness testi de bunu kovalar).
 *
 * gauntlet.ts'teki "future poison" testi tam olarak bu fonksiyonu hedefler: karar
 * barindan sonraki tum mumlar copla degistirilir ve hicbir sinyalin degismemesi beklenir.
 * Yani asagidaki kesim yanlissa, test kirmizi yanar.
 */

/** Sample ile ayni pencere (backtestExecutor.ts:910 `.slice(-250)`). */
const LOOKBACK = 250;

export interface BuildContextArgs {
  symbol: string;
  interval: CandleInterval;
  /** Karar ani. Bu andan ONCE acilmis mumlar goruluyor, sonrakiler YOK. */
  at: number;

  klines: Kline[];
  /** klines ile 1:1 hizali. */
  indicators: TechnicalIndicators[];

  funding: FundingRate[];
  lsr: { longShortRatio: number; longAccount: number; shortAccount: number } | null;
  macroRiskAppetite: 'risk_on' | 'risk_off' | 'mixed' | null;

  /** BTC rejim baglami — sembol BTC olmasa bile strateji piyasa rejimini ister. */
  btc: { price: number; sma200: number | null } | null;

  params: Record<string, number | boolean>;
  warmupBars: number;
}

/**
 * `at` aninda gecerli StrategyContext'i uretir. Yeterli mum yoksa null doner
 * (strateji hic cagrilmaz — meta.warmupBars harness tarafindan ZORLANIR).
 */
export function buildStrategyContext(args: BuildContextArgs): StrategyContext | null {
  const j = lastIndexBefore(args.klines, args.at);
  if (j < 0) return null;

  // Kapali mum sayisi = j + 1. Warmup dolmadan strateji cagrilmaz.
  if (j + 1 < args.warmupBars) return null;

  const from = Math.max(0, j - LOOKBACK + 1);
  const candles = args.klines.slice(from, j + 1);
  const history = args.indicators.slice(from, j + 1);

  const last = candles[candles.length - 1];
  const indicators = history[history.length - 1];
  if (!last || !indicators) return null;

  const ctx: StrategyContext = {
    symbol: args.symbol,
    interval: args.interval,
    now: last.closeTime,
    candles: candles.map(toStrategyCandle),
    indicators: indicators as StrategyIndicators,
    history: history as StrategyIndicators[],
    funding: lastFundingBefore(args.funding, args.at),
    lsr: args.lsr,
    macro: { riskAppetite: args.macroRiskAppetite },
    market: { btc: args.btc },
    params: args.params,
  };

  return deepFreeze(ctx);
}

function toStrategyCandle(k: Kline) {
  return {
    openTime: k.openTime,
    closeTime: k.closeTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
  };
}

/** openTime < t olan SON mumun indeksi (ikili arama). Katı `<`. */
export function lastIndexBefore(klines: Kline[], t: number): number {
  let lo = 0;
  let hi = klines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (klines[mid]!.openTime < t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** `t`den once SETTLE OLMUS son funding orani. Henuz settle olmamis oran gelecektir. */
function lastFundingBefore(funding: FundingRate[], t: number): number | null {
  let lo = 0;
  let hi = funding.length - 1;
  let found: FundingRate | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = funding[mid]!;
    if (f.fundingTime < t) {
      found = f;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found ? found.rate : null;
}

/**
 * Derin dondurma. Strateji ctx'e yazamaz — ne veriyi bozmak icin, ne de mumlar arasi
 * kendine not birakmak icin (durumsuzluk sartinin ikinci ayagi; birincisi validator'in
 * modul seviyesi mutable state yasagi).
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;

  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}
