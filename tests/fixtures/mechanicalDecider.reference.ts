// ============================================================================
// DONDURULMUS REFERANS — samplebackend/engine/mechanicalDecider.ts'in BIREBIR kopyasi.
//
// Neden burada: tests/deciderParity.test.ts, mechanicalDecider'i mechanicalV0 + portfolio
// olarak IKIYE BOLMENIN davranisi koruduğunu kanitlar. O bolme, tum guvenlik modelinin
// temeli (kaldirac karar motorunun ICINDE kalsaydi Codex confidence uzerinden riske dolayli
// bir kol kazanirdi) — ve ancak DAVRANIS AYNI kalirsa gecerli.
//
// Referans repo disinda (samplebackend/, gitignore'lu) durursa, temiz bir clone'da test
// sessizce kaybolur. Bir altin testin en kotu kaderi budur: silinmesi degil, FARK EDILMEDEN
// kaybolmasi. Bu yuzden referans testin yaninda, dondurulmus halde durur.
//
// BU DOSYA DEGISTIRILMEZ. Yeni motorun davranisi buna gore olculur.
// ============================================================================

// Mekanik (AI'sız) karar motoru — AI prompt'undaki kuralların deterministik kodlaması.
//
// AI'ın karar dayanağı olan 5-tier hiyerarşi + composite skor zaten
// technicalIndicators.ts'te deterministik hesaplanıyor; prompt AI'a bu skoru
// "composite > ±0.3'e karşı işlem açma", strateji bazlı confidence eşikleri,
// funding/LSR crowding ve makro risk-off kurallarıyla okumasını söylüyordu.
// Bu modül aynı kuralları koda döker ve AI ile BİREBİR AYNI şekilde
// PortfolioAllocationResult üretir — böylece RECORD/REPLAY persist'i, grid
// sweep, walk-forward ve canlı executor'ın trade açma yolu hiç değişmeden çalışır.
import { AssetAllocation, PortfolioAllocationResult } from './xai.reference';
import { TechnicalIndicators } from '../../src/vendor/technicalIndicators';
// import type: modül çalışma zamanında firestore'a (dolayısıyla firebase init'e)
// bağımlı olmasın — motor saf mantıktır, script'lerden env'siz çağrılabilir.
import type { MechanicalConfig } from './mechanicalConfig.reference';
import { DEFAULT_RISK_PARAMS } from './riskManagement.reference';

export interface MechanicalDecisionInput {
  symbols: string[];
  // calculateAllIndicators çıktısı (hierarchy dahil) — veri yetersizse sembol atlanır
  indicators: Record<string, TechnicalIndicators>;
  // Karar anındaki son fiyat (backtest: son kapanan mumun close'u; canlı: ticker)
  prices: Record<string, number>;
  // Funding rate oran cinsinden (0.0005 = 8 saatte %0.05)
  funding?: Record<string, number>;
  lsr?: Record<string, { longShortRatio: number; longAccount: number; shortAccount: number }>;
  // Son kapanmış mumlar (en yenisi sonda) — giriş onay barı filtresi için.
  // Yalnız KAPANMIŞ mumlar verilmelidir; veri yoksa filtre o sembol için atlanır.
  lastCandles?: Record<string, Array<{ open: number; close: number }>>;
  macroRiskAppetite?: 'risk_on' | 'risk_off' | 'mixed' | null;
  strategy: 'conservative' | 'balanced' | 'aggressive';
  config?: MechanicalConfig;
}

interface StrategyProfile {
  entryThreshold: number;               // |composite| giriş eşiği
  minConfidence: number;                // getMinConfidence ile aynı (0.8/0.6/0.5)
  leverageByVol: [number, number, number]; // [düşük vol, orta vol, yüksek vol] — prompt guideline aralıkları
  baseAllocationPct: number;            // allocationPercent tabanı (× confidence)
  maxTotalAllocationPct: number;        // prompt'taki toplam tahsis tavanı (50/80/90)
}

