// Default risk parameters — agresif preset
// SL ve callback ayrı işler görür: SL "tezim yanlış mı" (giriş stop mesafesi),
// callback "trend bitti mi" (trailing takip mesafesi). Tavsiye edilen arama
// bölgesi SL 2–2.5 ATR / callback 1.5–2 ATR — hardcode edilmez, sweep +
// walk-forward ile aranır. Default'lar davranış-koruyucu (eski 0.8 ile aynı).
export const DEFAULT_RISK_PARAMS = {
  riskPerTradePct: 0.05,        // her trade için bakiyenin %5'i risk
  maxPortfolioRiskPct: 0.15,    // tüm açık pozisyonların toplam risk tavanı %15 (max ~3 pozisyon)
  atrMultiplier: 0.8,           // legacy alias — eski config'ler için (= slMultiplier)
  slMultiplier: 0.8,            // giriş stop mesafesi = ATR × 0.8 (sıkı stop — simülasyon optimumu)
  callbackMultiplier: 0.8,      // trailing takip mesafesi = ATR × 0.8
  rewardRatio: 6.5,             // trailing aktivasyonu = SL × 6.5 (kârı uzun koştur)
  breakevenAtR: 1 as number | false, // fiyat +1R'a gelince stop breakeven'a çekilir (false = kapalı)
  breakevenBufferPct: 0.1,      // breakeven = entry ± %0.1 (gidiş-dönüş komisyonunu kabaca karşılar)
};

export interface RiskParams {
  riskPerTradePct: number;
  maxPortfolioRiskPct: number;
  atrMultiplier: number;        // legacy alias — her zaman slMultiplier ile aynı tutulur
  slMultiplier: number;
  callbackMultiplier: number;
  rewardRatio: number;
  breakevenAtR: number | false;
  breakevenBufferPct: number;
}

/**
 * Config'ten (eski veya yeni şema) tam RiskParams çözer.
 * Fallback zinciri: slMultiplier ?? atrMultiplier ?? default;
 * callbackMultiplier ?? slMultiplier (eski davranış: callback = SL).
 */
export function resolveRiskParams(cfg?: {
  riskPerTradePct?: number;
  maxPortfolioRiskPct?: number;
  atrMultiplier?: number;
  slMultiplier?: number;
  callbackMultiplier?: number;
  rewardRatio?: number;
  breakevenAtR?: number | false;
  breakevenBufferPct?: number;
}): RiskParams {
  const slMultiplier = cfg?.slMultiplier ?? cfg?.atrMultiplier ?? DEFAULT_RISK_PARAMS.slMultiplier;
  const callbackMultiplier = cfg?.callbackMultiplier ?? slMultiplier;
  return {
    riskPerTradePct: cfg?.riskPerTradePct ?? DEFAULT_RISK_PARAMS.riskPerTradePct,
    maxPortfolioRiskPct: cfg?.maxPortfolioRiskPct ?? DEFAULT_RISK_PARAMS.maxPortfolioRiskPct,
    atrMultiplier: slMultiplier,
    slMultiplier,
    callbackMultiplier,
    rewardRatio: cfg?.rewardRatio ?? DEFAULT_RISK_PARAMS.rewardRatio,
    breakevenAtR: cfg?.breakevenAtR ?? DEFAULT_RISK_PARAMS.breakevenAtR,
    breakevenBufferPct: cfg?.breakevenBufferPct ?? DEFAULT_RISK_PARAMS.breakevenBufferPct,
  };
}

export interface PositionSizingInput {
  balance: number;          // total balance USDT
  entryPrice: number;
  atr: number;
  leverage: number;
  riskPerTradePct?: number;
  atrMultiplier?: number;       // legacy — slMultiplier verilmezse SL için kullanılır
  slMultiplier?: number;        // giriş stop mesafesi çarpanı
  callbackMultiplier?: number;  // trailing takip mesafesi çarpanı
  rewardRatio?: number;
}

export interface PositionSizingOutput {
  margin: number;           // USD margin (executor.ts'in `margin` değişkeniyle aynı)
  notional: number;         // margin × leverage (executor.ts'in `quantity` değişkeniyle aynı)
  quantityBase: number;     // base asset miktarı (ör: 0.4 BTC)
  stopDistancePrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  stopLossPct: number;      // pct (1.67 = %1.67) — fiyat hareketi cinsinden, leverage'sız
  takeProfitPct: number;    // pct
  callbackRatePct: number;  // trailing takip mesafesi pct — clamp'siz; 0.1–5 clamp'i çağrı yerinde
  riskUSD: number;          // beklenen dolar kaybı (stop yenirse)
}

