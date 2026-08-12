import { describe, expect, it } from 'vitest';
import { decidePortfolioDetailed } from './fixtures/mechanicalDecider.reference';
import { allocate } from '../src/engine/portfolio';
import mechanicalV0 from '../src/strategy/builtin/mechanicalV0';
import { isSignal, isVeto, type StrategyContext, type StrategyIndicators } from '../src/strategy/types';
import type { TechnicalIndicators } from '../src/vendor/technicalIndicators';

/**
 * ALTIN PARITE TESTI — refactor'un en riskli parcasinin kaniti.
 *
 * Sample'in mechanicalDecider'i TEK bir fonksiyonda iki is yapiyordu:
 *   (a) sinyal uretimi  -> src/strategy/builtin/mechanicalV0.ts    (Codex'in de yazdigi yer)
 *   (b) kaldirac + tahsis -> src/engine/portfolio.ts               (Codex'in ASLA goremedigi yer)
 *
 * Bu ayrim, tum guvenlik modelinin temeli: kaldirac karar motorunun ICINDE kalsaydi,
 * Codex confidence uzerinden riske DOLAYLI bir kol kazanirdi. Ama ayrim ancak
 * DAVRANISI KORUYORSA gecerli — aksi halde "sampiyon v0" dedigimiz sey, sample'in
 * calistirdigi stratejiden baska bir sey olur ve tum tarihsel kiyas anlamini yitirir.
 *
 * Bu test, ayni girdiyle iki motorun BIREBIR ayni allocation'i urettigini dogrular.
 */

// --- Sentetik ama gercekci indikator uretimi -------------------------------------

function makeIndicators(over: {
  composite: number;
  atr?: number;
  volumeRatio?: number;
  plusDI?: number;
  minusDI?: number;
  sma200?: number | null;
}): TechnicalIndicators {
  const tier = (bias: number) => ({ bias, strength: 1, signals: [] as string[] });
  return {
    rsi: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollingerBands: { upper: 110, middle: 100, lower: 90, bandwidth: 20, percentB: 0.5 },
    ema: { ema20: 100, ema50: 100, ema200: 100, ema50Slope: 0, trend: 'neutral' },
    volumeProfile: {
      averageVolume: 1000,
      currentVsAverage: over.volumeRatio ?? 1.5,
      volumeTrend: 'stable',
    },
    atr: over.atr ?? 50,
    sma200: over.sma200 === undefined ? 100 : over.sma200,
    stochastic: { k: 50, d: 50, signal: 'neutral' },
    adx: {
      adx: 25,
      plusDI: over.plusDI ?? 25,
      minusDI: over.minusDI ?? 20,
      trendStrength: 'strong',
    },
    fibonacci: null,
    candlestickPatterns: [],
    hierarchy: {
      tier1_trend: tier(0),
      tier2_momentum: tier(0),
      tier3_structure: tier(0),
      tier4_priceAction: tier(0),
      tier5_volume: tier(0),
      // evaluateSymbol yalnizca compositeScore'u okur; tier'lar sadece reasoning metnine girer.
      compositeScore: over.composite,
      overallBias: 'neutral',
    },
    summary: '',
  } as TechnicalIndicators;
}

function makeCtx(args: {
  symbol: string;
  ti: TechnicalIndicators;
  price: number;
  params: Record<string, number | boolean>;
  funding?: number | null;
  macro?: 'risk_on' | 'risk_off' | 'mixed' | null;
  btc?: { price: number; sma200: number | null } | null;
  candles?: Array<{ open: number; close: number }>;
}): StrategyContext {
  const raw = args.candles ?? [{ open: 100, close: 101 }];
  const candles = raw.map((c, i) => ({
    openTime: i * 1000,
    closeTime: i * 1000 + 999,
    open: c.open,
    high: Math.max(c.open, c.close),
    low: Math.min(c.open, c.close),
    close: c.close,
    volume: 1000,
  }));
  return {
    symbol: args.symbol,
    interval: '4h',
    now: candles[candles.length - 1]!.closeTime,
    candles,
    indicators: args.ti as unknown as StrategyIndicators,
    history: [args.ti as unknown as StrategyIndicators],
    funding: args.funding ?? null,
    lsr: null,
    macro: { riskAppetite: args.macro ?? null },
    market: { btc: args.btc ?? null },
    params: args.params,
  };
}

