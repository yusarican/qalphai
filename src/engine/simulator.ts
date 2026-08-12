import {
  accrueFunding,
  computeTradePnl,
  entryFillPrice,
  exitFillPrice,
  makeMarkAt,
  takerFee,
  type CostConfig,
  type ExitReason,
} from './costModel';
import { calculatePositionSize, checkPortfolioRiskCap, type RiskParams } from './riskManagement';
import type { Allocation, Rejection } from './portfolio';
import type { FundingRate, Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';
import type { BacktestTrade, EquityPoint } from '../lib/types';

/**
 * Backtest simulatoru — sample'daki simulateRun'in (backtestExecutor.ts:783) yeniden yazimi.
 *
 * Uc yapisal degisiklik:
 *
 *  1. TAMAMEN SENKRON. Sample async'ti cunku resolveIntrabar 1m mumu agdan lazy cekiyordu
 *     (:1171). O tek async yaprak, replay grid'ini (:343) paralellestirilemez kiliyordu.
 *     1m veri artik SQLite'ta oturuyor -> intrabar senkron -> simulator CPU-bound -> worker pool.
 *
 *  2. MALIYETLI. Giris/cikis slippage'i, iki yonlu taker fee, ve pozisyon ACIKKEN
 *     tahakkuk eden funding. TP/SL seviyeleri ham fiyattan degil DOLDURULAN fiyattan
 *     (entryFill) turer — aksi halde R mesafesi kurgu olur.
 *
 *  3. MARK-TO-MARKET equity curve. Sample yalnizca trade KAPANISLARINDA nokta ekliyordu
 *     (:1134), yani acik pozisyon icinde yasanan her drawdown gorunmezdi. DD'ye dayanan
 *     her kapi (TEST_DD>40, LIKIDASYON, MAR) o yuzden korlu. Artik her mumda deger biciliyor.
 *     Bu, gecmis DD'leri KOTULESTIRIR — kasitli.
 *
 * Cikis motoru (processPositionCandle / processTrailingCandle / resolveIntrabar /
 * resolveTrailingFine) sample'dan neredeyse birebir portlandi: kotumser siralama
 * konvansiyonlari, breakeven yurumesi ve intrabar belirsizlik cozumu zor kazanilmis
 * mantiktir, dokunulmadi — sadece senkron ve maliyetli hale getirildi.
 */

export type SkipRule = 'MIN_CONF' | 'COOLDOWN' | 'RISK_CAP' | 'MIN_MARGIN' | 'NO_ATR_SIZING';

export interface SimulationSkip {
  timestamp: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  rule: SkipRule;
}

/** Bir karar noktasinda stratejinin urettigi (risk parametrelerinden BAGIMSIZ) cikti. */
export interface RecordedDecision {
  timestamp: number;
  allocations: Allocation[];
  rejections: Rejection[];
}

interface OpenPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTime: number;
  /** Ham piyasa fiyati. */
  entryPrice: number;
  /** Slippage sonrasi gercek dolum. TP/SL/BE bundan turer. */
  entryFill: number;
  leverage: number;
  /** USD margin. BacktestTrade.quantity ile ayni (sample semantigi). */
  margin: number;
  qtyBase: number;
  notional: number;
  /** Giriste odenen taker komisyonu. */
  feeEntry: number;
  /** Pozisyon acikken biriken funding (USD, pozitif = odendi). */
  fundingAccrued: number;
  /** Funding tahakkukunun en son islendigi an. */
  fundingCursor: number;

  takeProfitPrice: number;
  stopLossPrice: number;
  initialStopPrice: number;
  confidence: number;
  riskUSD: number;
  /** Sizing anindaki ATR — cikis slippage'i icin. */
  atr: number;

  highestPrice: number;
  lowestPrice: number;

  isTrailing: boolean;
  activationPrice?: number;
  callbackRate?: number;
  trailingActive?: boolean;
  peakPrice?: number;

  breakevenTriggerPrice?: number;
  breakevenPrice?: number;
  breakevenApplied?: boolean;
}