// Eşikler AI prompt'undaki confidence şartlarının karşılığı: conservative
// "çok güçlü kanıt" (0.45), balanced "orta kanıt" (0.35), aggressive (0.25).
// entryThreshold config ile ezilebilir (eşik taraması ayrı backtest koşularıyla yapılır).
const STRATEGY_PROFILES: Record<MechanicalDecisionInput['strategy'], StrategyProfile> = {
  conservative: { entryThreshold: 0.45, minConfidence: 0.8, leverageByVol: [5, 3, 2],   baseAllocationPct: 20, maxTotalAllocationPct: 50 },
  balanced:     { entryThreshold: 0.35, minConfidence: 0.6, leverageByVol: [20, 10, 5], baseAllocationPct: 30, maxTotalAllocationPct: 80 },
  aggressive:   { entryThreshold: 0.25, minConfidence: 0.5, leverageByVol: [50, 25, 15], baseAllocationPct: 40, maxTotalAllocationPct: 90 },
};

// Crowding eşikleri backtest prompt'undakiyle birebir aynı (buildBacktestPrompt'taki
// "too many longs/shorts" ve "long-heavy/short-heavy" sınırları).
const FUNDING_CROWDED = 0.0005;  // 8 saatte ±%0.05
const LSR_LONG_HEAVY = 1.5;
const LSR_SHORT_HEAVY = 0.67;
const FUNDING_PENALTY = 0.10;    // kalabalık yönle aynı taraftaysak
const LSR_PENALTY = 0.05;
const MACRO_PENALTY = 0.05;      // risk-off ortamda
const BTC_REGIME_PENALTY = 0.05; // BTC↓ × mixed rejiminde LONG (en zararlı segment)

// Volatilite kademeleri: ATR'nin fiyata oranı (%). Düşük vol → aralığın üstü kaldıraç.
const VOL_LOW_PCT = 0.5;
const VOL_MID_PCT = 1.0;

// BTC rejim cezasının referans sembolü — rejim analizindeki BTC↑/BTC↓ etiketi
// bu sembolün fiyat/SMA200 konumundan türetilir.
const BTC_SYMBOL = 'BTCUSDT';

// Mekanik motorda kaldıraç tavanı — leverageByVol ne derse desin bunu aşamaz.
const MAX_LEVERAGE = 10;

const DEFAULT_COOLDOWN_CANDLES = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round5 = (v: number) => Math.round(v / 5) * 5;
const fmtSigned = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

/** SL/BE sonrası yeniden giriş yasağının mum sayısı (simulateRun + executor kullanır). */
export function resolveCooldownCandles(cfg?: MechanicalConfig): number {
  const n = cfg?.cooldownCandles;
  return typeof n === 'number' && n >= 0 ? Math.floor(n) : DEFAULT_COOLDOWN_CANDLES;
}

/** Giriş onay barı sayısı — 0 = filtre kapalı (default). */
export function resolveConfirmationCandles(cfg?: MechanicalConfig): number {
  const n = cfg?.confirmationCandles;
  return typeof n === 'number' && n >= 1 ? Math.floor(n) : 0;
}

interface Candidate {
  symbol: string;
  signal: 'LONG' | 'SHORT';
  composite: number;
  confidence: number;
  leverage: number;
  takeProfit: number;
  stopLoss: number;
  reasoning: string;
}

// Hangi kuralın sinyali elediğinin kaydı — "her filtrenin kurtardığı zarar /
// kaçırdığı kâr" analizinin ham verisi. BELOW_THRESHOLD yalnız near-miss
// bandında kaydedilir (her mumda her sembolü kaydetmek karar doc'larını şişirir).
export type MechanicalRejectionRule =
  | 'NO_ATR'            // ATR hesaplanamadı — sizing imkânsız
  | 'BELOW_THRESHOLD'   // |composite| eşiğin hemen altında (near-miss bandı)
  | 'BTC_REGIME'        // (legacy) eski mutlak veto kayıtları — artık soft ceza, yeni redler CONFIDENCE_GATE + 'BTC_REGIME' penalty koduyla gelir
  | 'NO_CONFIRMATION'   // eşiği geçti ama sinyal mumu (son N mum) sinyal yönünde kapanmadı
  | 'LOW_VOLUME'        // son mum hacmi yapılandırılmış minimum ortalama oranını geçmedi
  | 'DI_MISMATCH'       // ADX directional index sinyal yönünü onaylamadı
  | 'CONFIDENCE_GATE'   // eşiği geçti ama cezalar minConfidence altına düşürdü
  | 'ALLOCATION_CAP';   // aday geçerliydi, toplam tahsis tavanına takıldı

