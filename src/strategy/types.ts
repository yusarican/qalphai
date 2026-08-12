/**
 * ============================================================================
 * STRATEJI SOZLESMESI — Codex'in gordugu TEK dosya.
 * ============================================================================
 *
 * Bu dosyanin SIFIR import'u vardir. Sebep: sandbox calisma dizinine
 * `strategy-api.d.ts` olarak AYNEN kopyalanabilsin diye. Codex'in cwd'sinde
 * motor kodu, .env, Firestore anahtari, backtest, skorlama — hicbiri yok.
 *
 * Kisitin YAPISAL olarak zorlanmasi (prompt'la rica ederek degil):
 *
 *   1. evaluate() `Promise` DONMEZ. Sandbox tsconfig'inde async bir implementasyon
 *      derlenmez. async yok => await yok => I/O yok => ag yok, disk yok.
 *
 *   2. Donus tipinde `size`, `quantity`, `leverage`, `takeProfit`, `stopLoss`,
 *      `margin` ALANLARI YOKTUR. Bir strateji bu kavramlari IFADE EDEMEZ.
 *      Pozisyon buyuklugu, kaldirac ve TP/SL harness'in tekelindedir
 *      (src/engine/portfolio.ts + src/engine/riskManagement.ts).
 *
 *   3. ctx derin dondurulmustur ve sandbox realm'i ICINDE JSON'dan uretilir —
 *      host prototip zincirine tirmanilamaz.
 *
 *   4. Sandbox tsconfig'i `"types": []`, `"lib": ["ES2022"]` kullanir:
 *      process / require / fs / fetch / Buffer tip kontrolunden gecemez.
 *
 * evaluate() SAF olmalidir: senkron, deterministik, yan etkisiz. Ayni ctx her
 * zaman ayni karari vermeli — herhangi bir sirada, herhangi bir sürecte, sonsuza dek.
 * Bu bir temenni degil: src/strategy/gauntlet.ts determinizm, durumsuzluk, sira
 * bagimsizligi ve look-ahead testlerini calistirir ve dusen aday backtest'e ULASAMAZ.
 */

// ---------------------------------------------------------------- veri

/** KAPANMIS mum. Harness sana asla kapanmamis bar vermez. */
export interface StrategyCandle {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface TierScore {
  /** -1.0 (kuvvetli dusus) .. +1.0 (kuvvetli yukselis) */
  readonly bias: number;
  /** 0 .. 1 — sinyalin netligi */
  readonly strength: number;
  readonly signals: ReadonlyArray<string>;
}

/**
 * TEK bir mum icin onceden hesaplanmis indikatorler.
 * Herhangi bir alan null olabilir (yeterli mum yoksa). null kontrolu SENIN isin.
 */
export interface StrategyIndicators {
  readonly rsi: number | null; // 0-100
  readonly macd: { readonly macd: number; readonly signal: number; readonly histogram: number } | null;
  readonly bollingerBands: {
    readonly upper: number;
    readonly middle: number;
    readonly lower: number;
    readonly bandwidth: number; // (upper - lower) / middle * 100
    readonly percentB: number; // (price - lower) / (upper - lower)
  } | null;
  readonly ema: {
    readonly ema20: number;
    readonly ema50: number;
    readonly ema200: number | null; // <200 mumda null
    readonly ema50Slope: number; // son 5 mumdaki rolatif degisim
    readonly trend: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  } | null;
  readonly volumeProfile: {
    readonly averageVolume: number;
    readonly currentVsAverage: number; // oran: guncel / ortalama
    readonly volumeTrend: 'increasing' | 'decreasing' | 'stable';
  } | null;
  readonly atr: number | null;
  readonly sma200: number | null;
  readonly stochastic: {
    readonly k: number;
    readonly d: number;
    readonly signal: 'overbought' | 'oversold' | 'neutral';
  } | null;
  readonly adx: {
    readonly adx: number;
    readonly plusDI: number;
    readonly minusDI: number;
    readonly trendStrength: 'no_trend' | 'weak' | 'strong' | 'very_strong';
  } | null;
  readonly fibonacci: {
    readonly swingHigh: number;
    readonly swingLow: number;
    readonly direction: 'up' | 'down';
    readonly levels: Readonly<Record<string, number>>;
    readonly currentPrice: number;
    readonly nearestLevel: string;
    readonly position: string;
  } | null;
  readonly candlestickPatterns: ReadonlyArray<{
    readonly name: string;
    readonly type: 'bullish' | 'bearish' | 'neutral';
    readonly strength: number;
    readonly candlesAgo: number; // 0 = son mum
  }>;
  /** 5 katmanli agirlikli kompozit. compositeScore -1..+1 araliginda tek sayidir. */
  readonly hierarchy: {
    readonly tier1_trend: TierScore;
    readonly tier2_momentum: TierScore;
    readonly tier3_structure: TierScore;
    readonly tier4_priceAction: TierScore;
    readonly tier5_volume: TierScore;
    readonly compositeScore: number;
    readonly overallBias: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  };
}

/** Stratejinin bilmesine izin verilen HER SEY. Derin dondurulmus; mutasyon calismaz. */
export interface StrategyContext {
  readonly symbol: string;
  readonly interval: '1h' | '4h' | '1d';