export interface SimulateArgs {
  decisions: RecordedDecision[];
  /** Warmup dahil, sembol basina tum mumlar. */
  klines: Record<string, Kline[]>;
  /** klines ile 1:1 hizali onceden hesaplanmis indikator serisi (sizing ATR'si buradan). */
  indicators: Record<string, TechnicalIndicators[]>;
  funding: Record<string, FundingRate[]>;
  /** Intrabar (1m) erisimi — SENKRON. Veri yoksa bos dizi doner (kotumser fallback devreye girer). */
  intrabar: (symbol: string, openTime: number, closeTime: number) => Kline[];

  risk: RiskParams;
  costs: CostConfig;
  initialBalance: number;
  endDate: number;
  /** SL/BE sonrasi ayni sembol+yonde yeniden giris yasagi (ms). 0 = kapali. */
  cooldownMs: number;
  /** Sinyal confidence'i bunun altindaysa giris yok. */
  minConfidence: number;
  useTrailing: boolean;
}

export interface SimulateResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  skips: SimulationSkip[];
}

const applyBreakeven = (pos: OpenPosition): void => {
  if (pos.breakevenApplied || pos.breakevenPrice === undefined) return;
  pos.stopLossPrice = pos.breakevenPrice;
  pos.breakevenApplied = true;
};

const stopExitReason = (pos: OpenPosition): 'SL' | 'BE' => (pos.breakevenApplied ? 'BE' : 'SL');

const trailingExitReason = (pos: OpenPosition, exitLevel: number): 'TRAIL' | 'BE' =>
  pos.breakevenApplied && exitLevel === pos.stopLossPrice ? 'BE' : 'TRAIL';

