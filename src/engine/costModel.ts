import type { FundingRate, Kline } from '../lib/klineStore';

/**
 * Islem maliyeti modeli: taker fee + slippage + funding.
 *
 * Sample'da bunlarin HICBIRI modellenmiyordu (backtestExecutor.ts:1380 closePosition
 * sadece ham fiyat farkini aliyordu). Maliyetsiz bir backtest, maliyet altinda olen
 * yuksek-frekansli stratejileri "karli" gosterir; Codex bunlari promote eder ve
 * self-improvement dongusu kendi kuyrugunu yer. Kullanicinin verdigi arXiv sorgulari
 * bile all:"transaction costs" ile filtreliyor — literatur bunu sart kosuyor.
 */

export type SlippageModel =
  | { model: 'bps'; bps: number }
  | { model: 'atr'; atrFraction: number; minBps: number };

export interface CostConfig {
  /** Binance USDⓈ-M taker: %0.045 = 4.5 bps. BNB indirimi kasten yok sayilir (kotumser). */
  takerFeeBps: number;
  slippage: SlippageModel;
  /**
   * SL/BE/TRAIL cikislari MARKET emirdir ve harekete dogru girer — TP'ye gore
   * daha kotu doldurulur. TP/SIGNAL_CHANGE icin 1.0 kullanilir.
   */
  stopSlipMultiplier: number;
  funding: { enabled: boolean; intervalMs: number };
  /** Izole margin tasfiye tabani. netPnl asla -margin'in altina inemez. */
  maintenanceMarginRate: number;
}

export const DEFAULT_COSTS: CostConfig = {
  takerFeeBps: 4.5,
  slippage: { model: 'atr', atrFraction: 0.05, minBps: 1 },
  stopSlipMultiplier: 1.5,
  funding: { enabled: true, intervalMs: 28_800_000 }, // 8 saat
  maintenanceMarginRate: 0.005,
};

/** Promosyon kapisinin "maliyet stresi" kosusu: fee x1.5, slippage x2. */
export function stressCosts(base: CostConfig): CostConfig {
  const slippage: SlippageModel =
    base.slippage.model === 'bps'
      ? { model: 'bps', bps: base.slippage.bps * 2 }
      : { model: 'atr', atrFraction: base.slippage.atrFraction * 2, minBps: base.slippage.minBps * 2 };
  return { ...base, takerFeeBps: base.takerFeeBps * 1.5, slippage };
}

export const ZERO_COSTS: CostConfig = {
  takerFeeBps: 0,
  slippage: { model: 'bps', bps: 0 },
  stopSlipMultiplier: 1,
  funding: { enabled: false, intervalMs: 28_800_000 },
  maintenanceMarginRate: 0.005,
};

export type ExitReason = 'TP' | 'SL' | 'TRAIL' | 'BE' | 'SIGNAL_CHANGE' | 'END_OF_BACKTEST';

/** Cikisin market-emir olup olmadigi: SL/BE/TRAIL harekete girer, TP limit gibi durur. */
function isStopExit(reason: ExitReason): boolean {
  return reason === 'SL' || reason === 'BE' || reason === 'TRAIL';
}

/** Slippage'in fiyata orani (0.0002 = 2 bps). */
export function slippageFraction(cfg: CostConfig, atr: number, price: number): number {
  if (cfg.slippage.model === 'bps') return cfg.slippage.bps / 10_000;
  const floor = cfg.slippage.minBps / 10_000;
  if (!(price > 0) || !(atr > 0)) return floor;
  return Math.max(floor, (cfg.slippage.atrFraction * atr) / price);
}

/**
 * Giris dolum fiyati — HER ZAMAN aleyhte. LONG daha pahaliya alir, SHORT daha ucuza satar.
 *
 * KRITIK: TP/SL seviyeleri bu doldurulan fiyattan turetilmeli, ham entryPrice'tan
 * degil (sample: backtestExecutor.ts:971-976). Aksi halde R mesafen kurgu olur:
 * stop'a olan gercek uzaklik, hesapladigindan farkli cikar.
 */
export function entryFillPrice(
  cfg: CostConfig,
  side: 'LONG' | 'SHORT',
  price: number,
  atr: number,
): number {
  const dir = side === 'LONG' ? 1 : -1;
  return price * (1 + dir * slippageFraction(cfg, atr, price));
}