/**
 * ATR-bazlı pozisyon büyüklüğü hesabı.
 * - riskUSD = balance × riskPerTradePct (sabit dolar riski)
 * - stopDistance = ATR × atrMultiplier (volatiliteye göre)
 * - quantityBase = riskUSD / stopDistance (base asset miktarı)
 * - margin = (quantityBase × entryPrice) / leverage
 *
 * Bu formül leverage'tan bağımsız çalışır: aynı dolar riski için
 * yüksek leverage daha az margin tüketir, ama notional aynı kalır.
 */
export function calculatePositionSize(input: PositionSizingInput): PositionSizingOutput {
  const riskPerTradePct = input.riskPerTradePct ?? DEFAULT_RISK_PARAMS.riskPerTradePct;
  const slMultiplier = input.slMultiplier ?? input.atrMultiplier ?? DEFAULT_RISK_PARAMS.slMultiplier;
  const callbackMultiplier = input.callbackMultiplier ?? slMultiplier;
  const rewardRatio = input.rewardRatio ?? DEFAULT_RISK_PARAMS.rewardRatio;

  const riskUSD = input.balance * riskPerTradePct;
  const stopDistancePrice = input.atr * slMultiplier;
  const quantityBase = riskUSD / stopDistancePrice;
  const notional = quantityBase * input.entryPrice;
  const margin = notional / Math.max(1, input.leverage);

  const stopLossPct = (stopDistancePrice / input.entryPrice) * 100;
  const takeProfitPct = stopLossPct * rewardRatio;
  const callbackRatePct = (input.atr * callbackMultiplier / input.entryPrice) * 100;

  // SL/TP yön bağımsız değerlendirilir; çağıran fonksiyon LONG/SHORT'a göre
  // entry'den ekleyip/çıkarır. Aşağıdaki yardımcı LONG varsayar.
  const stopLossPrice = input.entryPrice - stopDistancePrice;
  const takeProfitPrice = input.entryPrice + stopDistancePrice * rewardRatio;

  return {
    margin,
    notional,
    quantityBase,
    stopDistancePrice,
    stopLossPrice,
    takeProfitPrice,
    stopLossPct,
    takeProfitPct,
    callbackRatePct,
    riskUSD,
  };
}

export interface OpenPositionRisk {
  symbol: string;
  side: 'LONG' | 'SHORT';
  riskUSD: number;          // stop yenirse beklenen dolar kayıp
}

export interface PortfolioCapCheck {
  allowed: boolean;
  currentRiskUSD: number;
  newTotalRiskUSD: number;
  capUSD: number;
  reason?: string;
}

/**
 * Portföy toplam açık risk tavanı kontrolü.
 * currentOpenRiskUSD: zaten açık pozisyonların toplam stop kaybı
 * newTradeRiskUSD: açılmak istenen yeni pozisyonun risk'i
 */
export function checkPortfolioRiskCap(args: {
  balance: number;
  currentOpenRiskUSD: number;
  newTradeRiskUSD: number;
  maxPortfolioRiskPct?: number;
}): PortfolioCapCheck {
  const maxPct = args.maxPortfolioRiskPct ?? DEFAULT_RISK_PARAMS.maxPortfolioRiskPct;
  const capUSD = args.balance * maxPct;
  const newTotal = args.currentOpenRiskUSD + args.newTradeRiskUSD;

  if (newTotal > capUSD) {
    return {
      allowed: false,
      currentRiskUSD: args.currentOpenRiskUSD,
      newTotalRiskUSD: newTotal,
      capUSD,
      reason: `Yeni risk toplamı $${newTotal.toFixed(2)}, tavan $${capUSD.toFixed(2)} (bakiye × ${(maxPct * 100).toFixed(0)}%)`,
    };
  }

  return {
    allowed: true,
    currentRiskUSD: args.currentOpenRiskUSD,
    newTotalRiskUSD: newTotal,
    capUSD,
  };
}

/**
 * Verilen açık pozisyon listesinden her birinin risk'ini hesapla.
 * Pozisyon kaynakları:
 * - Canlı: binanceService.getPositions() — entry, side, mark, unrealized
 * - Backtest: openPositions[] — entryPrice, stopLossPrice, quantity, leverage
 * Bu helper kaynak agnostiktir; çağıran taraf riskUSD'yi sağlar.
 */
export function sumOpenRisk(positions: OpenPositionRisk[]): number {
  return positions.reduce((sum, p) => sum + p.riskUSD, 0);
}
