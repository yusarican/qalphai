import type { StrategyProfile } from '../lib/types';
import type { StrategySignal } from '../strategy/types';

/**
 * Portfoy katmani — sample'daki mechanicalDecider'in ALLOCATION yarisi (:362-430).
 *
 * Codex bu dosyayi ASLA gormez. Bir strateji yalnizca (side, confidence) uretir;
 * o confidence'in kaldiraca, pozisyon buyuklugune ve portfoy payina nasil cevrilecegi
 * burasidir. Kaldirac ozellikle kritik: mechanicalDecider'da kaldirac karar motorunun
 * icindeydi (:323-327), yani orada kalsaydi Codex confidence uzerinden riske DOLAYLI
 * bir kol kazanirdi. Buraya tasindi.
 */

export interface ProfileSpec {
  /** [dusuk vol, orta vol, yuksek vol] kaldirac kademeleri. */
  leverageByVol: [number, number, number];
  /** allocationPercent tabani (x confidence). */
  baseAllocationPct: number;
  /** Toplam tahsis tavani. */
  maxTotalAllocationPct: number;
}

export const PROFILES: Record<StrategyProfile, ProfileSpec> = {
  conservative: { leverageByVol: [5, 3, 2], baseAllocationPct: 20, maxTotalAllocationPct: 50 },
  balanced: { leverageByVol: [20, 10, 5], baseAllocationPct: 30, maxTotalAllocationPct: 80 },
  aggressive: { leverageByVol: [50, 25, 15], baseAllocationPct: 40, maxTotalAllocationPct: 90 },
};

/** Kaldirac tavani — profil ne derse desin asilamaz. */
export const MAX_LEVERAGE = 10;

/** Volatilite kademeleri: ATR'nin fiyata orani (%). */
const VOL_LOW_PCT = 0.5;
const VOL_MID_PCT = 1.0;

export const DEFAULT_COOLDOWN_CANDLES = 3;

const round5 = (v: number) => Math.round(v / 5) * 5;

export interface Allocation {
  symbol: string;
  side: 'LONG' | 'SHORT';
  confidence: number;
  leverage: number;
  allocationPercent: number;
  reason: string;
}

export type RejectionRule = 'ALLOCATION_CAP' | 'MIN_CONF' | 'COOLDOWN' | 'RISK_CAP' | 'MIN_MARGIN' | 'NO_ATR_SIZING';

export interface Rejection {
  symbol: string;
  /** Strateji veto'lari kendi kural adlarini tasir; harness redleri yukaridaki sabitler. */
  rule: string;
  side?: 'LONG' | 'SHORT';
  confidence?: number;
  note?: string;
}

/** Volatiliteye gore kaldirac. Risk-off bir kademe DUSURUR (daha yuksek vol gibi davranir). */
export function leverageFor(
  profile: StrategyProfile,
  atr: number,
  price: number,
  riskOff: boolean,
): number {
  const spec = PROFILES[profile];
  if (!(price > 0) || !(atr > 0)) return 1;

  const atrPct = (atr / price) * 100;
  let volIdx = atrPct < VOL_LOW_PCT ? 0 : atrPct <= VOL_MID_PCT ? 1 : 2;
  if (riskOff) volIdx = Math.min(2, volIdx + 1);

  return Math.min(MAX_LEVERAGE, spec.leverageByVol[volIdx]!);
}

export interface AllocateArgs {
  signals: Array<{
    symbol: string;
    signal: StrategySignal;
    atr: number;
    price: number;
  }>;
  profile: StrategyProfile;
  riskOff: boolean;
}

export interface AllocateResult {
  allocations: Allocation[];
  rejections: Rejection[];
}

/**
 * Adaylari confidence'e gore siralar ve tavani asmayacak sekilde 5'in katlarinda dagitir.
 * Tavana takilanlar ALLOCATION_CAP olarak raporlanir (analiz: "cap gevsetilse ne kacti").
 */
export function allocate(args: AllocateArgs): AllocateResult {
  const spec = PROFILES[args.profile];

  const sorted = [...args.signals].sort((a, b) => b.signal.confidence - a.signal.confidence);

  const allocations: Allocation[] = [];
  const rejections: Rejection[] = [];
  const placed = new Set<string>();

  let remaining = spec.maxTotalAllocationPct;

  for (const c of sorted) {
    if (remaining < 5) break;

    let pct = Math.max(5, round5(spec.baseAllocationPct * c.signal.confidence));
    pct = Math.min(pct, Math.floor(remaining / 5) * 5);
    if (pct < 5) break;

    remaining -= pct;
    placed.add(c.symbol);

    allocations.push({
      symbol: c.symbol,
      side: c.signal.side,
      confidence: c.signal.confidence,
      leverage: leverageFor(args.profile, c.atr, c.price, args.riskOff),
      allocationPercent: pct,
      reason: c.signal.reason ?? '',
    });
  }

  for (const c of sorted) {
    if (placed.has(c.symbol)) continue;
    rejections.push({
      symbol: c.symbol,
      rule: 'ALLOCATION_CAP',
      side: c.signal.side,
      confidence: c.signal.confidence,
    });
  }

  return { allocations, rejections };
}