export interface MechanicalRejection {
  symbol: string;
  rule: MechanicalRejectionRule;
  signal?: 'LONG' | 'SHORT';   // yön belirliyse (eşik near-miss'te composite işareti)
  composite?: number;
  confidence?: number;          // ceza SONRASI değer (CONFIDENCE_GATE)
  penalties?: string[];         // uygulanan cezalar: FUNDING / LSR / MACRO / BTC_REGIME
}

// Eşik near-miss bandı: |composite| ∈ [threshold − BAND, threshold) reddedilenler
// kaydedilir → "eşiği gevşetsem ne olurdu" sorusunun hipotetik verisi.
export const NEAR_MISS_BAND = 0.10;

export interface MechanicalDecisionDetailed {
  result: PortfolioAllocationResult;
  rejections: MechanicalRejection[];
}

/**
 * Tek sembol için aday sinyal üretir. Eşik altı / veri yetersiz / cezalar sonrası
 * minConfidence altına düşen semboller candidate=null döner (HOLD); eleyen kural
 * analiz için rejection olarak raporlanır (kayda değmeyen durumlarda o da null).
 */
/**
 * BTC↓ × mixed × LONG cezası aktif mi? Rejim analizi bu segmenti açık ara en
 * zararlı kombinasyon olarak gösterdi: BTC SMA200 altındayken makro iştah
 * 'mixed' ise LONG sinyalleri confidence cezası yer (eski davranış mutlak
 * vetoydu). Tanım, backtestAnalysis'teki rejim etiketiyle (btcTrendAt: son
 * kapanış < SMA200 → BTC↓) birebir aynıdır. BTC verisi yoksa / SMA200
 * hesaplanamıyorsa (<200 mum) rejim bilinemez → ceza yok.
 */
function isBtcDownMixedRegime(input: MechanicalDecisionInput): boolean {
  if (input.config?.btcRegimeFilter === false) return false;
  if (input.macroRiskAppetite !== 'mixed') return false;
  const sma200 = input.indicators[BTC_SYMBOL]?.sma200;
  const btcPrice = input.prices[BTC_SYMBOL];
  if (typeof sma200 !== 'number' || !btcPrice || btcPrice <= 0) return false;
  return btcPrice < sma200;
}

