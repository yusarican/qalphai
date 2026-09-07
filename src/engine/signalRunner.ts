import { buildStrategyContext, lastIndexBefore } from './context';
import { allocate, type Allocation, type Rejection } from './portfolio';
import type { FundingRate, Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';
import type { CandleInterval } from '../config/env';
import type { StrategyProfile } from '../lib/types';
import { isSignal, isVeto, type Strategy, type StrategySignal, type StrategyVeto } from '../strategy/types';

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

  /**
   * KARSI-OLGUSAL OLCUM — "bu filtre olmasaydi ne olurdu?" (engine/gateAnalysis.ts).
   *
   * Burada adi gecen veto kurallari KALDIRILIR: strateji o kuralla veto verdiginde,
   * karar `wouldBe` yonunde bir SINYALE cevrilir ve akisin geri kalani (ATR/fiyat
   * kontrolu, allocate, simulator) hicbir sey degismeden isler.
   *
   * Neden kodu degistirmeye gerek yok: StrategyVeto zaten `wouldBe` tasiyor
   * (strategy/types.ts:191) — sozlesme bu olcumu yapabilmek icin tasarlanmisti.
   *
   * VERILMEZSE HICBIR SEY DEGISMEZ. Bu, tests/gateAnalysis.test.ts'in ilk testidir:
   * alan bos oldugunda karar akisi bugunkuyle bit bit ayni cikmalidir.
   */
  liftedVetoRules?: ReadonlySet<string>;
  /**
   * Kaldirilan veto icin kullanilacak guven degeri.
   *
   * DURUSTLUK NOTU: vetolanmis bir barda strateji hicbir zaman bir confidence uretmedi;
   * bu sayi bir VARSAYIMDIR ve rapora oyle yazilir (gateAnalysis.ts). Cagiran taraf
   * modelin gercek sinyallerinin medyanini gecer. MIN_CONF kapisi (simulator.ts:250)
   * sonrasinda yine uygulanir — yani sentetik sinyal kapiyi otomatik gecmez.
   */
  liftedConfidence?: number;
}

/** Kaldirilan bir veto icin varsayilan guven — cagiran vermezse. */
export const DEFAULT_LIFTED_CONFIDENCE = 0.5;

/**
 * Bir veto kararini, kural kaldirilmissa sinyale cevirir; degilse null doner.
 *
 * signalRunner (dogrudan yol) ve sandbox worker (izole yol) AYNI fonksiyonu cagirir.
 * Iki yerde iki kopya olsaydi, builtin sampiyonun gate bilancosu ile Codex adayinin
 * gate bilancosu farkli kurallarla hesaplanirdi — kiyas anlamsizlasirdi.
 */
export function liftVeto(
  decision: StrategyVeto,
  lifted: ReadonlySet<string> | undefined,
  confidence: number | undefined,
): StrategySignal | null {
  if (!lifted || !lifted.has(decision.rule)) return null;
  // `wouldBe` yoksa yon bilinmiyor demektir ve UYDURULMAZ: kural olcumde
  // "karsi-olgusu alinamaz" olarak isaretlenir (gateAnalysis.ts).
  if (decision.wouldBe !== 'LONG' && decision.wouldBe !== 'SHORT') return null;

  return {
    side: decision.wouldBe,
    confidence: clamp01(confidence ?? DEFAULT_LIFTED_CONFIDENCE),
    reason: `karsi-olgu: ${decision.rule} kaldirildi`,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LIFTED_CONFIDENCE;
  return Math.max(0, Math.min(1, n));
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

    let signal: StrategySignal | null = null;

    if (isVeto(decision)) {
      // Karsi-olgusal olcum: kural kaldirilmissa veto bir sinyale doner (bkz. liftVeto).
      // Kaldirilmamissa bugunku davranis — reddedilenler listesine yazilir ve gecilir.
      signal = liftVeto(decision, args.liftedVetoRules, args.liftedConfidence);
      if (!signal) {
        rejections.push({
          symbol,
          rule: decision.rule,
          side: decision.wouldBe,
          note: decision.note,
        });
        continue;
      }
    } else if (isSignal(decision)) {
      signal = decision;
    }

    if (!signal) continue;

    // Sozlesme ihlali savunmasi: sandbox'tan gecmis olsa bile sayiyi dogrula.
    if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
      rejections.push({ symbol, rule: 'INVALID_CONFIDENCE', side: signal.side });
      continue;
    }

    const j = lastIndexBefore(klines, args.at);
    const atr = j >= 0 && j < indicators.length ? indicators[j]!.atr : null;
    const price = j >= 0 ? klines[j]!.close : 0;

    // ATR olmadan pozisyon buyuklugu hesaplanamaz -> sinyal uygulanamaz.
    if (!atr || !(atr > 0) || !(price > 0)) {
      rejections.push({ symbol, rule: 'NO_ATR_SIZING', side: signal.side });
      continue;
    }

    signals.push({ symbol, signal, atr, price });
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
