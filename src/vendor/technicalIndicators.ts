// @ts-nocheck — VENDORED: samplebackend/services/technicalIndicators.ts'ten BIREBIR alindi.
//
// Bu dosyanin ici bilerek DEGISTIRILMEZ: urettigi sayilar (5-tier composite, ATR, ADX...)
// tum sistemin girdisidir ve altin regresyon testi tam olarak bu sayilarin sample ile
// ayni kaldigini dogrular. Icini "duzeltmek" sayisal regresyon riski demektir.
//
// @ts-nocheck yalnizca DOSYA ICINI muaf tutar (yuzlerce `arr[i]` erisimi
// noUncheckedIndexedAccess altinda gurultu uretiyor). Disa verdigi tipler
// (TechnicalIndicators, TierScore, calculateAllIndicators imzasi) tam kontrol edilmeye
// devam eder — yani bizim kodumuzun bu modulle olan sozlesmesi korunur.
import type { Kline } from '../lib/klineStore';

// ==================== INTERFACES ====================

export interface TechnicalIndicators {
  rsi: number | null;           // 0-100
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  } | null;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number;          // (upper - lower) / middle * 100
    percentB: number;           // (price - lower) / (upper - lower)
  } | null;
  ema: {
    ema20: number;
    ema50: number;
    ema200: number | null;  // null when <200 candles available — prevents fake "strong" trend
    ema50Slope: number;     // (ema50[t] - ema50[t-5]) / ema50[t-5] — son 5 mumdaki rölatif değişim
    trend: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  } | null;
  volumeProfile: {
    averageVolume: number;
    currentVsAverage: number;   // ratio: current / average
    volumeTrend: 'increasing' | 'decreasing' | 'stable';
  } | null;
  atr: number | null;           // Average True Range (volatility)
  // Son 200 kapanışın basit ortalaması — rejim analizindeki BTC↑/BTC↓ etiketiyle
  // (backtestAnalysis.btcTrendAt) aynı tanım. <200 mumda null (rejim bilinmiyor).
  sma200: number | null;

  // ---- NEW: Momentum extensions ----
  stochastic: {
    k: number;                  // 0-100
    d: number;                  // 0-100 (SMA of K)
    signal: 'overbought' | 'oversold' | 'neutral';
  } | null;
  adx: {
    adx: number;                // 0-100
    plusDI: number;
    minusDI: number;
    trendStrength: 'no_trend' | 'weak' | 'strong' | 'very_strong';
  } | null;

  // ---- NEW: Structure ----
  fibonacci: {
    swingHigh: number;
    swingLow: number;
    direction: 'up' | 'down';        // swing direction (low→high or high→low)
    levels: Record<string, number>;  // '0','236','382','500','618','786','1000'
    currentPrice: number;
    nearestLevel: string;            // e.g. '500'
    position: 'below_0' | 'between_0_236' | 'between_236_382' | 'between_382_500'
            | 'between_500_618' | 'between_618_786' | 'between_786_1000' | 'above_1000';
  } | null;

  // ---- NEW: Price action ----
  candlestickPatterns: Array<{
    name: string;
    type: 'bullish' | 'bearish' | 'neutral';
    strength: number;          // 0-1, pattern reliability/clarity
    candlesAgo: number;        // 0 = last candle
  }>;

  // ---- NEW: Hierarchy ----
  hierarchy: {
    tier1_trend:       TierScore;
    tier2_momentum:    TierScore;
    tier3_structure:   TierScore;
    tier4_priceAction: TierScore;
    tier5_volume:      TierScore;
    compositeScore: number;    // -1.0 .. +1.0
    overallBias: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  };

  summary: string;
}

export interface TierScore {
  bias: number;        // -1.0 .. +1.0
  strength: number;    // 0 .. 1
  signals: string[];   // human-readable signal lines
}

const TIER_WEIGHTS = {
  tier1_trend:       0.30,
  tier2_momentum:    0.25,
  tier3_structure:   0.20,
  tier4_priceAction: 0.15,
  tier5_volume:      0.10,
} as const;

// ==================== CALCULATION FUNCTIONS ====================

/**
 * EMA (Exponential Moving Average) hesapla
 */
