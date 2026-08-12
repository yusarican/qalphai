import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Kline } from '../lib/klineStore';
import {
  calculateAllIndicators,
  type TechnicalIndicators,
} from '../vendor/technicalIndicators';

/**
 * Indikator serisini bir kez hesaplar, diske cache'ler.
 *
 * Sample'da calculateAllIndicators UC ayri yerde cagriliyordu — RECORD'da karar noktasi
 * basina (backtestExecutor.ts:740), REPLAY'de giris basina (:916), ve counterfactual'da
 * (:1463) — her seferinde 250 mum dilimleyip ~15 indikatoru sifirdan hesaplayarak.
 * Grid (strateji hucreleri x risk hucreleri) ile carpilinca bu, simulasyonun degil
 * GECENIN KENDISI oluyordu.
 *
 * Hizalama sozlesmesi (kritik — look-ahead buna bagli):
 *   series[j] = calculateAllIndicators(candles[j-249 .. j])   // j'inci mum DAHIL
 *
 * Yani series[j], j'inci mum KAPANDIKTAN sonra bilinebilecek her seydir. Bir sonraki
 * mumun acilisinda (t = candles[j+1].openTime) karar verirken kullanilacak indeks j'dir.
 * Sample'in `klines.filter(k => k.openTime < t).slice(-250)` ifadesiyle birebir aynidir.
 */

/** Sample ile ayni lookback penceresi. */
const LOOKBACK = 250;

/** calculateAllIndicators bunun altinda anlamli sonuc uretmiyor (sample: :911). */
const MIN_BARS = 35;

export function computeIndicatorSeries(candles: Kline[]): TechnicalIndicators[] {
  const out: TechnicalIndicators[] = new Array(candles.length);

  for (let j = 0; j < candles.length; j++) {
    if (j + 1 < MIN_BARS) {
      out[j] = EMPTY_INDICATORS;
      continue;
    }
    const window = candles.slice(Math.max(0, j - LOOKBACK + 1), j + 1);
    out[j] = calculateAllIndicators(window);
  }

  return out;
}

// ---------------------------------------------------------------- disk cache

interface CacheDir {
  dir: string;
}

const CACHE: CacheDir = { dir: path.join('.cache', 'indicators') };

/**
 * Cache anahtari mum verisinin ICERIGINDEN turer (ilk/son openTime + uzunluk + son close).
 * Boylece veri geriye donuk duzeltilirse (Binance nadiren yapar) cache sessizce
 * bayatlamaz — anahtar degisir, yeniden hesaplanir.
 */
function cacheKey(symbol: string, interval: string, candles: Kline[]): string {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const sig = `${symbol}|${interval}|${candles.length}|${first?.openTime ?? 0}|${last?.openTime ?? 0}|${last?.close ?? 0}`;
  return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 32);
}

export function computeIndicatorSeriesCached(
  symbol: string,
  interval: string,
  candles: Kline[],
): TechnicalIndicators[] {
  if (candles.length === 0) return [];

  fs.mkdirSync(CACHE.dir, { recursive: true });
  const file = path.join(CACHE.dir, `${symbol}-${interval}-${cacheKey(symbol, interval, candles)}.json`);

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TechnicalIndicators[];
      if (Array.isArray(parsed) && parsed.length === candles.length) return parsed;
    } catch {
      // Bozuk cache — sessizce yeniden hesapla.
    }
  }

  const series = computeIndicatorSeries(candles);
  fs.writeFileSync(file, JSON.stringify(series));
  return series;
}

/** Yeterli mum yokken kullanilan bos indikator seti. */
export const EMPTY_INDICATORS: TechnicalIndicators = {
  rsi: null,
  macd: null,
  bollingerBands: null,
  ema: null,
  volumeProfile: null,
  atr: null,
  sma200: null,
  stochastic: null,
  adx: null,
  fibonacci: null,
  candlestickPatterns: [],
  hierarchy: {
    tier1_trend: { bias: 0, strength: 0, signals: [] },
    tier2_momentum: { bias: 0, strength: 0, signals: [] },
    tier3_structure: { bias: 0, strength: 0, signals: [] },
    tier4_priceAction: { bias: 0, strength: 0, signals: [] },
    tier5_volume: { bias: 0, strength: 0, signals: [] },
    compositeScore: 0,
    overallBias: 'neutral',
  },
  summary: '',
};
