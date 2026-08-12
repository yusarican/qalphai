import type { FundingRate, Kline } from '../../lib/klineStore';
import type { TechnicalIndicators } from '../../vendor/technicalIndicators';
import type { CandleInterval } from '../../config/env';
import type { StrategyProfile } from '../../lib/types';
import type { RecordedDecision } from '../../engine/simulator';

/**
 * Host <-> sandbox worker protokolu.
 *
 * Veri worker'a BIR KEZ (init'te) gecer; sonra her is yalnizca strateji parametrelerini
 * tasir. Aksi halde grid'in her hucresinde on binlerce mumun structured-clone maliyeti,
 * hesabin kendisini golgede birakirdi.
 */

export interface WorkerInit {
  /** Codex'in derlenmis (ES2022/CJS) JS'i. */
  compiledJs: string;

  symbols: string[];
  interval: CandleInterval;
  /** Karar noktalari (mum acilis zamanlari). */
  points: number[];

  klines: Record<string, Kline[]>;
  indicators: Record<string, TechnicalIndicators[]>;
  funding: Record<string, FundingRate[]>;
}

/** Bir grid hucresi = bir strateji parametre kombinasyonu. */
export interface WorkerJob {
  cellIndex: number;
  params: Record<string, number | boolean>;
  profile: StrategyProfile;
  macroRiskAppetite: 'risk_on' | 'risk_off' | 'mixed' | null;
}

export type WorkerResult =
  | { ok: true; cellIndex: number; decisions: RecordedDecision[] }
  | { ok: false; cellIndex: number; error: string };
