import { INTERVAL_MS } from '../lib/klineStore';
import type { CandleInterval } from '../config/env';
import type { FundingRate, Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';

/**
 * ============================================================================
 * PIYASA BAGLAMI — "o donemde ne oluyordu?"
 * ============================================================================
 *
 * Otopsinin E yontemi. Bir model bir pencerede coktugunde iki farkli cevap olabilir:
 * model bozuldu, ya da PIYASA o pencerede modelin varsaydigi seyi yapmayi birakti.
 * Ikisi tamamen farkli mudahaleler ister — birincisi kodu, ikincisi rejim filtresini
 * degistirir. Bu dosya, ikinci ihtimali olculebilir kiliyor.
 *
 * ---------------------------------------------------------------- NEDEN KENDI VERIMIZ
 *
 * Butun sayilar `data/market.db`den, yani BACKTEST'IN KOSTUGU AYNI VERIDEN cikiyor.
 * Bu bilincli: haber ve sentiment kaynaklari (services/sentiment.ts, lib/webSearch.ts)
 * ayri ve OPSIYONEL katmanlar. Otopsinin cekirdegi, disarisi kapali oldugunda da
 * calismak zorunda — ve daha da onemlisi, deterministik olmak zorunda: ayni pencere
 * icin iki kez sorulan soru ayni cevabi vermeli, yoksa "gecen sefer boyle demiyordu"
 * diye guvenilmez hale gelir.
 *
 * ---------------------------------------------------------------- SAYILARIN ANLAMI
 *
 * Hicbiri tahmin degil, hepsi TANIM: rejim BTC'nin SMA200'une gore, volatilite
 * gerceklesen (realized) getirilerin standart sapmasi, dispersiyon sembollerin
 * getirileri arasindaki dagilim. "Piyasa korkuyordu" gibi bir yorum burada YOK — o,
 * bu sayilara bakan LLM'in isi.
 */

export interface RegimeSlice {
  /** Pencerenin bu diliminin basi. */
  from: number;
  to: number;
  label: 'BTC_USTUNDE' | 'BTC_ALTINDA' | 'BILINMIYOR';
  /** Dilimdeki bar sayisi. */
  bars: number;
}

export interface SymbolContext {
  symbol: string;
  /** Pencere boyu getiri (%). */
  returnPct: number;
  /** Gunluk getirilerin standart sapmasi, yillasitirilmis (%). */
  annualizedVolPct: number;
  /** En derin tepe-dip dususu (%). */
  maxDrawdownPct: number;
  /** |kapanis - acilis| / (yuksek - dusuk) — 1'e yakin = trend, 0'a yakin = yatay. */
  trendEfficiency: number;
  /** Pencere ortalamasi funding orani (8 saatlik). null = veri yok. */
  avgFunding: number | null;
}

export interface MarketContext {
  window: { from: number; to: number; days: number };
  interval: CandleInterval;
  symbols: SymbolContext[];
  /** BTC'nin SMA200'une gore rejim dilimleri — kronolojik. */
  regime: RegimeSlice[];
  /** Rejim dilimlerinin bar agirlikli ozeti. */
  regimeSummary: { abovePct: number; belowPct: number; unknownPct: number; flips: number };
  /**
   * Sembol getirileri arasindaki dagilim (standart sapma, %). Yuksek = semboller
   * ayrisiyor (secicilik ise yarar), dusuk = her sey birlikte hareket ediyor
   * (yon dogru olmadikca cesitlendirme korumaz).
   */
  dispersionPct: number;
  /** Sembollerin ortalama ikili korelasyonu (gunluk getiriler). */
  avgCorrelation: number;
  /** Veri eksikligi gibi, sayiya doNUSMEYEN ama okuyanin bilmesi gereken seyler. */
  notes: string[];
}

const DAY_MS = 86_400_000;

export interface MarketContextArgs {
  klines: Record<string, Kline[]>;
  indicators: Record<string, TechnicalIndicators[]>;
  funding: Record<string, FundingRate[]>;
  symbols: string[];
  interval: CandleInterval;
  from: number;
  to: number;
}

export function buildMarketContext(args: MarketContextArgs): MarketContext {
  const notes: string[] = [];
  const barMs = INTERVAL_MS[args.interval];
  const barsPerDay = DAY_MS / barMs;

  const inWindow = (ks: Kline[]): Kline[] =>
    ks.filter((k) => k.openTime >= args.from && k.openTime < args.to);

  const symbols: SymbolContext[] = [];
  const returnsBySymbol = new Map<string, number[]>();

  for (const symbol of args.symbols) {
    const ks = inWindow(args.klines[symbol] ?? []);
    if (ks.length < 2) {
      notes.push(`${symbol}: pencerede yeterli mum yok (${ks.length}) — baglamdan cikarildi`);
      continue;
    }

    const rets = ks.slice(1).map((k, i) => Math.log(k.close / ks[i]!.close)).filter(Number.isFinite);
    returnsBySymbol.set(symbol, rets);

    const first = ks[0]!.close;
    const last = ks[ks.length - 1]!.close;
    const hi = Math.max(...ks.map((k) => k.high));
    const lo = Math.min(...ks.map((k) => k.low));

    const fr = (args.funding[symbol] ?? []).filter(
      (f) => f.fundingTime >= args.from && f.fundingTime < args.to,
    );

    symbols.push({
      symbol,
      returnPct: ((last - first) / first) * 100,
      annualizedVolPct: stdev(rets) * Math.sqrt(365 * barsPerDay) * 100,
      maxDrawdownPct: maxDrawdownPct(ks),
      // Trend verimliligi: kat edilen NET mesafe / dolasilan TOPLAM aralik.
      trendEfficiency: hi > lo ? Math.abs(last - first) / (hi - lo) : 0,
      avgFunding: fr.length > 0 ? fr.reduce((s, f) => s + f.rate, 0) / fr.length : null,
    });

    if (fr.length === 0) notes.push(`${symbol}: pencerede funding kaydi yok`);
  }

  const regime = btcRegime(args);

  return {
    window: { from: args.from, to: args.to, days: Math.round((args.to - args.from) / DAY_MS) },
    interval: args.interval,
    symbols,
    regime,
    regimeSummary: summarize(regime),
    dispersionPct: stdev(symbols.map((s) => s.returnPct)),
    avgCorrelation: averagePairwiseCorrelation(returnsBySymbol),
    notes,
  };
}

/**
 * BTC'nin SMA200'une gore rejim dilimleri.
 *
 * Tanim, signalRunner.btcRegimeAt ve mechanicalV0'in btcRegimeFilter'i ile AYNI
 * (klines close vs indicators.sma200). Farkli bir tanim kullansaydik otopsi,
 * stratejinin gordugunden BASKA bir rejim anlatirdi — ve "model rejimi yanlis okudu"
 * hipotezi olculemez hale gelirdi.
 */
function btcRegime(args: MarketContextArgs): RegimeSlice[] {
  const ks = args.klines['BTCUSDT'] ?? [];
  const ind = args.indicators['BTCUSDT'] ?? [];
  if (ks.length === 0 || ind.length === 0) return [];

  const slices: RegimeSlice[] = [];

  // Pencere dizinin BITISIK bir dilimi oldugu icin tek bir baslangic ofseti yeterli.
  // (Dongu icinde indexOf cagirmak O(n^2) olurdu: 500 gun/4h'te ~10M karsilastirma.)
  const offset = ks.findIndex((k) => k.openTime >= args.from);
  if (offset < 0) return [];

  for (let j = offset; j < ks.length; j++) {
    const k = ks[j]!;
    if (k.openTime >= args.to) break;

    // Indikator serisi klines ile 1:1 hizali (indicatorSeries.ts:20).
    const sma = j < ind.length ? ind[j]!.sma200 : null;
    const label: RegimeSlice['label'] =
      sma === null ? 'BILINMIYOR' : k.close >= sma ? 'BTC_USTUNDE' : 'BTC_ALTINDA';

    const tail = slices[slices.length - 1];
    if (tail && tail.label === label) {
      tail.to = k.closeTime;
      tail.bars++;
    } else {
      slices.push({ from: k.openTime, to: k.closeTime, label, bars: 1 });
    }
  }

  return slices;
}

function summarize(regime: RegimeSlice[]): MarketContext['regimeSummary'] {
  const total = regime.reduce((s, r) => s + r.bars, 0);
  if (total === 0) return { abovePct: 0, belowPct: 0, unknownPct: 0, flips: 0 };

  const share = (label: RegimeSlice['label']) =>
    (regime.filter((r) => r.label === label).reduce((s, r) => s + r.bars, 0) / total) * 100;

  return {
    abovePct: share('BTC_USTUNDE'),
    belowPct: share('BTC_ALTINDA'),
    unknownPct: share('BILINMIYOR'),
    // Rejim degisim sayisi: cok sayida flip, "rejim filtresi surekli tetiklendi ve
    // her seferinde gec kaldi" hipotezinin gostergesi.
    flips: Math.max(0, regime.length - 1),
  };
}

function maxDrawdownPct(ks: Kline[]): number {
  let peak = ks[0]!.high;
  let worst = 0;
  for (const k of ks) {
    peak = Math.max(peak, k.high);
    if (peak > 0) worst = Math.max(worst, ((peak - k.low) / peak) * 100);
  }
  return worst;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

/**
 * Ortalama ikili korelasyon.
 *
 * Neden onemli: bu sistem ayni anda ~4 pozisyon tasiyor ve risk tavani bunu
 * "cesitlendirme" varsayarak dagitiyor (portfolio.ts). Korelasyon 1'e yaklastiginda
 * dort pozisyon aslinda TEK pozisyondur ve gercek risk, tavanin olctugunun dort
 * katidir. Bir drawdown penceresinde bu sayinin yukselmesi, otopsinin en sik
 * bulacagi seylerden biri.
 */
function averagePairwiseCorrelation(bySymbol: Map<string, number[]>): number {
  const series = [...bySymbol.values()].filter((r) => r.length > 2);
  if (series.length < 2) return 0;

  const pairs: number[] = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const c = correlation(series[i]!, series[j]!);
      if (Number.isFinite(c)) pairs.push(c);
    }
  }
  return pairs.length ? pairs.reduce((s, c) => s + c, 0) / pairs.length : 0;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const ma = xa.reduce((s, x) => s + x, 0) / n;
  const mb = xb.reduce((s, x) => s + x, 0) / n;

  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const u = xa[i]! - ma;
    const v = xb[i]! - mb;
    num += u * v;
    da += u * u;
    db += v * v;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}