  /**
   * Karar zamani = candles[candles.length - 1].closeTime.
   * Saat/tarih fonksiyonu KULLANMA — Date sandbox'ta tanimsizdir. Zaman budur.
   */
  readonly now: number;

  /**
   * SADECE kapanmis mumlar, eskiden yeniye. Son eleman uzerinde karar verdigin bardir.
   * Ondan SONRASI YOKTUR — dizinin sonunu asmak undefined verir, gelecek vermez.
   */
  readonly candles: ReadonlyArray<StrategyCandle>;

  /** SON mumun indikatorleri (= history[history.length - 1]). */
  readonly indicators: StrategyIndicators;

  /**
   * candles ile 1:1 hizali indikator serisi: history[i] <-> candles[i].
   * Egim, sapma (divergence), rejim mantigi icin. Asla gelecek veri icermez.
   */
  readonly history: ReadonlyArray<StrategyIndicators>;

  /** `now` anindaki son settle olmus funding orani. 0.0005 = 8 saatte +%0.05. */
  readonly funding: number | null;
  readonly lsr: {
    readonly longShortRatio: number;
    readonly longAccount: number;
    readonly shortAccount: number;
  } | null;
  readonly macro: { readonly riskAppetite: 'risk_on' | 'risk_off' | 'mixed' | null } | null;

  /** Piyasa rejimi. Tek sembollu strateji bile piyasa baglami ister. */
  readonly market: {
    readonly btc: { readonly price: number; readonly sma200: number | null } | null;
  };

  /** meta.params'tan cozulmus degerler (default'lar veya grid'in taradigi bir hucre). */
  readonly params: Readonly<Record<string, number | boolean>>;
}

// ---------------------------------------------------------------- karar

/**
 * GIR.
 *
 * Boyut, kaldirac, TP, SL, sure — HICBIRI burada yok ve olmayacak. Onlar harness'in.
 * Senin isin tek sey: girilecek mi, girilecekse hangi yon.
 */
export interface StrategySignal {
  readonly side: 'LONG' | 'SHORT';
  /** 0..1, sonlu. Harness bunu pozisyon buyuklugune CEVIRIR; sen cevirmezsin. */
  readonly confidence: number;
  /** Sadece teshis icin, <= 200 karakter. */
  readonly reason?: string;
}

/**
 * GIRME — ama SENIN hangi kuralinin engelledigini soyle.
 *
 * Bu bos bir log degil: backtestAnalysis her veto kurali icin karsi-olgusal calistirir
 * ("bu filtre olmasaydi ne olurdu?") ve filtrenin sana kar mi kaybettirdigini yoksa
 * zarardan mi kurtardigini R cinsinden raporlar. Iyi bir veto kural adi, bir sonraki
 * gece stratejinin nasil gelisecegini belirler.
 */
export interface StrategyVeto {
  readonly veto: true;
  /** BUYUK_HARF_ALT_CIZGI, <= 32 karakter. Ornek: 'LOW_VOLUME', 'BELOW_THRESHOLD'. */
  readonly rule: string;
  readonly wouldBe?: 'LONG' | 'SHORT';
  readonly note?: string;
}

/** null = burada kayda deger bir sey yok (loglanmaya bile degmez). */
export type StrategyDecision = StrategySignal | StrategyVeto | null;

// ---------------------------------------------------------------- metadata

export interface StrategyParamSpec {
  readonly key: string;
  readonly type: 'number' | 'boolean';
  readonly default: number | boolean;
  /**
   * Grid'in TARAYACAGI degerler. Param basina <= 6 deger; tum paramlarin carpimi
   * <= meta.maxSweepCells. Taranmayacaksa bos birak.
   */
  readonly sweep?: ReadonlyArray<number | boolean>;
  readonly min?: number;
  readonly max?: number;
  readonly doc?: string;
}

export interface StrategyMeta {
  /** kebab-case, kalici kimlik. */
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly author: 'human' | 'codex';
  readonly provenance?: {
    readonly arxivId?: string;
    readonly arxivTitle?: string;
    readonly url?: string;
    /** Tek cumle: bu stratejinin NEDEN edge'i olmali? */
    readonly hypothesis?: string;
  };
  /**
   * evaluate() cagrilmadan once gereken minimum kapali mum sayisi. Harness zorlar:
   * candles.length her zaman >= warmupBars olur. <= 500.
   */
  readonly warmupBars: number;
  readonly needs: {
    readonly funding?: boolean;
    readonly macro?: boolean;
    readonly btcRegime?: boolean;
    readonly history?: boolean;
  };
  readonly params: ReadonlyArray<StrategyParamSpec>;
  /** Default 24. */
  readonly maxSweepCells?: number;
}

export interface Strategy {
  readonly meta: StrategyMeta;
  /** SAF. SENKRON. DETERMINISTIK. YAN ETKISIZ. */
  evaluate(ctx: StrategyContext): StrategyDecision;
}

/** Aday dosyasinin DEFAULT EXPORT'u bu olmalidir. */
export type StrategyFactory = () => Strategy;

// ---------------------------------------------------------------- tip korumalari

export function isSignal(d: StrategyDecision): d is StrategySignal {
  return d !== null && !('veto' in d);
}

export function isVeto(d: StrategyDecision): d is StrategyVeto {
  return d !== null && 'veto' in d;
}