function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];

  const multiplier = 2 / (period + 1);
  const ema: number[] = [];

  // İlk EMA değeri = SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  ema.push(sum / period);

  // Geri kalan EMA değerleri
  for (let i = period; i < closes.length; i++) {
    ema.push((closes[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
  }

  return ema;
}

/**
 * SMA (Simple Moving Average) hesapla
 */
function calculateSMA(data: number[], period: number): number[] {
  if (data.length < period) return [];

  const sma: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    sma.push(sum / period);
  }
  return sma;
}

/**
 * RSI (Relative Strength Index) hesapla - period: 14
 */
function calculateRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // İlk average gain/loss (SMA)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * MACD hesapla (12, 26, 9)
 */
function calculateMACD(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null; // 26 + 9 minimum

  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  // MACD line = EMA12 - EMA26
  // EMA12 starts at index 0 (period 12), EMA26 starts at index 0 (period 26)
  // Align: EMA12[i + (26-12)] corresponds to EMA26[i]
  const offset = 26 - 12; // 14
  const macdLine: number[] = [];
  for (let i = 0; i < ema26.length; i++) {
    macdLine.push(ema12[i + offset] - ema26[i]);
  }

  if (macdLine.length < 9) return null;

  // Signal line = EMA of MACD (period 9)
  const signalLine = calculateEMA(macdLine, 9);

  if (signalLine.length === 0) return null;

  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];

  return {
    macd: parseFloat(lastMACD.toFixed(4)),
    signal: parseFloat(lastSignal.toFixed(4)),
    histogram: parseFloat((lastMACD - lastSignal).toFixed(4)),
  };
}

/**
 * Bollinger Bands hesapla (period: 20, stdDev: 2)
 */
function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number; middle: number; lower: number; bandwidth: number; percentB: number } | null {
  if (closes.length < period) return null;

  // Son period kadar veri al
  const recentCloses = closes.slice(-period);
  const middle = recentCloses.reduce((s, v) => s + v, 0) / period;

  // Standard deviation
  const variance = recentCloses.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  const currentPrice = closes[closes.length - 1];

  return {
    upper: parseFloat(upper.toFixed(2)),
    middle: parseFloat(middle.toFixed(2)),
    lower: parseFloat(lower.toFixed(2)),
    bandwidth: parseFloat(((upper - lower) / middle * 100).toFixed(2)),
    percentB: parseFloat(((currentPrice - lower) / (upper - lower)).toFixed(4)),
  };
}

/**
 * ATR (Average True Range) hesapla - volatilite ölçüsü
 */
function calculateATR(candles: Kline[], period: number = 14): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // İlk ATR = SMA of TR
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return parseFloat(atr.toFixed(4));
}

/**
 * Volume Profile hesapla
 */
function calculateVolumeProfile(candles: Kline[]): {
  averageVolume: number;
  currentVsAverage: number;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
} | null {
  if (candles.length < 5) return null;

  const volumes = candles.map(k => k.volume);
  const averageVolume = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const currentVolume = volumes[volumes.length - 1];

  // Son 5 mum volume ortalaması vs önceki ortalama
  const recentAvg = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const olderAvg = volumes.slice(0, -5).reduce((s, v) => s + v, 0) / Math.max(1, volumes.length - 5);

  let volumeTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (recentAvg > olderAvg * 1.2) volumeTrend = 'increasing';
  else if (recentAvg < olderAvg * 0.8) volumeTrend = 'decreasing';

  return {
    averageVolume,
    currentVsAverage: parseFloat((currentVolume / averageVolume).toFixed(2)),
    volumeTrend,
  };
}

/**
 * EMA trend analizi.
 *
 * EMA200 olmadan trend yönü kararı verilmez — fiyat EMA200 altında olsa bile
 * sadece EMA20/EMA50'ye bakarak "bullish" diyen eski fallback bug'ıydı.
 * Yetersiz geçmiş = neutral.
 */
function analyzeEMATrend(
  currentPrice: number,
  ema20: number,
  ema50: number,
  ema200: number | null
): 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish' {
  if (ema200 === null) return 'neutral';
  if (currentPrice > ema20 && ema20 > ema50 && ema50 > ema200) return 'strong_bullish';
  if (currentPrice < ema20 && ema20 < ema50 && ema50 < ema200) return 'strong_bearish';
  if (currentPrice > ema50 && ema20 > ema50 && currentPrice > ema200) return 'bullish';
  if (currentPrice < ema50 && ema20 < ema50 && currentPrice < ema200) return 'bearish';
  return 'neutral';
}

// ==================== NEW: STOCHASTIC ====================

/**
 * Stochastic Oscillator (%K, %D) — kPeriod: 14, dPeriod: 3 (SMA of K)
 */
function calculateStochastic(
  candles: Kline[],
  kPeriod: number = 14,
  dPeriod: number = 3
): { k: number; d: number; signal: 'overbought' | 'oversold' | 'neutral' } | null {
  if (candles.length < kPeriod + dPeriod) return null;

  // Compute %K for last (dPeriod) values so we can SMA them into %D
  const kValues: number[] = [];
  for (let i = candles.length - dPeriod; i < candles.length; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...window.map(c => c.high));
    const lowestLow = Math.min(...window.map(c => c.low));
    const close = candles[i].close;
    const range = highestHigh - lowestLow;
    const k = range === 0 ? 50 : ((close - lowestLow) / range) * 100;
    kValues.push(k);
  }

  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((s, v) => s + v, 0) / kValues.length;

  let signal: 'overbought' | 'oversold' | 'neutral' = 'neutral';
  if (k > 80 && d > 80) signal = 'overbought';
  else if (k < 20 && d < 20) signal = 'oversold';

  return {
    k: parseFloat(k.toFixed(2)),
    d: parseFloat(d.toFixed(2)),
    signal,
  };
}