function evaluateSymbol(
  symbol: string,
  input: MechanicalDecisionInput,
  profile: StrategyProfile,
  threshold: number,
  btcLongPenalty: boolean
): { candidate: Candidate | null; rejection: MechanicalRejection | null } {
  const ti = input.indicators[symbol];
  const price = input.prices[symbol];
  if (!ti || !price || price <= 0) return { candidate: null, rejection: null };
  if (!ti.atr || ti.atr <= 0) {
    // ATR yoksa sizing de yapılamaz — sinyal üretme
    return { candidate: null, rejection: { symbol, rule: 'NO_ATR' } };
  }

  const composite = ti.hierarchy.compositeScore;
  if (Math.abs(composite) < threshold) {
    const nearMiss = Math.abs(composite) >= threshold - NEAR_MISS_BAND;
    return {
      candidate: null,
      rejection: nearMiss
        ? {
            symbol,
            rule: 'BELOW_THRESHOLD',
            signal: composite > 0 ? 'LONG' : 'SHORT',
            composite: parseFloat(composite.toFixed(3)),
          }
        : null,
    };
  }
  const signal: 'LONG' | 'SHORT' = composite > 0 ? 'LONG' : 'SHORT';

  // Aralık 2025 otopsisi: ortalama-altı hacimli girişler ay boyunca zararın çok
  // büyük bölümünü taşıdı. Eşik opt-in'dir; veri yoksa canlı/backtest ayrışmasın
  // diye filtre fail-open çalışır.
  const minVolumeRatio = input.config?.minVolumeRatio;
  const currentVolumeRatio = ti.volumeProfile?.currentVsAverage;
  if (
    typeof minVolumeRatio === 'number' && minVolumeRatio > 0 &&
    typeof currentVolumeRatio === 'number' && currentVolumeRatio < minVolumeRatio
  ) {
    return {
      candidate: null,
      rejection: {
        symbol,
        rule: 'LOW_VOLUME',
        signal,
        composite: parseFloat(composite.toFixed(3)),
      },
    };
  }

  // Hacim tek başına katılımı, DI ise hareketin yönünü doğrular. ADX değeri düşük
  // olsa bile yön bilgisi kullanılabilir; veri yoksa yine fail-open.
  if (input.config?.requireDirectionalDi === true && ti.adx) {
    const directionConfirmed = signal === 'LONG'
      ? ti.adx.plusDI > ti.adx.minusDI
      : ti.adx.minusDI > ti.adx.plusDI;
    if (!directionConfirmed) {
      return {
        candidate: null,
        rejection: {
          symbol,
          rule: 'DI_MISMATCH',
          signal,
          composite: parseFloat(composite.toFixed(3)),
        },
      };
    }
  }

  // Giriş onay barı: son N kapanmış mumun tümü sinyal yönünde kapanmalı. Kararlar
  // her mum kapanışında yenilendiğinden bu, "sinyali gör, onay barını bekle, onayda
  // gir" akışının durumsuz eşdeğeri — eşik kırmızı mumda kırılırsa giriş ilk yönlü
  // kapanışa ertelenir (MAE/MFE teşhisi: giriş hastalığı). Doji onay sayılmaz;
  // mum verisi eksikse filtre atlanır (BTC rejim filtresiyle aynı fail-open disiplini).
  const confirmN = resolveConfirmationCandles(input.config);
  if (confirmN >= 1) {
    const candles = input.lastCandles?.[symbol];
    if (candles && candles.length >= confirmN) {
      const recent = candles.slice(-confirmN);
      const confirmed = recent.every((c) =>
        signal === 'LONG' ? c.close > c.open : c.close < c.open
      );
      if (!confirmed) {
        return {
          candidate: null,
          rejection: {
            symbol,
            rule: 'NO_CONFIRMATION',
            signal,
            composite: parseFloat(composite.toFixed(3)),
          },
        };
      }
    }
  }

  // Confidence: minConfidence kapılarından (getMinConfidence / executor eşiği)
  // eşikte tam geçecek, eşik üstünde |composite| ile monoton artan harita.
  let confidence = clamp(
    profile.minConfidence + (Math.abs(composite) - threshold) * 1.5,
    profile.minConfidence,
    0.95
  );

  const penaltyNotes: string[] = [];
  const penaltyCodes: string[] = [];

  // BTC↓ × mixed rejiminde LONG soft cezalıdır (eskiden mutlak veto): rejim
  // analizindeki en zararlı segment, ama tümden bloklamak yerine confidence
  // düşürülür — yalnız eşiği rahat aşan güçlü sinyaller hayatta kalır.
  if (btcLongPenalty && signal === 'LONG') {
    confidence -= BTC_REGIME_PENALTY;
    penaltyNotes.push(`BTC↓ × mixed rejiminde LONG → -${BTC_REGIME_PENALTY}`);
    penaltyCodes.push('BTC_REGIME');
  }

  // Funding crowding: kalabalık yönle AYNI taraftaysak ceza (prompt: "high funding
  // rate = potential reversal"). LONG iken funding çok pozitifse longlar kalabalık.
  const fr = input.funding?.[symbol];
  if (fr !== undefined) {
    const crowdedWithUs =
      (signal === 'LONG' && fr > FUNDING_CROWDED) ||
      (signal === 'SHORT' && fr < -FUNDING_CROWDED);
    if (crowdedWithUs) {
      confidence -= FUNDING_PENALTY;
      penaltyNotes.push(`funding ${(fr * 100).toFixed(4)}% kalabalık yönle aynı → -${FUNDING_PENALTY}`);
      penaltyCodes.push('FUNDING');
    }
  }

  // L/S ratio crowding: aşırı long-heavy iken LONG (veya tersi) kalabalık işlemdir.
  const lsr = input.lsr?.[symbol];
  if (lsr) {
    const crowdedWithUs =
      (signal === 'LONG' && lsr.longShortRatio > LSR_LONG_HEAVY) ||
      (signal === 'SHORT' && lsr.longShortRatio < LSR_SHORT_HEAVY);
    if (crowdedWithUs) {
      confidence -= LSR_PENALTY;
      penaltyNotes.push(`L/S ${lsr.longShortRatio.toFixed(2)} kalabalık yönle aynı → -${LSR_PENALTY}`);
      penaltyCodes.push('LSR');
    }
  }

  // Makro risk-off: confidence cezası + bir volatilite kademesi düşük kaldıraç.
  const riskOff = input.macroRiskAppetite === 'risk_off';
  if (riskOff) {
    confidence -= MACRO_PENALTY;
    penaltyNotes.push(`makro risk-off → -${MACRO_PENALTY}`);
    penaltyCodes.push('MACRO');
  }

  // Cezalar sonrası eşik kapısının altına düştüyse sinyal HOLD'a döner.
  if (confidence < profile.minConfidence) {
    return {
      candidate: null,
      rejection: {
        symbol,
        rule: 'CONFIDENCE_GATE',
        signal,
        composite: parseFloat(composite.toFixed(3)),
        confidence: parseFloat(confidence.toFixed(2)),
        penalties: penaltyCodes,
      },
    };
  }
  confidence = parseFloat(confidence.toFixed(2));

  // Kaldıraç: volatilite kademesi (ATR/fiyat) × strateji aralığı. Risk-off bir kademe düşürür.
  const atrPct = (ti.atr / price) * 100;
  let volIdx = atrPct < VOL_LOW_PCT ? 0 : atrPct <= VOL_MID_PCT ? 1 : 2;
  if (riskOff) volIdx = Math.min(2, volIdx + 1);
  const leverage = Math.min(MAX_LEVERAGE, profile.leverageByVol[volIdx]);

  // TP/SL alanları şema uyumu için ATR'den doldurulur; ATR modunda sizing zaten
  // riskManagement'tan (grid hücresinin kendi RR/SL çarpanlarıyla) yeniden hesaplanır.
  const stopLoss = clamp(parseFloat(((ti.atr * DEFAULT_RISK_PARAMS.slMultiplier / price) * 100).toFixed(2)), 0.5, 25);
  const takeProfit = clamp(parseFloat((stopLoss * DEFAULT_RISK_PARAMS.rewardRatio).toFixed(2)), 0.5, 50);

  const h = ti.hierarchy;
  const tierPart = [
    `T1 ${fmtSigned(h.tier1_trend.bias)}·${h.tier1_trend.strength.toFixed(2)}`,
    `T2 ${fmtSigned(h.tier2_momentum.bias)}·${h.tier2_momentum.strength.toFixed(2)}`,
    `T3 ${fmtSigned(h.tier3_structure.bias)}·${h.tier3_structure.strength.toFixed(2)}`,
    `T4 ${fmtSigned(h.tier4_priceAction.bias)}·${h.tier4_priceAction.strength.toFixed(2)}`,
    `T5 ${fmtSigned(h.tier5_volume.bias)}·${h.tier5_volume.strength.toFixed(2)}`,
  ].join(' | ');
  const reasoning =
    `Mekanik: composite ${fmtSigned(composite)} (eşik ${threshold}) → ${signal}. ${tierPart}. ` +
    `${penaltyNotes.length ? `Cezalar: ${penaltyNotes.join('; ')}. ` : ''}` +
    `ATR ${atrPct.toFixed(2)}% → ${leverage}x`;

  return {
    candidate: { symbol, signal, composite, confidence, leverage, takeProfit, stopLoss, reasoning },
    rejection: null,
  };
}