/** Cikis dolum fiyati — yine aleyhte; stop cikislarinda stopSlipMultiplier kadar daha kotu. */
export function exitFillPrice(
  cfg: CostConfig,
  side: 'LONG' | 'SHORT',
  price: number,
  atr: number,
  reason: ExitReason,
): number {
  const dir = side === 'LONG' ? 1 : -1;
  const m = isStopExit(reason) ? cfg.stopSlipMultiplier : 1;
  return price * (1 - dir * slippageFraction(cfg, atr, price) * m);
}

/** Tek yonlu taker komisyonu. */
export function takerFee(cfg: CostConfig, qtyBase: number, fillPrice: number): number {
  return Math.abs(qtyBase * fillPrice) * (cfg.takerFeeBps / 10_000);
}

export interface FundingAccrualArgs {
  cfg: CostConfig;
  side: 'LONG' | 'SHORT';
  qtyBase: number;
  /** (fromMs, toMs] araligindaki settle'lar tahakkuk eder — yari-acik, cift sayim olmasin. */
  fromMs: number;
  toMs: number;
  funding: FundingRate[];
  /** Mark fiyat kaynagi: settle anindaki en son kapali mumun close'u. */
  markAt: (ts: number) => number | null;
}

/**
 * (fromMs, toMs] araliginda tahakkuk eden funding maliyeti (USD, POZITIF = odeme).
 *
 * LONG, rate > 0 iken oder. Pozisyon ACIKKEN biriktirilir (kapanista degil) —
 * mark-to-market equity curve'unu ve dolayisiyla max-DD'yi durust tutan sey bu.
 */
export function accrueFunding(args: FundingAccrualArgs): number {
  if (!args.cfg.funding.enabled) return 0;
  const dir = args.side === 'LONG' ? 1 : -1;
  let cost = 0;

  for (const f of args.funding) {
    if (f.fundingTime <= args.fromMs || f.fundingTime > args.toMs) continue;
    const mark = args.markAt(f.fundingTime);
    if (mark === null || !(mark > 0)) continue;
    cost += dir * f.rate * args.qtyBase * mark;
  }

  return cost;
}

/** `ts` aninda gecerli mark fiyati: openTime <= ts olan son mumun close'u. Look-ahead yok. */
export function makeMarkAt(candles: Kline[]): (ts: number) => number | null {
  return (ts: number) => {
    // Geriye dogru lineer arama yerine ikili arama — funding dongusu sicak yol.
    let lo = 0;
    let hi = candles.length - 1;
    let found: Kline | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = candles[mid]!;
      if (k.openTime <= ts) {
        found = k;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found ? found.close : null;
  };
}

export interface TradePnlArgs {
  cfg: CostConfig;
  side: 'LONG' | 'SHORT';
  qtyBase: number;
  entryFill: number;
  exitFill: number;
  /** Pozisyon boyunca birikmis funding (USD, pozitif = odenmis). */
  fundingUSD: number;
  /** Ayrilan margin — tasfiye tabani. */
  margin: number;
}

export interface TradePnlResult {
  grossPnl: number;
  feesUSD: number;
  fundingUSD: number;
  netPnl: number;
  /** margin uzerinden yuzde — BacktestTrade.pnlPercent semantigi korunur. */
  pnlPercent: number;
  liquidated: boolean;
}

export function computeTradePnl(a: TradePnlArgs): TradePnlResult {
  const dir = a.side === 'LONG' ? 1 : -1;

  const grossPnl = a.qtyBase * (a.exitFill - a.entryFill) * dir;
  const feesUSD = takerFee(a.cfg, a.qtyBase, a.entryFill) + takerFee(a.cfg, a.qtyBase, a.exitFill);

  const raw = grossPnl - feesUSD - a.fundingUSD;

  // Izole margin: kaybin tavani ayrilan margin'dir.
  const floor = -a.margin;
  const liquidated = raw < floor;
  const netPnl = liquidated ? floor : raw;

  return {
    grossPnl,
    feesUSD,
    fundingUSD: a.fundingUSD,
    netPnl,
    pnlPercent: a.margin > 0 ? (netPnl / a.margin) * 100 : 0,
    liquidated,
  };
}