// ==================== NEW: ADX ====================

/**
 * ADX (Average Directional Index) — Wilder period 14
 * Returns ADX (trend strength), +DI, -DI (directional movements).
 */
function calculateADX(
  candles: Kline[],
  period: number = 14
): { adx: number; plusDI: number; minusDI: number; trendStrength: 'no_trend' | 'weak' | 'strong' | 'very_strong' } | null {
  if (candles.length < period * 2 + 1) return null;

  const trArr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trArr.push(tr);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing: first value = sum, then ema-like update
  const wilderSmooth = (arr: number[]): number[] => {
    const out: number[] = [];
    let sum = arr.slice(0, period).reduce((s, v) => s + v, 0);
    out.push(sum);
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      out.push(sum);
    }
    return out;
  };

  const smoothedTR = wilderSmooth(trArr);
  const smoothedPlus = wilderSmooth(plusDM);
  const smoothedMinus = wilderSmooth(minusDM);

  // DI series
  const plusDIArr: number[] = [];
  const minusDIArr: number[] = [];
  const dxArr: number[] = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    const tr = smoothedTR[i];
    if (tr === 0) {
      plusDIArr.push(0);
      minusDIArr.push(0);
      dxArr.push(0);
      continue;
    }
    const pdi = (smoothedPlus[i] / tr) * 100;
    const mdi = (smoothedMinus[i] / tr) * 100;
    plusDIArr.push(pdi);
    minusDIArr.push(mdi);
    const sumDI = pdi + mdi;
    dxArr.push(sumDI === 0 ? 0 : (Math.abs(pdi - mdi) / sumDI) * 100);
  }

  if (dxArr.length < period) return null;

  // First ADX = SMA of first `period` DX values, then Wilder smoothing
  let adx = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  const lastPlusDI = plusDIArr[plusDIArr.length - 1];
  const lastMinusDI = minusDIArr[minusDIArr.length - 1];

  let trendStrength: 'no_trend' | 'weak' | 'strong' | 'very_strong' = 'no_trend';
  if (adx >= 50) trendStrength = 'very_strong';
  else if (adx >= 25) trendStrength = 'strong';
  else if (adx >= 20) trendStrength = 'weak';

  return {
    adx: parseFloat(adx.toFixed(2)),
    plusDI: parseFloat(lastPlusDI.toFixed(2)),
    minusDI: parseFloat(lastMinusDI.toFixed(2)),
    trendStrength,
  };
}

// ==================== NEW: FIBONACCI ====================

/**
 * Fibonacci retracement seviyeleri — son `lookback` mumdaki swing high/low'a göre.
 * Swing yönü: hangisi daha yeni ise ona göre belirlenir (up = low önce, high sonra).
 */
function calculateFibonacciLevels(
  candles: Kline[],
  lookback: number = 50
): TechnicalIndicators['fibonacci'] {
  if (candles.length < lookback) return null;

  const window = candles.slice(-lookback);
  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].high > window[highIdx].high) highIdx = i;
    if (window[i].low < window[lowIdx].low) lowIdx = i;
  }

  const swingHigh = window[highIdx].high;
  const swingLow = window[lowIdx].low;
  const direction: 'up' | 'down' = highIdx >= lowIdx ? 'up' : 'down';
  const currentPrice = candles[candles.length - 1].close;
  const range = swingHigh - swingLow;

  if (range === 0) return null;

  // For an up-swing (low → high): retracements measured down from high.
  // For a down-swing (high → low): retracements measured up from low.
  const ratios = { '0': 0, '236': 0.236, '382': 0.382, '500': 0.5, '618': 0.618, '786': 0.786, '1000': 1 };
  const levels: Record<string, number> = {};
  for (const [key, r] of Object.entries(ratios)) {
    levels[key] = direction === 'up'
      ? parseFloat((swingHigh - range * r).toFixed(2))   // 0% = high, 100% = low
      : parseFloat((swingLow + range * r).toFixed(2));   // 0% = low,  100% = high
  }

  // Position bucket — based on retracement fraction of current price
  const frac = direction === 'up'
    ? (swingHigh - currentPrice) / range
    : (currentPrice - swingLow) / range;

  let position: NonNullable<TechnicalIndicators['fibonacci']>['position'] = 'between_382_500';
  if (frac < 0) position = 'below_0';
  else if (frac < 0.236) position = 'between_0_236';
  else if (frac < 0.382) position = 'between_236_382';
  else if (frac < 0.5)   position = 'between_382_500';
  else if (frac < 0.618) position = 'between_500_618';
  else if (frac < 0.786) position = 'between_618_786';
  else if (frac <= 1)    position = 'between_786_1000';
  else                   position = 'above_1000';

  // Nearest level (closest by absolute price diff)
  let nearestLevel = '500';
  let nearestDist = Infinity;
  for (const [key, price] of Object.entries(levels)) {
    const dist = Math.abs(currentPrice - price);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestLevel = key;
    }
  }

  return {
    swingHigh: parseFloat(swingHigh.toFixed(2)),
    swingLow: parseFloat(swingLow.toFixed(2)),
    direction,
    levels,
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    nearestLevel,
    position,
  };
}

