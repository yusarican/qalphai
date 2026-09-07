import axios from 'axios';

/**
 * ============================================================================
 * SENTIMENT — otopsinin DISARIYA bakan, opsiyonel katmani.
 * ============================================================================
 *
 * Bu proje bilerek fiyat-disi veri kullanmiyor: strateji sozlesmesi haber/sosyal metni
 * "uygulanamaz girdi" sayiyor (research/selector.ts:89) ve ranker onlari kara listeye
 * aliyor. Bu dosya o karari DEGISTIRMIYOR.
 *
 * Fark su: burada uretilen sayilar bir STRATEJIYE girmiyor. Yalnizca OTOPSI raporunda,
 * "o pencerede piyasa nasil bir ruh halindeydi" sorusuna insan/LLM okumasi icin
 * baglam olarak duruyorlar. Bir strateji bunlari goremez — StrategyContext'te boyle
 * bir alan yok ve eklenmiyor.
 *
 * ---------------------------------------------------------------- ABSENT != ZERO
 *
 * Iki kaynagin da kapsam siniri var ve sinirin disinda `null` donuyorlar, 0 degil.
 * Bu, panelin format.ts kuralinin (bilinmeyen fiyat em-dash, asla 0) motor tarafindaki
 * karsiligi: 2025 Mayis'i icin "korku endeksi 0" demek, "veri yok" demekten tamamen
 * baska bir sey soyler ve otopsiyi yanlis yone gonderir.
 */

/** Kisa zaman asimi: otopsi, disari cevap vermedigi icin durmamali. */
const TIMEOUT_MS = 15_000;

export interface FearGreedPoint {
  timestamp: number;
  /** 0 (asiri korku) - 100 (asiri acgozluluk). */
  value: number;
  label: string;
}

export interface FearGreedWindow {
  points: FearGreedPoint[];
  average: number | null;
  min: FearGreedPoint | null;
  max: FearGreedPoint | null;
  /** Kaynak ve kapsam — rapora AYNEN yazilir. */
  source: string;
  unavailable?: string;
}

const DAY_MS = 86_400_000;

/**
 * Alternative.me Kripto Korku & Acgozluluk endeksi.
 *
 * Anahtarsiz, ucretsiz, GUNLUK cozunurluk ve 2018'e kadar tarihsel. Bu sistemin
 * ihtiyaci icin dogru boyut: otopsi penceresi haftalar/aylar, dakikalar degil.
 */
export async function fetchFearGreed(from: number, to: number): Promise<FearGreedWindow> {
  const empty: FearGreedWindow = {
    points: [],
    average: null,
    min: null,
    max: null,
    source: 'alternative.me/crypto/fear-and-greed-index (gunluk, anahtarsiz)',
  };

  try {
    // limit=0 tum gecmisi doner; pencereye burada kirpiyoruz. API tarih araligi
    // parametresi kabul etmiyor.
    const res = await axios.get<{ data?: Array<{ value?: string; value_classification?: string; timestamp?: string }> }>(
      'https://api.alternative.me/fng/?limit=0&format=json',
      { timeout: TIMEOUT_MS },
    );

    const points: FearGreedPoint[] = [];
    for (const row of res.data?.data ?? []) {
      const ts = Number(row.timestamp) * 1000;
      const value = Number(row.value);
      if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
      // Endeks gunun BASINI damgaliyor; pencereye gun toleransiyla giriyoruz.
      if (ts < from - DAY_MS || ts > to + DAY_MS) continue;
      points.push({ timestamp: ts, value, label: row.value_classification ?? '' });
    }

    if (points.length === 0) {
      return { ...empty, unavailable: 'bu pencerede endeks kaydi yok (kaynak 2018 oncesini tasimaz)' };
    }

    points.sort((a, b) => a.timestamp - b.timestamp);
    return {
      ...empty,
      points,
      average: points.reduce((s, p) => s + p.value, 0) / points.length,
      min: points.reduce((m, p) => (p.value < m.value ? p : m)),
      max: points.reduce((m, p) => (p.value > m.value ? p : m)),
    };
  } catch (err) {
    // Otopsi disari cevap vermedigi icin DURMAZ; eksiklik raporda yazar.
    return { ...empty, unavailable: `kaynak okunamadi: ${message(err)}` };
  }
}

export interface PositioningPoint {
  timestamp: number;
  longShortRatio: number | null;
  openInterestUsd: number | null;
}

export interface PositioningWindow {
  symbol: string;
  points: PositioningPoint[];
  source: string;
  unavailable?: string;
}

/** Binance bu iki seriyi YALNIZCA son 30 gun icin veriyor. Daha eskisi sessizce bos doner. */
const POSITIONING_HORIZON_MS = 30 * DAY_MS;

/**
 * Binance konumlanma serileri: hesap bazli long/short orani + acik pozisyon.
 *
 * KAPSAM SINIRI KRITIK: Binance bu uclari yalnizca son ~30 gun icin dolduruyor
 * (dataset.ts:76 ayni sebeple `lsr: {}` donduruyor — backtest'te bu veriler HIC yok).
 * Daha eski bir otopsi penceresi icin bos dizi degil, ACIK bir "kapsam disi" mesaji
 * donduruyoruz: bos dizi, "o donemde konumlanma notrdu" diye okunabilirdi.
 */
export async function fetchPositioning(
  symbol: string,
  from: number,
  to: number,
): Promise<PositioningWindow> {
  const base: PositioningWindow = {
    symbol,
    points: [],
    source: 'fapi.binance.com/futures/data (yalnizca son 30 gun)',
  };

  if (from < Date.now() - POSITIONING_HORIZON_MS) {
    return {
      ...base,
      unavailable:
        'pencere Binance konumlanma verisinin 30 gunluk ufkunun disinda — bu donem icin ' +
        'long/short orani ve acik pozisyon OLCULEMEZ (yoklugu notrluk anlamina gelmez)',
    };
  }

  try {
    const params = { symbol, period: '4h', limit: 500, startTime: from, endTime: to };
    const [lsr, oi] = await Promise.all([
      axios.get<Array<{ timestamp?: number; longShortRatio?: string }>>(
        'https://fapi.binance.com/futures/data/globalLongShortAccountRatio',
        { params, timeout: TIMEOUT_MS },
      ),
      axios.get<Array<{ timestamp?: number; sumOpenInterestValue?: string }>>(
        'https://fapi.binance.com/futures/data/openInterestHist',
        { params, timeout: TIMEOUT_MS },
      ),
    ]);

    const oiByTs = new Map<number, number>();
    for (const row of oi.data ?? []) {
      if (row.timestamp) oiByTs.set(row.timestamp, Number(row.sumOpenInterestValue));
    }

    const points: PositioningPoint[] = (lsr.data ?? [])
      .filter((r) => typeof r.timestamp === 'number')
      .map((r) => ({
        timestamp: r.timestamp!,
        longShortRatio: numOrNull(r.longShortRatio),
        openInterestUsd: oiByTs.get(r.timestamp!) ?? null,
      }));

    return points.length > 0
      ? { ...base, points }
      : { ...base, unavailable: 'kaynak bu pencere icin kayit dondurmedi' };
  } catch (err) {
    return { ...base, unavailable: `kaynak okunamadi: ${message(err)}` };
  }
}

function numOrNull(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