/** `t` aninda gecerli fiyat: openTime < t olan son mumun close'u. Katı `<` — look-ahead yok. */
function priceAt(klines: Kline[], t: number): number {
  let lo = 0;
  let hi = klines.length - 1;
  let found: Kline | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = klines[mid]!;
    if (k.openTime < t) {
      found = k;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found ? found.close : 0;
}

export function simulate(args: SimulateArgs): SimulateResult {
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const skips: SimulationSkip[] = [];
  const open: OpenPosition[] = [];

  const markAt: Record<string, (ts: number) => number | null> = {};
  for (const [sym, ks] of Object.entries(args.klines)) markAt[sym] = makeMarkAt(ks);

  /** Kapanmis trade'lerin toplam net PnL'i. */
  let realized = 0;
  const balance = () => args.initialBalance + realized;

  const start = args.decisions[0]?.timestamp ?? args.endDate;
  equityCurve.push({ timestamp: start, balance: args.initialBalance });

  const closeAt = (pos: OpenPosition, rawExit: number, exitTime: number, reason: ExitReason): void => {
    const exitFill = exitFillPrice(args.costs, pos.side, rawExit, pos.atr, reason);

    // Kapanisa kadar kalan funding'i de tahakkuk ettir.
    const fundingRest = accrueFunding({
      cfg: args.costs,
      side: pos.side,
      qtyBase: pos.qtyBase,
      fromMs: pos.fundingCursor,
      toMs: exitTime,
      funding: args.funding[pos.symbol] ?? [],
      markAt: markAt[pos.symbol] ?? (() => null),
    });
    pos.fundingAccrued += fundingRest;
    pos.fundingCursor = exitTime;

    const pnl = computeTradePnl({
      cfg: args.costs,
      side: pos.side,
      qtyBase: pos.qtyBase,
      entryFill: pos.entryFill,
      exitFill,
      fundingUSD: pos.fundingAccrued,
      margin: pos.margin,
    });

    realized += pnl.netPnl;

    // MAE/MFE: R = giris stop mesafesi. Cikis fiyati da uclara dahil edilir.
    const rDist = Math.abs(pos.entryFill - pos.initialStopPrice);
    const hi = Math.max(pos.highestPrice, exitFill);
    const lo = Math.min(pos.lowestPrice, exitFill);
    const fav = pos.side === 'LONG' ? hi - pos.entryFill : pos.entryFill - lo;
    const adv = pos.side === 'LONG' ? pos.entryFill - lo : hi - pos.entryFill;

    const trade: BacktestTrade = {
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      entryFill: pos.entryFill,
      exitTime,
      exitPrice: rawExit,
      exitFill,
      exitReason: reason,
      leverage: pos.leverage,
      quantity: pos.margin,
      qtyBase: pos.qtyBase,
      notional: pos.notional,
      grossPnl: round2(pnl.grossPnl),
      feesUSD: round2(pnl.feesUSD),
      fundingUSD: round2(pnl.fundingUSD),
      pnl: round2(pnl.netPnl),
      pnlPercent: round2(pnl.pnlPercent),
      liquidated: pnl.liquidated,
      confidence: pos.confidence,
    };

    if (rDist > 0) {
      trade.mfeR = round3(fav / rDist);
      trade.maeR = round3(adv / rDist);
    }
    if (pos.riskUSD > 0) {
      trade.riskUSD = round2(pos.riskUSD);
      trade.pnlR = round3(pnl.netPnl / pos.riskUSD);
    }

    trades.push(trade);
  };

  // ---------------------------------------------------------------- karar dongusu

  for (let i = 0; i < args.decisions.length; i++) {
    const d = args.decisions[i]!;
    const nextT = i + 1 < args.decisions.length ? args.decisions[i + 1]!.timestamp : args.endDate;

    // 1) Bu karar noktasinda pozisyon ac.
    for (const alloc of d.allocations) {
      if (alloc.confidence < args.minConfidence) {
        skips.push({ timestamp: d.timestamp, symbol: alloc.symbol, side: alloc.side, rule: 'MIN_CONF' });
        continue;
      }

      const existing = open.find((p) => p.symbol === alloc.symbol);
      if (existing) {
        if (existing.side === alloc.side) continue; // ayni yon — pozisyonu koru
        const px = priceAt(args.klines[alloc.symbol] ?? [], d.timestamp);
        if (px > 0) closeAt(existing, px, d.timestamp, 'SIGNAL_CHANGE');
        open.splice(open.indexOf(existing), 1);
      }

      // Cooldown: yakin zamanda ayni sembol+yonde stop yendiyse girme.
      if (args.cooldownMs > 0) {
        const since = d.timestamp - args.cooldownMs;
        const recentStop = trades.some(
          (t) =>
            t.symbol === alloc.symbol &&
            t.side === alloc.side &&
            (t.exitReason === 'SL' || t.exitReason === 'BE') &&
            t.exitTime >= since,
        );
        if (recentStop) {
          skips.push({ timestamp: d.timestamp, symbol: alloc.symbol, side: alloc.side, rule: 'COOLDOWN' });
          continue;
        }
      }

      const ks = args.klines[alloc.symbol] ?? [];
      const entryPrice = priceAt(ks, d.timestamp);
      if (!(entryPrice > 0)) continue;

      const atr = atrAt(args, alloc.symbol, d.timestamp);
      if (!(atr > 0)) {
        skips.push({ timestamp: d.timestamp, symbol: alloc.symbol, side: alloc.side, rule: 'NO_ATR_SIZING' });
        continue;
      }

      // KRITIK: sizing ve TP/SL, slippage sonrasi DOLDURULAN fiyattan turer.
      const entryFill = entryFillPrice(args.costs, alloc.side, entryPrice, atr);

      const sizing = calculatePositionSize({
        balance: balance(),
        entryPrice: entryFill,
        atr,
        leverage: alloc.leverage,
        riskPerTradePct: args.risk.riskPerTradePct,
        slMultiplier: args.risk.slMultiplier,
        callbackMultiplier: args.risk.callbackMultiplier,
        rewardRatio: args.risk.rewardRatio,
      });

      const openRisk = open.reduce((s, p) => s + p.riskUSD, 0);
      const cap = checkPortfolioRiskCap({
        balance: balance(),
        currentOpenRiskUSD: openRisk,
        newTradeRiskUSD: sizing.riskUSD,
        maxPortfolioRiskPct: args.risk.maxPortfolioRiskPct,
      });
      if (!cap.allowed) {
        skips.push({ timestamp: d.timestamp, symbol: alloc.symbol, side: alloc.side, rule: 'RISK_CAP' });
        continue;
      }

      if (sizing.margin < 5) {
        skips.push({ timestamp: d.timestamp, symbol: alloc.symbol, side: alloc.side, rule: 'MIN_MARGIN' });
        continue;
      }

      const isLong = alloc.side === 'LONG';
      const tpPrice = isLong
        ? entryFill * (1 + sizing.takeProfitPct / 100)
        : entryFill * (1 - sizing.takeProfitPct / 100);
      const slPrice = isLong
        ? entryFill * (1 - sizing.stopLossPct / 100)
        : entryFill * (1 + sizing.stopLossPct / 100);

      const beR = args.risk.breakevenAtR;

      const pos: OpenPosition = {
        symbol: alloc.symbol,
        side: alloc.side,
        entryTime: d.timestamp,
        entryPrice,
        entryFill,
        leverage: alloc.leverage,
        margin: sizing.margin,
        qtyBase: sizing.quantityBase,
        notional: sizing.notional,
        feeEntry: takerFee(args.costs, sizing.quantityBase, entryFill),
        fundingAccrued: 0,
        fundingCursor: d.timestamp,
        takeProfitPrice: tpPrice,
        stopLossPrice: slPrice,
        initialStopPrice: slPrice,
        confidence: alloc.confidence,
        riskUSD: sizing.riskUSD,
        atr,
        highestPrice: entryFill,
        lowestPrice: entryFill,
        isTrailing: args.useTrailing,
      };

      if (args.useTrailing) {
        pos.activationPrice = tpPrice;
        pos.callbackRate = Math.min(5, Math.max(0.1, parseFloat(sizing.callbackRatePct.toFixed(1))));
        pos.trailingActive = false;
        pos.peakPrice = entryFill;
      }

      if (beR !== false) {
        pos.breakevenTriggerPrice = isLong
          ? entryFill * (1 + (beR * sizing.stopLossPct) / 100)
          : entryFill * (1 - (beR * sizing.stopLossPct) / 100);
        pos.breakevenPrice = isLong
          ? entryFill * (1 + args.risk.breakevenBufferPct / 100)
          : entryFill * (1 - args.risk.breakevenBufferPct / 100);
        pos.breakevenApplied = false;
      }

      open.push(pos);
    }

    // 2) Bir sonraki karar noktasina kadar mumlari yurut.
    stepCandles(args, open, d.timestamp, nextT, closeAt, () => balance(), equityCurve, markAt);
  }

  // 3) Kalan pozisyonlari kapat.
  for (const pos of [...open]) {
    const px = priceAt(args.klines[pos.symbol] ?? [], args.endDate + 1);
    if (px > 0) closeAt(pos, px, args.endDate, 'END_OF_BACKTEST');
  }
  open.length = 0;

  equityCurve.push({ timestamp: args.endDate, balance: balance() });

  return { trades, equityCurve, skips };
}

// ---------------------------------------------------------------- mum yurutucu

/**
 * [fromT, toT) araligindaki mumlari ZAMAN-SIRALI yurutur.
 *
 * Sample bunu pozisyon-major yapiyordu (checkTPSL, :1117 her pozisyon icin ayri dongu);
 * biz zaman-major yapiyoruz cunku mark-to-market equity noktasi HER mum adiminda,
 * tum acik pozisyonlar birlikte degerlendirilerek uretilmeli.
 */
function stepCandles(
  args: SimulateArgs,
  open: OpenPosition[],
  fromT: number,
  toT: number,
  closeAt: (pos: OpenPosition, exit: number, t: number, r: ExitReason) => void,
  balance: () => number,
  equityCurve: EquityPoint[],
  markAt: Record<string, (ts: number) => number | null>,
): void {
  if (open.length === 0) return;

  // Ilgili sembollerin mumlarindan zaman ekseni cikar (ayni interval -> hizali).
  const times = new Set<number>();
  for (const pos of open) {
    for (const k of args.klines[pos.symbol] ?? []) {
      if (k.openTime >= fromT && k.openTime < toT) times.add(k.openTime);
    }
  }
  const axis = Array.from(times).sort((a, b) => a - b);

  for (const t of axis) {
    const closing: OpenPosition[] = [];

    for (const pos of open) {
      const candle = candleAt(args.klines[pos.symbol] ?? [], t);
      if (!candle) continue;

      // Funding: bu mumun kapanisina kadar tahakkuk et. Pozisyon ACIKKEN birikir —
      // kapanista toplu yazmak, equity curve'unu (ve max-DD'yi) yalanci yapardi.
      const f = accrueFunding({
        cfg: args.costs,
        side: pos.side,
        qtyBase: pos.qtyBase,
        fromMs: pos.fundingCursor,
        toMs: candle.closeTime,
        funding: args.funding[pos.symbol] ?? [],
        markAt: markAt[pos.symbol] ?? (() => null),
      });
      pos.fundingAccrued += f;
      pos.fundingCursor = candle.closeTime;

      const exit = processPositionCandle(pos, candle, args);
      if (exit) {
        closeAt(pos, exit.exitPrice, candle.openTime, exit.reason);
        closing.push(pos);
      }
    }

    for (const pos of closing) {
      const i = open.indexOf(pos);
      if (i >= 0) open.splice(i, 1);
    }

    // MARK-TO-MARKET: nakit + acik pozisyonlarin tasfiye degeri.
    equityCurve.push({ timestamp: t, balance: balance() + unrealized(open, args, t) });
  }
}

/** Acik pozisyonlarin `t` anindaki tasfiye degeri (fee ve funding dusulmus). */
function unrealized(open: OpenPosition[], args: SimulateArgs, t: number): number {
  let sum = 0;
  for (const pos of open) {
    const candle = candleAt(args.klines[pos.symbol] ?? [], t);
    if (!candle) continue;
    const dir = pos.side === 'LONG' ? 1 : -1;
    const gross = pos.qtyBase * (candle.close - pos.entryFill) * dir;
    const exitFeeEst = takerFee(args.costs, pos.qtyBase, candle.close);
    const value = gross - pos.feeEntry - exitFeeEst - pos.fundingAccrued;
    // Izole margin: pozisyonun degeri -margin'in altina inemez.
    sum += Math.max(value, -pos.margin);
  }
  return sum;
}

function candleAt(klines: Kline[], openTime: number): Kline | null {
  let lo = 0;
  let hi = klines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = klines[mid]!;
    if (k.openTime === openTime) return k;
    if (k.openTime < openTime) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * Sizing icin ATR. Sample bunu her girişte calculateAllIndicators(son 250 mum) ile
 * YENIDEN hesapliyordu (backtestExecutor.ts:916) — grid'de bu, simulasyonun degil
 * gecenin kendisi oluyordu. Artik onceden hesaplanmis seriden okunuyor: seri
 * klines ile 1:1 hizali, indicators[j] = j'inci mum DAHIL hesaplanmis indikatorler.
 */
function atrAt(args: SimulateArgs, symbol: string, t: number): number {
  const ks = args.klines[symbol] ?? [];
  const series = args.indicators[symbol] ?? [];

  const j = lastIndexBefore(ks, t);
  if (j < 0 || j >= series.length) return 0;

  const atr = series[j]!.atr;
  return typeof atr === 'number' && atr > 0 ? atr : 0;
}

/** openTime < t olan SON mumun indeksi. Katı `<` — karar barinin kendisi dahil degil. */
function lastIndexBefore(klines: Kline[], t: number): number {
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

// ---------------------------------------------------------------- cikis motoru
// Sample'dan portlandi (backtestExecutor.ts:1053-1378). Kotumser siralama
// konvansiyonlari ve breakeven yurumesi aynen korundu; sadece senkron + maliyetli.

function processPositionCandle(
  pos: OpenPosition,
  candle: Kline,
  args: SimulateArgs,
): { reason: 'SL' | 'TP' | 'TRAIL' | 'BE'; exitPrice: number } | null {
  // MAE/MFE uclari cikis kontrolunden ONCE guncellenir ki cikis mumu da sayilsin.
  pos.highestPrice = Math.max(pos.highestPrice, candle.high);
  pos.lowestPrice = Math.min(pos.lowestPrice, candle.low);

  if (pos.isTrailing) return processTrailingCandle(pos, candle, args);

  const isLong = pos.side === 'LONG';
  const slHit = isLong ? candle.low <= pos.stopLossPrice : candle.high >= pos.stopLossPrice;
  const tpHit = isLong ? candle.high >= pos.takeProfitPrice : candle.low <= pos.takeProfitPrice;
  const beTrigHit =
    !pos.breakevenApplied &&
    pos.breakevenTriggerPrice !== undefined &&
    (isLong ? candle.high >= pos.breakevenTriggerPrice : candle.low <= pos.breakevenTriggerPrice);
  const beRetraceHit =
    beTrigHit &&
    pos.breakevenPrice !== undefined &&
    (isLong ? candle.low <= pos.breakevenPrice : candle.high >= pos.breakevenPrice);

  let reason: 'SL' | 'TP' | 'BE' | null = null;

  if ((slHit && tpHit) || (beTrigHit && (slHit || beRetraceHit))) {
    // Celiskili mum: icini 1m ile gez, hangi seviye ONCE vuruldu?
    reason = resolveIntrabar(pos, candle, args, !slHit);
  } else if (slHit) {
    reason = stopExitReason(pos);
  } else if (tpHit) {
    reason = 'TP';
  } else if (beTrigHit) {
    applyBreakeven(pos); // cikis yok — stop breakeven'a tasindi
  }

  if (reason) {
    return { reason, exitPrice: reason === 'TP' ? pos.takeProfitPrice : pos.stopLossPrice };
  }
  return null;
}

function resolveIntrabar(
  pos: OpenPosition,
  candle: Kline,
  args: SimulateArgs,
  pessimisticBE = false,
): 'SL' | 'TP' | 'BE' {
  const fallback = (): 'SL' | 'BE' => {
    if (pessimisticBE) applyBreakeven(pos);
    return stopExitReason(pos);
  };

  const fine = args.intrabar(pos.symbol, candle.openTime, candle.closeTime);
  if (fine.length === 0) return fallback();

  const isLong = pos.side === 'LONG';

  for (const fk of fine) {
    const slHit = isLong ? fk.low <= pos.stopLossPrice : fk.high >= pos.stopLossPrice;
    const tpHit = isLong ? fk.high >= pos.takeProfitPrice : fk.low <= pos.takeProfitPrice;

    if (slHit && tpHit) {
      // Ince mum yine ikisine de deger (cok nadir): acilisa yakin seviye once vurulmus kabul.
      const distSL = Math.abs(fk.open - pos.stopLossPrice);
      const distTP = Math.abs(fk.open - pos.takeProfitPrice);
      return distSL <= distTP ? stopExitReason(pos) : 'TP';
    }
    if (slHit) return stopExitReason(pos);

    if (
      !pos.breakevenApplied &&
      pos.breakevenTriggerPrice !== undefined &&
      (isLong ? fk.high >= pos.breakevenTriggerPrice : fk.low <= pos.breakevenTriggerPrice)
    ) {
      applyBreakeven(pos);
      if (!tpHit && (isLong ? fk.low <= pos.stopLossPrice : fk.high >= pos.stopLossPrice)) {
        return 'BE';
      }
    }

    if (tpHit) return 'TP';
  }

  return fallback();
}

function processTrailingCandle(
  pos: OpenPosition,
  candle: Kline,
  args: SimulateArgs,
): { reason: 'SL' | 'TRAIL' | 'BE'; exitPrice: number } | null {
  const isLong = pos.side === 'LONG';
  const cb = (pos.callbackRate ?? 0) / 100;

  if (!pos.trailingActive) {
    const hardHit = isLong ? candle.low <= pos.stopLossPrice : candle.high >= pos.stopLossPrice;
    const actHit = isLong ? candle.high >= pos.activationPrice! : candle.low <= pos.activationPrice!;
    const beTrigHit =
      !pos.breakevenApplied &&
      pos.breakevenTriggerPrice !== undefined &&
      (isLong ? candle.high >= pos.breakevenTriggerPrice : candle.low <= pos.breakevenTriggerPrice);

    if (hardHit && (actHit || beTrigHit)) {
      return resolveTrailingFine(pos, candle, args);
    }
    if (hardHit) return { reason: stopExitReason(pos), exitPrice: pos.stopLossPrice };

    if (actHit) {
      if (beTrigHit) applyBreakeven(pos);
      pos.trailingActive = true;
      pos.peakPrice = isLong ? candle.high : candle.low;
      const trail = isLong ? pos.peakPrice * (1 - cb) : pos.peakPrice * (1 + cb);
      const exitLevel = isLong ? Math.max(trail, pos.stopLossPrice) : Math.min(trail, pos.stopLossPrice);
      const exitHit = isLong ? candle.low <= exitLevel : candle.high >= exitLevel;
      if (exitHit) return { reason: trailingExitReason(pos, exitLevel), exitPrice: exitLevel };
      return null;
    }

    if (beTrigHit) {
      const wouldBeStop = isLong
        ? Math.max(pos.stopLossPrice, pos.breakevenPrice!)
        : Math.min(pos.stopLossPrice, pos.breakevenPrice!);
      const retrace = isLong ? candle.low <= wouldBeStop : candle.high >= wouldBeStop;
      if (retrace) return resolveTrailingFine(pos, candle, args, true);
      applyBreakeven(pos);
    }
    return null;
  }

  // Aktif faz: once mevcut peak'ten cikis seviyesi test edilir (kotumser), sonra peak ratchet'lenir.
  const trail = isLong ? pos.peakPrice! * (1 - cb) : pos.peakPrice! * (1 + cb);
  const exitLevel = isLong ? Math.max(trail, pos.stopLossPrice) : Math.min(trail, pos.stopLossPrice);
  const exitHit = isLong ? candle.low <= exitLevel : candle.high >= exitLevel;
  if (exitHit) return { reason: trailingExitReason(pos, exitLevel), exitPrice: exitLevel };

  if (
    !pos.breakevenApplied &&
    pos.breakevenTriggerPrice !== undefined &&
    (isLong ? candle.high >= pos.breakevenTriggerPrice : candle.low <= pos.breakevenTriggerPrice)
  ) {
    applyBreakeven(pos);
  }

  pos.peakPrice = isLong
    ? Math.max(pos.peakPrice!, candle.high)
    : Math.min(pos.peakPrice!, candle.low);
  return null;
}

function resolveTrailingFine(
  pos: OpenPosition,
  candle: Kline,
  args: SimulateArgs,
  pessimisticBE = false,
): { reason: 'SL' | 'TRAIL' | 'BE'; exitPrice: number } | null {
  const stopExit = () => ({ reason: stopExitReason(pos), exitPrice: pos.stopLossPrice });
  const fallback = () => {
    if (pessimisticBE) applyBreakeven(pos);
    return stopExit();
  };

  const fine = args.intrabar(pos.symbol, candle.openTime, candle.closeTime);
  if (fine.length === 0) return fallback();

  const isLong = pos.side === 'LONG';
  const cb = (pos.callbackRate ?? 0) / 100;

  for (const fk of fine) {
    if (!pos.trailingActive) {
      const stopHit = isLong ? fk.low <= pos.stopLossPrice : fk.high >= pos.stopLossPrice;
      if (stopHit) return stopExit();

      if (
        !pos.breakevenApplied &&
        pos.breakevenTriggerPrice !== undefined &&
        (isLong ? fk.high >= pos.breakevenTriggerPrice : fk.low <= pos.breakevenTriggerPrice)
      ) {
        applyBreakeven(pos);
      }

      const actHit = isLong ? fk.high >= pos.activationPrice! : fk.low <= pos.activationPrice!;
      if (actHit) {
        pos.trailingActive = true;
        pos.peakPrice = isLong ? fk.high : fk.low;
        // Ayni ince mumda aktif faz testi asagida (fall-through).
      } else {
        if (
          pos.breakevenApplied &&
          (isLong ? fk.low <= pos.stopLossPrice : fk.high >= pos.stopLossPrice)
        ) {
          return { reason: 'BE', exitPrice: pos.stopLossPrice };
        }
        continue;
      }
    }

    const trail = isLong ? pos.peakPrice! * (1 - cb) : pos.peakPrice! * (1 + cb);
    const exitLevel = isLong ? Math.max(trail, pos.stopLossPrice) : Math.min(trail, pos.stopLossPrice);
    const exitHit = isLong ? fk.low <= exitLevel : fk.high >= exitLevel;
    if (exitHit) return { reason: trailingExitReason(pos, exitLevel), exitPrice: exitLevel };

    pos.peakPrice = isLong ? Math.max(pos.peakPrice!, fk.high) : Math.min(pos.peakPrice!, fk.low);
  }

  return null;
}

const round2 = (n: number) => parseFloat(n.toFixed(2));
const round3 = (n: number) => parseFloat(n.toFixed(3));