// ==================== NEW: CANDLESTICK PATTERNS ====================

interface CandleStats {
  body: number;        // |close - open|
  range: number;       // high - low
  upperShadow: number; // high - max(open, close)
  lowerShadow: number; // min(open, close) - low
  isBullish: boolean;  // close > open
  isBearish: boolean;  // close < open
  bodyMid: number;     // (open + close) / 2
}

function describeCandle(c: Kline): CandleStats {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  return {
    body,
    range,
    upperShadow: c.high - Math.max(c.open, c.close),
    lowerShadow: Math.min(c.open, c.close) - c.low,
    isBullish: c.close > c.open,
    isBearish: c.close < c.open,
    bodyMid: (c.open + c.close) / 2,
  };
}

/**
 * Son birkaç mumdan klasik patternleri tespit et.
 * 8 patern: Hammer, Shooting Star, Doji, Bullish Engulfing, Bearish Engulfing,
 *           Morning Star, Evening Star, Three White Soldiers / Three Black Crows
 */
function detectCandlestickPatterns(candles: Kline[]): TechnicalIndicators['candlestickPatterns'] {
  const out: TechnicalIndicators['candlestickPatterns'] = [];
  if (candles.length < 3) return out;

  const n = candles.length;
  const c1 = candles[n - 1];               // most recent
  const c2 = candles[n - 2];
  const c3 = candles[n - 3];
  const s1 = describeCandle(c1);
  const s2 = describeCandle(c2);
  const s3 = describeCandle(c3);

  // --- Single-candle patterns on the last candle ---

  // Doji: body very small vs range
  if (s1.range > 0 && s1.body / s1.range < 0.1) {
    out.push({ name: 'Doji', type: 'neutral', strength: 0.5, candlesAgo: 0 });
  }

  // Hammer: small body near top, long lower shadow (>= 2x body), short upper shadow
  if (
    s1.body > 0 &&
    s1.lowerShadow >= 2 * s1.body &&
    s1.upperShadow <= s1.body
  ) {
    const isBullishContext = s2.isBearish || s3.isBearish; // after a decline
    out.push({
      name: 'Hammer',
      type: 'bullish',
      strength: isBullishContext ? 0.8 : 0.5,
      candlesAgo: 0,
    });
  }

  // Shooting Star: small body near bottom, long upper shadow (>= 2x body), short lower shadow
  if (
    s1.body > 0 &&
    s1.upperShadow >= 2 * s1.body &&
    s1.lowerShadow <= s1.body
  ) {
    const isBearishContext = s2.isBullish || s3.isBullish; // after a rally
    out.push({
      name: 'Shooting Star',
      type: 'bearish',
      strength: isBearishContext ? 0.8 : 0.5,
      candlesAgo: 0,
    });
  }

  // --- Two-candle patterns ---

  // Bullish Engulfing: prev bearish, current bullish, current body fully engulfs prev body
  if (
    s2.isBearish && s1.isBullish &&
    c1.close > c2.open && c1.open < c2.close
  ) {
    const sizeRatio = s2.body > 0 ? s1.body / s2.body : 2;
    out.push({
      name: 'Bullish Engulfing',
      type: 'bullish',
      strength: Math.min(0.9, 0.6 + sizeRatio * 0.1),
      candlesAgo: 0,
    });
  }

  // Bearish Engulfing
  if (
    s2.isBullish && s1.isBearish &&
    c1.open > c2.close && c1.close < c2.open
  ) {
    const sizeRatio = s2.body > 0 ? s1.body / s2.body : 2;
    out.push({
      name: 'Bearish Engulfing',
      type: 'bearish',
      strength: Math.min(0.9, 0.6 + sizeRatio * 0.1),
      candlesAgo: 0,
    });
  }

  // --- Three-candle patterns ---

  // Morning Star: bearish c3, small-body c2 gapped down, bullish c1 closing above c3 midpoint
  const c3Mid = (c3.open + c3.close) / 2;
  if (
    s3.isBearish && s3.body > 0 &&
    s2.body < s3.body * 0.5 &&
    s1.isBullish && c1.close > c3Mid
  ) {
    out.push({ name: 'Morning Star', type: 'bullish', strength: 0.85, candlesAgo: 0 });
  }

  // Evening Star: bullish c3, small-body c2, bearish c1 closing below c3 midpoint
  if (
    s3.isBullish && s3.body > 0 &&
    s2.body < s3.body * 0.5 &&
    s1.isBearish && c1.close < c3Mid
  ) {
    out.push({ name: 'Evening Star', type: 'bearish', strength: 0.85, candlesAgo: 0 });
  }

  // Three White Soldiers: 3 bullish candles, each closing higher, each opening within previous body
  if (
    s3.isBullish && s2.isBullish && s1.isBullish &&
    c2.close > c3.close && c1.close > c2.close &&
    c2.open >= c3.open && c2.open <= c3.close &&
    c1.open >= c2.open && c1.open <= c2.close
  ) {
    out.push({ name: 'Three White Soldiers', type: 'bullish', strength: 0.9, candlesAgo: 0 });
  }

  // Three Black Crows: 3 bearish candles, each closing lower, each opening within previous body
  if (
    s3.isBearish && s2.isBearish && s1.isBearish &&
    c2.close < c3.close && c1.close < c2.close &&
    c2.open <= c3.open && c2.open >= c3.close &&
    c1.open <= c2.open && c1.open >= c2.close
  ) {
    out.push({ name: 'Three Black Crows', type: 'bearish', strength: 0.9, candlesAgo: 0 });
  }

  return out;
}