/** mechanicalV0 + portfolio.allocate = sample'in decidePortfolioDetailed'inin karsiligi. */
function runNewEngine(args: {
  symbols: string[];
  indicators: Record<string, TechnicalIndicators>;
  prices: Record<string, number>;
  params: Record<string, number | boolean>;
  profile: 'conservative' | 'balanced' | 'aggressive';
  funding?: Record<string, number>;
  macro?: 'risk_on' | 'risk_off' | 'mixed' | null;
  candles?: Record<string, Array<{ open: number; close: number }>>;
}) {
  const strat = mechanicalV0();
  const btcTi = args.indicators['BTCUSDT'];
  const btcPrice = args.prices['BTCUSDT'];
  const btc =
    btcTi && btcPrice ? { price: btcPrice, sma200: btcTi.sma200 } : null;

  const signals: Array<{ symbol: string; signal: ReturnType<typeof strat.evaluate>; atr: number; price: number }> = [];
  const vetoes: Array<{ symbol: string; rule: string }> = [];

  for (const symbol of args.symbols) {
    const ti = args.indicators[symbol]!;
    const price = args.prices[symbol]!;
    const ctx = makeCtx({
      symbol,
      ti,
      price,
      params: args.params,
      funding: args.funding?.[symbol] ?? null,
      macro: args.macro ?? null,
      btc,
      candles: args.candles?.[symbol],
    });
    const d = strat.evaluate(ctx);
    if (isVeto(d)) vetoes.push({ symbol, rule: d.rule });
    else if (isSignal(d)) signals.push({ symbol, signal: d, atr: ti.atr!, price });
  }

  const { allocations } = allocate({
    signals: signals.filter((s) => isSignal(s.signal)) as never,
    profile: args.profile,
    riskOff: args.macro === 'risk_off',
  });

  return { allocations, vetoes };
}

/** Sample motorunu ayni girdiyle kosar. */
function runSampleEngine(args: Parameters<typeof runNewEngine>[0]) {
  return decidePortfolioDetailed({
    symbols: args.symbols,
    indicators: args.indicators,
    prices: args.prices,
    funding: args.funding,
    lastCandles: args.candles,
    macroRiskAppetite: args.macro ?? null,
    strategy: args.profile,
    config: {
      entryThreshold: args.params['entryThreshold'] as number,
      minVolumeRatio: args.params['minVolumeRatio'] as number,
      requireDirectionalDi: args.params['requireDirectionalDi'] as boolean,
      confirmationCandles: args.params['confirmationCandles'] as number,
      btcRegimeFilter: args.params['btcRegimeFilter'] as boolean,
    },
  });
}

// Sample'in 'balanced' profili: entryThreshold 0.35, minConfidence 0.6.
const BALANCED_PARAMS = {
  entryThreshold: 0.35,
  minConfidence: 0.6,
  minVolumeRatio: 0,
  requireDirectionalDi: false,
  confirmationCandles: 0,
  btcRegimeFilter: true,
};

