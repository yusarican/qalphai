import { buildStrategyContext, lastIndexBefore } from './context';
import { allocate, type Allocation, type Rejection } from './portfolio';
import type { FundingRate, Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';
import type { CandleInterval } from '../config/env';
import type { StrategyProfile } from '../lib/types';
import { isSignal, isVeto, type Strategy, type StrategySignal } from '../strategy/types';

/**
 * ANTI-DRIFT DEGISMEZI.
 *
 * Backtest ve CANLI islem AYNI fonksiyonu cagirir. Backtest bunu tarih uzerinde bir
 * donguyle, canli ise en taze kapanmis mumda BIR KEZ cagirir. Baska hicbir fark yoktur.
 *
 * Bu ikisi iraksarsa — canli kodu backtest'ten farkli bir sinyal uretirse — sistemin
 * urettigi her rapordaki her sayi yalan olur: walk-forward, promosyon kapisi, heatmap,
 * hepsi gerceklesmeyen bir stratejiyi olcuyor demektir. Bu yuzden ayni fonksiyon,
 * ve bu yuzden her gece calisan bir PARITE testi (orchestrator/stages/championEval).
 */

export interface DecideAtArgs {
  strategy: Strategy;
  symbols: string[];
  interval: CandleInterval;
  /** Karar ani (bir mumun openTime'i). Bu andan onceki mumlar gorulur. */
  at: number;

  klines: Record<string, Kline[]>;
  indicators: Record<string, TechnicalIndicators[]>;
  funding: Record<string, FundingRate[]>;
  lsr: Record<string, { longShortRatio: number; longAccount: number; shortAccount: number }>;
  macroRiskAppetite: 'risk_on' | 'risk_off' | 'mixed' | null;

  profile: StrategyProfile;
  params: Record<string, number | boolean>;

  /** Strateji'yi sandbox'ta kosmak icin. Verilmezse dogrudan cagrilir (yalniz builtin icin). */
  evaluate?: (ctx: ReturnType<typeof buildStrategyContext>) => ReturnType<Strategy['evaluate']>;
}

export interface DecideAtResult {
  timestamp: number;
  allocations: Allocation[];
  rejections: Rejection[];
}

const BTC_SYMBOL = 'BTCUSDT';

export function decideAt(args: DecideAtArgs): DecideAtResult {
  const riskOff = args.macroRiskAppetite === 'risk_off';
  const btc = btcRegimeAt(args, args.at);

  const signals: Array<{ symbol: string; signal: StrategySignal; atr: number; price: number }> = [];
  const rejections: Rejection[] = [];

  for (const symbol of args.symbols) {
    const klines = args.klines[symbol] ?? [];
    const indicators = args.indicators[symbol] ?? [];

    const ctx = buildStrategyContext({
      symbol,
      interval: args.interval,
      at: args.at,
      klines,
      indicators,
      funding: args.funding[symbol] ?? [],
      lsr: args.lsr[symbol] ?? null,
      macroRiskAppetite: args.macroRiskAppetite,
      btc,
      params: args.params,
      warmupBars: args.strategy.meta.warmupBars,
    });

    if (!ctx) continue; // warmup dolmadi — strateji cagrilmaz

    const decision = args.evaluate ? args.evaluate(ctx) : args.strategy.evaluate(ctx);

    if (isVeto(decision)) {
      rejections.push({
        symbol,
        rule: decision.rule,
        side: decision.wouldBe,
        note: decision.note,
      });
      continue;
    }

    if (!isSignal(decision)) continue;

    // Sozlesme ihlali savunmasi: sandbox'tan gecmis olsa bile sayiyi dogrula.
    if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
      rejections.push({ symbol, rule: 'INVALID_CONFIDENCE', side: decision.side });
      continue;
    }

    const j = lastIndexBefore(klines, args.at);
    const atr = j >= 0 && j < indicators.length ? indicators[j]!.atr : null;
    const price = j >= 0 ? klines[j]!.close : 0;

    // ATR olmadan pozisyon buyuklugu hesaplanamaz -> sinyal uygulanamaz.
    if (!atr || !(atr > 0) || !(price > 0)) {
      rejections.push({ symbol, rule: 'NO_ATR_SIZING', side: decision.side });
      continue;
    }

    signals.push({ symbol, signal: decision, atr, price });
  }

  const { allocations, rejections: capRejections } = allocate({
    signals,
    profile: args.profile,
    riskOff,
  });

  return {
    timestamp: args.at,
    allocations,
    rejections: [...rejections, ...capRejections],
  };
}

/** BTC rejim baglami: `at` aninda son kapali mumun close'u ve SMA200'u. */
function btcRegimeAt(args: DecideAtArgs, at: number): { price: number; sma200: number | null } | null {
  const ks = args.klines[BTC_SYMBOL];
  const ind = args.indicators[BTC_SYMBOL];
  if (!ks || !ind) return null;

  const j = lastIndexBefore(ks, at);
  if (j < 0 || j >= ind.length) return null;

  return { price: ks[j]!.close, sma200: ind[j]!.sma200 };
}