// ==================== HIERARCHY ====================

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function buildHierarchy(
  indicators: Omit<TechnicalIndicators, 'hierarchy' | 'summary'>,
  currentPrice: number
): TechnicalIndicators['hierarchy'] {
  // ---- TIER 1: TREND (EMA stack + ADX) ----
  const t1: TierScore = { bias: 0, strength: 0, signals: [] };
  if (indicators.ema) {
    const trendMap: Record<string, number> = {
      strong_bullish:  1.0,
      bullish:         0.5,
      neutral:         0.0,
      bearish:        -0.5,
      strong_bearish: -1.0,
    };
    t1.bias = trendMap[indicators.ema.trend] ?? 0;
    t1.signals.push(
      `EMA: 20=$${indicators.ema.ema20} | 50=$${indicators.ema.ema50} | 200=${indicators.ema.ema200 !== null ? '$' + indicators.ema.ema200 : 'n/a (insufficient history)'} — ${indicators.ema.trend} stack`
    );
  }
  if (indicators.adx) {
    const adxStrengthMap: Record<string, number> = {
      no_trend:    0.2,
      weak:        0.5,
      strong:      0.8,
      very_strong: 1.0,
    };
    // ADX boosts strength; DI cross gives directional confirmation
    t1.strength = adxStrengthMap[indicators.adx.trendStrength] ?? 0.5;
    // DI bias: keskin ±0.2 yerine, DI farkına orantılı (cross yakınında küçük).
    const diDiff = indicators.adx.plusDI - indicators.adx.minusDI;
    const diBias = clamp(diDiff / 50, -0.2, 0.2);
    t1.bias = clamp(t1.bias + diBias, -1, 1);
    t1.signals.push(
      `ADX(14): ${indicators.adx.adx} (${indicators.adx.trendStrength.toUpperCase().replace('_', ' ')}) | +DI ${indicators.adx.plusDI}, -DI ${indicators.adx.minusDI}`
    );
  } else if (indicators.ema) {
    t1.strength = 0.5; // EMA-only fallback
  }

  // Counter-trend lock: EMA200 mevcutsa, fiyat yanlış tarafta iken karşı yöne bias yasak.
  // Kasım 2025 fiyat-EMA200 altında long açma vakalarının sıfırlanması burada sağlanır.
  if (indicators.ema?.ema200 !== null && indicators.ema?.ema200 !== undefined) {
    if (currentPrice < indicators.ema.ema200 && t1.bias > 0) {
      t1.signals.push(`Counter-trend lock: price $${currentPrice.toFixed(2)} < EMA200 $${indicators.ema.ema200} → long bias yasak (bias 0'a düştü)`);
      t1.bias = 0;
    } else if (currentPrice > indicators.ema.ema200 && t1.bias < 0) {
      t1.signals.push(`Counter-trend lock: price $${currentPrice.toFixed(2)} > EMA200 $${indicators.ema.ema200} → short bias yasak (bias 0'a düştü)`);
      t1.bias = 0;
    }
  }

  // EMA50 slope soft penalty: eğim bias ile zıtsa, trend gücünü yarıya indir.
  if (indicators.ema && t1.bias !== 0) {
    const slope = indicators.ema.ema50Slope;
    if (slope !== 0 && Math.sign(slope) !== Math.sign(t1.bias)) {
      t1.strength = t1.strength * 0.5;
      t1.signals.push(`EMA50 slope ${(slope * 100).toFixed(3)}% bias ile zıt yönde → strength %50 azaltıldı`);
    }
  }

  // ---- TIER 2: MOMENTUM (RSI + MACD + Stochastic) ----
  const t2: TierScore = { bias: 0, strength: 0, signals: [] };
  const t2Parts: number[] = [];
  if (indicators.rsi !== null) {
    // -1 at RSI 0, +1 at RSI 100, centered at 50; extreme zones penalised back toward 0 (mean reversion)
    let rsiBias = (indicators.rsi - 50) / 50; // -1..+1
    if (indicators.rsi > 70) rsiBias = 0.4 - (indicators.rsi - 70) / 30 * 0.4; // overbought → fade
    if (indicators.rsi < 30) rsiBias = -0.4 + (30 - indicators.rsi) / 30 * 0.4; // oversold → fade
    t2Parts.push(rsiBias);
    const rsiLabel = indicators.rsi > 70 ? 'OVERBOUGHT' : indicators.rsi < 30 ? 'OVERSOLD' : 'neutral';
    t2.signals.push(`RSI(14): ${indicators.rsi.toFixed(1)} (${rsiLabel})`);
  }
  if (indicators.macd) {
    // Histogram sign + magnitude → bias
    const histBias = clamp(indicators.macd.histogram / Math.max(1e-6, Math.abs(indicators.macd.macd) || 1), -1, 1);
    t2Parts.push(histBias);
    t2.signals.push(
      `MACD: ${indicators.macd.macd} | signal ${indicators.macd.signal} | hist ${indicators.macd.histogram} (${indicators.macd.histogram > 0 ? 'bullish' : 'bearish'})`
    );
  }
  if (indicators.stochastic) {
    const k = indicators.stochastic.k;
    let stochBias = (k - 50) / 50;
    if (indicators.stochastic.signal === 'overbought') stochBias = 0.3;  // weak bullish-but-fading
    else if (indicators.stochastic.signal === 'oversold') stochBias = -0.3;
    t2Parts.push(stochBias);
    t2.signals.push(`Stochastic: %K ${indicators.stochastic.k}, %D ${indicators.stochastic.d} (${indicators.stochastic.signal})`);
  }
  if (t2Parts.length > 0) {
    t2.bias = clamp(t2Parts.reduce((s, v) => s + v, 0) / t2Parts.length, -1, 1);
    // Strength = average absolute value (how decisive the momentum reads are)
    t2.strength = clamp(t2Parts.reduce((s, v) => s + Math.abs(v), 0) / t2Parts.length + 0.3, 0, 1);
  }

  // ---- TIER 3: STRUCTURE (BB + ATR + Fibonacci) ----
  const t3: TierScore = { bias: 0, strength: 0, signals: [] };
  const t3Parts: number[] = [];
  if (indicators.bollingerBands) {
    const pb = indicators.bollingerBands.percentB;
    // %B > 1 = above upper (fade), < 0 = below lower (fade up); mid = mild bias toward existing trend
    let bbBias = (pb - 0.5) * 1.0; // -0.5..+0.5 in normal range
    if (pb > 1) bbBias = -0.4;
    if (pb < 0) bbBias = 0.4;
    t3Parts.push(bbBias);
    t3.signals.push(
      `Bollinger: %B ${pb.toFixed(2)}, BW ${indicators.bollingerBands.bandwidth}% (upper $${indicators.bollingerBands.upper} / lower $${indicators.bollingerBands.lower})`
    );
  }
  if (indicators.atr !== null) {
    t3.signals.push(`ATR(14): $${indicators.atr} — calibrate SL ±1.5×, TP ±3×`);
  }
  if (indicators.fibonacci) {
    // Position relative to retracement: deep retraces in up-swing → bullish bounce zone
    const posMap: Record<string, number> = {
      below_0:           0.4,   // breakout extension up (if up-swing context)
      between_0_236:     0.3,
      between_236_382:   0.2,
      between_382_500:   0.1,
      between_500_618:   0.0,
      between_618_786:  -0.2,
      between_786_1000: -0.3,
      above_1000:       -0.4,
    };
    let fibBias = posMap[indicators.fibonacci.position] ?? 0;
    if (indicators.fibonacci.direction === 'down') fibBias = -fibBias;
    t3Parts.push(fibBias);
    t3.signals.push(
      `Fibonacci (${indicators.fibonacci.direction}-swing): price near ${indicators.fibonacci.nearestLevel}% ($${indicators.fibonacci.levels[indicators.fibonacci.nearestLevel]}), position=${indicators.fibonacci.position}`
    );
  }
  if (t3Parts.length > 0) {
    t3.bias = clamp(t3Parts.reduce((s, v) => s + v, 0) / t3Parts.length, -1, 1);
    t3.strength = clamp(t3Parts.reduce((s, v) => s + Math.abs(v), 0) / t3Parts.length + 0.3, 0, 1);
  }

  // ---- TIER 4: PRICE ACTION (Candlestick patterns) ----
  const t4: TierScore = { bias: 0, strength: 0, signals: [] };
  if (indicators.candlestickPatterns.length > 0) {
    let netBias = 0;
    let totalStrength = 0;
    for (const p of indicators.candlestickPatterns) {
      const sign = p.type === 'bullish' ? 1 : p.type === 'bearish' ? -1 : 0;
      netBias += sign * p.strength;
      totalStrength += p.strength;
      t4.signals.push(`${p.name} (${p.type}, strength ${p.strength.toFixed(2)}, ${p.candlesAgo === 0 ? 'last candle' : `${p.candlesAgo} candles ago`})`);
    }
    t4.bias = clamp(netBias / Math.max(1, indicators.candlestickPatterns.length), -1, 1);
    t4.strength = clamp(totalStrength / indicators.candlestickPatterns.length, 0, 1);
  } else {
    t4.signals.push('No notable candlestick patterns');
  }

  // ---- TIER 5: VOLUME ----
  const t5: TierScore = { bias: 0, strength: 0, signals: [] };
  if (indicators.volumeProfile) {
    const vp = indicators.volumeProfile;
    // Volume itself is non-directional; we use trend × current price direction as a proxy.
    // Strength scales with how far current volume is from average.
    const dirSign = vp.volumeTrend === 'increasing' ? 0.3 : vp.volumeTrend === 'decreasing' ? -0.3 : 0;
    t5.bias = dirSign;
    t5.strength = clamp(Math.abs(vp.currentVsAverage - 1) * 0.5 + 0.3, 0, 1);
    t5.signals.push(`Volume: ${vp.volumeTrend} (${vp.currentVsAverage}× avg)`);
  }

  // ---- COMPOSITE ----
  const composite =
    t1.bias * TIER_WEIGHTS.tier1_trend       * t1.strength +
    t2.bias * TIER_WEIGHTS.tier2_momentum    * t2.strength +
    t3.bias * TIER_WEIGHTS.tier3_structure   * t3.strength +
    t4.bias * TIER_WEIGHTS.tier4_priceAction * t4.strength +
    t5.bias * TIER_WEIGHTS.tier5_volume      * t5.strength;

  const compositeScore = parseFloat(composite.toFixed(3));
  let overallBias: TechnicalIndicators['hierarchy']['overallBias'] = 'neutral';
  if (compositeScore >= 0.5) overallBias = 'strong_bullish';
  else if (compositeScore >= 0.15) overallBias = 'bullish';
  else if (compositeScore <= -0.5) overallBias = 'strong_bearish';
  else if (compositeScore <= -0.15) overallBias = 'bearish';

  return {
    tier1_trend: t1,
    tier2_momentum: t2,
    tier3_structure: t3,
    tier4_priceAction: t4,
    tier5_volume: t5,
    compositeScore,
    overallBias,
  };
}