describe('decider paritesi: mechanicalV0 + portfolio == sample mechanicalDecider', () => {
  const cases: Array<{ name: string; args: Parameters<typeof runNewEngine>[0] }> = [
    {
      name: 'tek guclu LONG',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.7 }) },
        prices: { BTCUSDT: 50_000 },
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'tek guclu SHORT',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: -0.8 }) },
        prices: { BTCUSDT: 50_000 },
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'esik alti -> giris yok',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.2 }) },
        prices: { BTCUSDT: 50_000 },
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'coklu sembol, tahsis tavani devrede',
      args: {
        symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
        indicators: {
          BTCUSDT: makeIndicators({ composite: 0.9 }),
          ETHUSDT: makeIndicators({ composite: 0.8 }),
          SOLUSDT: makeIndicators({ composite: -0.75 }),
          BNBUSDT: makeIndicators({ composite: 0.6 }),
          XRPUSDT: makeIndicators({ composite: -0.55 }),
          DOGEUSDT: makeIndicators({ composite: 0.5 }),
        },
        prices: {
          BTCUSDT: 50_000, ETHUSDT: 3_000, SOLUSDT: 150,
          BNBUSDT: 600, XRPUSDT: 0.6, DOGEUSDT: 0.15,
        },
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'funding kalabaligi cezasi (LONG, yuksek pozitif funding)',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.45 }) },
        prices: { BTCUSDT: 50_000 },
        funding: { BTCUSDT: 0.002 },
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'makro risk-off: confidence cezasi + kaldirac bir kademe duser',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.75, atr: 100 }) },
        prices: { BTCUSDT: 50_000 },
        macro: 'risk_off',
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'BTC dusus + mixed makro -> LONG cezali',
      args: {
        symbols: ['BTCUSDT'],
        // fiyat 45k < sma200 50k -> BTC asagi rejim
        indicators: { BTCUSDT: makeIndicators({ composite: 0.4, sma200: 50_000 }) },
        prices: { BTCUSDT: 45_000 },
        macro: 'mixed',
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'dusuk hacim filtresi',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.7, volumeRatio: 0.5 }) },
        prices: { BTCUSDT: 50_000 },
        params: { ...BALANCED_PARAMS, minVolumeRatio: 1.0 },
        profile: 'balanced',
      },
    },
    {
      name: 'DI uyusmazligi (LONG ama -DI > +DI)',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.7, plusDI: 15, minusDI: 30 }) },
        prices: { BTCUSDT: 50_000 },
        params: { ...BALANCED_PARAMS, requireDirectionalDi: true },
        profile: 'balanced',
      },
    },
    {
      name: 'onay bari: son mum sinyal yonunde kapanmadi',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.7 }) },
        prices: { BTCUSDT: 50_000 },
        candles: { BTCUSDT: [{ open: 100, close: 95 }] }, // kirmizi mum, LONG sinyali
        params: { ...BALANCED_PARAMS, confirmationCandles: 1 },
        profile: 'balanced',
      },
    },
    {
      name: 'ATR yok -> sizing imkansiz',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.7, atr: 0 }) },
        prices: { BTCUSDT: 50_000 },
        params: BALANCED_PARAMS,
        profile: 'balanced',
      },
    },
    {
      name: 'aggressive profil (esik 0.25, minConf 0.5, kaldirac merdiveni farkli)',
      args: {
        symbols: ['BTCUSDT', 'ETHUSDT'],
        indicators: {
          BTCUSDT: makeIndicators({ composite: 0.3, atr: 200 }),
          ETHUSDT: makeIndicators({ composite: -0.65, atr: 10 }),
        },
        prices: { BTCUSDT: 50_000, ETHUSDT: 3_000 },
        params: { ...BALANCED_PARAMS, entryThreshold: 0.25, minConfidence: 0.5 },
        profile: 'aggressive',
      },
    },
    {
      name: 'conservative profil (esik 0.45, minConf 0.8)',
      args: {
        symbols: ['BTCUSDT'],
        indicators: { BTCUSDT: makeIndicators({ composite: 0.85, atr: 20 }) },
        prices: { BTCUSDT: 50_000 },
        params: { ...BALANCED_PARAMS, entryThreshold: 0.45, minConfidence: 0.8 },
        profile: 'conservative',
      },
    },
  ];

  /**
   * BOSLUK KORUMASI. Bu testin en sinsi basarisizlik modu, sessizce VAKUM olmasidir:
   * sample motoru bir gun hic allocation uretmezse (import kirilir, sema kayar), bizimki
   * de bos doner ve "[] == []" diye yesil yanar — yani hicbir sey dogrulamadan gecer.
   * Asagidaki kontrol, senaryolarin gercekten is uretmeye devam ettigini garanti eder.
   */
  it('senaryolar gercek allocation uretiyor (test vakum degil)', () => {
    const multi = cases.find((c) => c.name.startsWith('coklu sembol'))!;
    const sample = runSampleEngine(multi.args);

    // Tahsis tavani bagliyor: balanced profili %80'de duruyor, yani 6 adaydan yalnizca
    // bir kismi yerlesiyor — cap dongusu gercekten calisiyor.
    expect(sample.result.allocations.length).toBeGreaterThanOrEqual(3);
    const totalPct = sample.result.allocations.reduce(
      (s: number, a: { allocationPercent: number }) => s + a.allocationPercent,
      0,
    );
    expect(totalPct).toBe(80);

    // Kaldirac merdiveni de calisiyor: ATR/fiyat oranina gore farkli kademeler cikiyor.
    const levels = new Set(sample.result.allocations.map((a: { leverage: number }) => a.leverage));
    expect(levels.size).toBeGreaterThan(1);
  });

  for (const c of cases) {
    it(c.name, () => {
      const sample = runSampleEngine(c.args);
      const fresh = runNewEngine(c.args);

      // Sample'in AssetAllocation'i ile bizim Allocation'imizin ORTAK alanlari:
      // sembol, yon, confidence, kaldirac, tahsis yuzdesi. (reasoning metni ve
      // TP/SL alanlari kasten karsilastirilmiyor: TP/SL artik harness'in isi,
      // sample onlari sadece sema doldurmak icin yaziyordu.)
      const norm = (a: { symbol: string; signal?: string; side?: string; confidence: number; leverage: number; allocationPercent: number }) => ({
        symbol: a.symbol,
        side: a.signal ?? a.side,
        confidence: a.confidence,
        leverage: a.leverage,
        allocationPercent: a.allocationPercent,
      });

      const expected = sample.result.allocations.map(norm);
      const actual = fresh.allocations.map(norm);

      expect(actual).toEqual(expected);
    });
  }
});