/**
 * AI'ın analyzePortfolioAllocation çıktısıyla birebir aynı şekilde deterministik
 * portföy kararı üretir. Adaylar |composite|'e göre sıralanır; allocationPercent
 * strateji tavanını aşmayacak şekilde 5'in katları olarak dağıtılır (ATR modunda
 * sizing'de kullanılmaz ama şema/fixed-mod uyumu için doldurulur).
 *
 * Detaylı varyant ayrıca hangi sembolün hangi kural tarafından elendiğini döner
 * (filtre bilançosu analizi için); decidePortfolio davranışı birebir aynıdır.
 */
export function decidePortfolioDetailed(input: MechanicalDecisionInput): MechanicalDecisionDetailed {
  const profile = STRATEGY_PROFILES[input.strategy] ?? STRATEGY_PROFILES.balanced;
  const threshold =
    typeof input.config?.entryThreshold === 'number' && input.config.entryThreshold > 0
      ? input.config.entryThreshold
      : profile.entryThreshold;

  const btcLongPenalty = isBtcDownMixedRegime(input);

  const candidates: Candidate[] = [];
  const rejections: MechanicalRejection[] = [];
  for (const symbol of input.symbols) {
    const { candidate, rejection } = evaluateSymbol(symbol, input, profile, threshold, btcLongPenalty);
    if (candidate) candidates.push(candidate);
    if (rejection) rejections.push(rejection);
  }
  candidates.sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite));

  const allocations: AssetAllocation[] = [];
  const allocatedSymbols = new Set<string>();
  let remaining = profile.maxTotalAllocationPct;
  for (const c of candidates) {
    if (remaining < 5) break; // tavan doldu — kalan adaylar HOLD
    let pct = Math.max(5, round5(profile.baseAllocationPct * c.confidence));
    pct = Math.min(pct, Math.floor(remaining / 5) * 5);
    if (pct < 5) break;
    remaining -= pct;
    allocatedSymbols.add(c.symbol);
    allocations.push({
      symbol: c.symbol,
      signal: c.signal,
      allocationPercent: pct,
      confidence: c.confidence,
      leverage: c.leverage,
      takeProfit: c.takeProfit,
      stopLoss: c.stopLoss,
      reasoning: c.reasoning,
    });
  }

  // Tavana takılan geçerli adaylar (analiz: cap gevşetilse ne kaçtı/kurtuldu).
  for (const c of candidates) {
    if (allocatedSymbols.has(c.symbol)) continue;
    rejections.push({
      symbol: c.symbol,
      rule: 'ALLOCATION_CAP',
      signal: c.signal,
      composite: parseFloat(c.composite.toFixed(3)),
      confidence: c.confidence,
    });
  }

  const totalAllocation = allocations.reduce((s, a) => s + a.allocationPercent, 0);
  const bullish = candidates.filter((c) => c.signal === 'LONG').length;
  const bearish = candidates.filter((c) => c.signal === 'SHORT').length;
  const appetite = input.macroRiskAppetite ?? 'bilinmiyor';

  const result: PortfolioAllocationResult = {
    totalAllocationPercent: Math.min(100, totalAllocation),
    reservePercent: Math.max(0, 100 - totalAllocation),
    allocations,
    marketOutlook: (allocations.length
      ? `Mekanik tarama: ${bullish} LONG / ${bearish} SHORT adayı (eşik ${threshold}); makro risk iştahı ${appetite}`
      : `Mekanik tarama: eşiği (${threshold}) geçen sembol yok; makro risk iştahı ${appetite}`) +
      (btcLongPenalty ? '; BTC↓ × mixed rejimi → LONG cezalı' : ''),
    riskAssessment: `Deterministik ${input.strategy} profili — toplam tahsis %${Math.min(100, totalAllocation)}, tavan %${profile.maxTotalAllocationPct}`,
  };
  return { result, rejections };
}

export function decidePortfolio(input: MechanicalDecisionInput): PortfolioAllocationResult {
  return decidePortfolioDetailed(input).result;
}

export const mechanicalDecider = {
  decidePortfolio,
  decidePortfolioDetailed,
  resolveCooldownCandles,
  resolveConfirmationCandles,
};