// ==================== SUMMARY ====================

function buildSummary(indicators: TechnicalIndicators): string {
  const parts: string[] = [];

  parts.push(`Composite: ${indicators.hierarchy.compositeScore >= 0 ? '+' : ''}${indicators.hierarchy.compositeScore} ${indicators.hierarchy.overallBias.toUpperCase()}`);

  if (indicators.ema) parts.push(`EMA ${indicators.ema.trend}`);
  if (indicators.adx) parts.push(`ADX ${indicators.adx.adx} (${indicators.adx.trendStrength})`);
  if (indicators.rsi !== null) parts.push(`RSI ${indicators.rsi.toFixed(0)}`);
  if (indicators.macd) parts.push(`MACD ${indicators.macd.histogram > 0 ? 'bullish' : 'bearish'}`);
  if (indicators.stochastic) parts.push(`Stoch ${indicators.stochastic.signal}`);
  if (indicators.candlestickPatterns.length > 0) {
    const bull = indicators.candlestickPatterns.filter(p => p.type === 'bullish').length;
    const bear = indicators.candlestickPatterns.filter(p => p.type === 'bearish').length;
    parts.push(`${bull} bullish / ${bear} bearish patterns`);
  }
  if (indicators.fibonacci) parts.push(`Fib ${indicators.fibonacci.nearestLevel}%`);
  if (indicators.volumeProfile) parts.push(`Vol ${indicators.volumeProfile.volumeTrend}`);

  return parts.join(' | ');
}

// ==================== MAIN FUNCTION ====================

/**
 * Bir sembol için tüm teknik indikatörleri hesapla
 */
export function calculateAllIndicators(candles: Kline[]): TechnicalIndicators {
  const closes = candles.map(k => k.close);
  const currentPrice = closes[closes.length - 1];

  // RSI
  const rsi = calculateRSI(closes);

  // MACD
  const macd = calculateMACD(closes);

  // Bollinger Bands
  const bollingerBands = calculateBollingerBands(closes);

  // EMAs
  let ema: TechnicalIndicators['ema'] = null;
  const ema20Arr = calculateEMA(closes, 20);
  const ema50Arr = calculateEMA(closes, 50);
  const ema200Arr = calculateEMA(closes, 200);

  if (ema20Arr.length > 0 && ema50Arr.length > 0) {
    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema50 = ema50Arr[ema50Arr.length - 1];
    // EMA200 stays null when <200 candles — no silent fallback, so strong_* trends
    // are only reported when we actually have the long-term context.
    const ema200 = ema200Arr.length > 0 ? ema200Arr[ema200Arr.length - 1] : null;

    // EMA50 eğimi: son 5 mumdaki rölatif değişim. Dönüş bölgesinde DI cross'tan
    // önce yön değişimini yakalar.
    let ema50Slope = 0;
    if (ema50Arr.length >= 6) {
      const past = ema50Arr[ema50Arr.length - 6];
      ema50Slope = past !== 0 ? (ema50 - past) / past : 0;
    }

    ema = {
      ema20: parseFloat(ema20.toFixed(2)),
      ema50: parseFloat(ema50.toFixed(2)),
      ema200: ema200 !== null ? parseFloat(ema200.toFixed(2)) : null,
      ema50Slope: parseFloat(ema50Slope.toFixed(6)),
      trend: analyzeEMATrend(currentPrice, ema20, ema50, ema200),
    };
  }

  // Volume Profile
  const volumeProfile = calculateVolumeProfile(candles);

  // ATR
  const atr = calculateATR(candles);

  // SMA200 — rejim etiketi (fiyat SMA200 üstü/altı) için; <200 mumda null
  let sma200: number | null = null;
  if (closes.length >= 200) {
    let sum = 0;
    for (let i = closes.length - 200; i < closes.length; i++) sum += closes[i];
    sma200 = parseFloat((sum / 200).toFixed(2));
  }

  // NEW: Stochastic
  const stochastic = calculateStochastic(candles);

  // NEW: ADX
  const adx = calculateADX(candles);

  // NEW: Fibonacci
  const fibonacci = calculateFibonacciLevels(candles);

  // NEW: Candlestick patterns
  const candlestickPatterns = detectCandlestickPatterns(candles);

  const base = {
    rsi,
    macd,
    bollingerBands,
    ema,
    volumeProfile,
    atr,
    sma200,
    stochastic,
    adx,
    fibonacci,
    candlestickPatterns,
  };

  const hierarchy = buildHierarchy(base, currentPrice);

  const indicators: TechnicalIndicators = {
    ...base,
    hierarchy,
    summary: '',
  };

  indicators.summary = buildSummary(indicators);

  return indicators;
}

/**
 * Birden fazla sembol için teknik indikatörleri hesapla
 */
export function calculateMultiSymbolIndicators(
  candlesMap: Record<string, Kline[]>
): Record<string, TechnicalIndicators> {
  const result: Record<string, TechnicalIndicators> = {};

  for (const [symbol, candles] of Object.entries(candlesMap)) {
    if (candles.length > 0) {
      result[symbol] = calculateAllIndicators(candles);
    }
  }

  return result;
}

// ==================== PROMPT FORMATTER ====================

/**
 * AI prompt'una eklenecek hiyerarşik teknik analiz bloğu.
 * Hem analyzer.ts (live) hem backtestExecutor.ts bu fonksiyonu kullanır.
 */
export function formatTechnicalIndicatorsBlock(symbol: string, ti: TechnicalIndicators): string {
  const h = ti.hierarchy;
  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);

  const lines: string[] = [];
  lines.push(`### ${symbol} — Composite: ${sign(h.compositeScore)} ${h.overallBias.toUpperCase()}`);

  const tierLine = (label: string, weight: number, t: TierScore): string =>
    `\n**${label} (weight ${weight.toFixed(2)}) | bias ${sign(t.bias)}, strength ${t.strength.toFixed(2)}**\n` +
    (t.signals.length > 0 ? t.signals.map(s => `  • ${s}`).join('\n') : '  • (no data)');

  lines.push(tierLine('TIER 1 — Trend',        TIER_WEIGHTS.tier1_trend,       h.tier1_trend));
  lines.push(tierLine('TIER 2 — Momentum',     TIER_WEIGHTS.tier2_momentum,    h.tier2_momentum));
  lines.push(tierLine('TIER 3 — Structure',    TIER_WEIGHTS.tier3_structure,   h.tier3_structure));
  lines.push(tierLine('TIER 4 — Price Action', TIER_WEIGHTS.tier4_priceAction, h.tier4_priceAction));
  lines.push(tierLine('TIER 5 — Volume',       TIER_WEIGHTS.tier5_volume,      h.tier5_volume));

  return lines.join('\n');
}

export const technicalIndicatorsService = {
  calculateAllIndicators,
  calculateMultiSymbolIndicators,
  formatTechnicalIndicatorsBlock,
};
