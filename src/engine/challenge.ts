import crypto from 'node:crypto';
import { runBacktest, DEFAULT_GRID, type BacktestOutput, type GridSpec } from './backtest';
import { assertCoverage, loadDataset, type Dataset } from './dataset';
import { DEFAULT_COSTS, stressCosts, type CostConfig } from './costModel';
import { evaluatePromotion, type EvaluatedRun, type PromotionVerdict } from './promotion';
import { runGauntlet, type GauntletResult } from '../strategy/gauntlet';
import { SandboxPool } from '../strategy/sandbox/host';
import { compileStrategy, validateStrategySource, type ValidationIssue } from '../strategy/validator';
import { buildApiDts, toSandboxSource } from '../codex/workspace';
import { decisionPoints } from './backtest';
import type { WorkerInit } from '../strategy/sandbox/protocol';
import type { RecordedDecision } from './simulator';
import type { CandleInterval } from '../config/env';
import type { BacktestResults, StrategyProfile } from '../lib/types';
import type { Strategy } from '../strategy/types';

/**
 * Bir adayin TAM degerlendirmesi: dogrulama -> gauntlet -> grid backtest -> stres -> kasa -> kapi.
 *
 * ============================ KASA (HOLDOUT) ============================
 *
 * Zaman ekseni soyle bolunur:
 *
 *   |<--------------- SECIM PENCERESI --------------->|<--- KASA --->|
 *   start                                       holdoutStart         end
 *
 * Grid sweep'i, walk-forward'i, skorlamasi, en iyi hucre secimi — HEPSI yalnizca secim
 * penceresinde kosar. Kasa'ya dokunan tek kod, promosyon kapisinin son evet/hayir'idir.
 *
 * Neden: 365 gece x ~1700 hucre ~= 620.000 deneme. Bu olcekte "test dilimi" bile artik
 * temiz degildir — cunku hucreyi SECERKEN test diliminin skorunu kullaniyoruz. Yani test
 * dilimi de, dolayli olarak, bir egitim setidir. Kasa, secim surecinin HIC gormedigi tek
 * veridir ve bu yuzden bu sistemde durustluk hakkinda bir sey soyleyebilen tek sayidir.
 */

export interface ChallengeArgs {
  strategy: Strategy;
  /** Adayin TS kaynagi (Codex'in yazdigi). Builtin sampiyon icin de kaynak verilir (sha icin). */
  source: string;
  /** true = sandbox'ta kos (Codex adayi). false = dogrudan (builtin, bizim kodumuz). */
  sandboxed: boolean;

  symbols: string[];
  interval: CandleInterval;
  startDate: number;
  endDate: number;
  holdoutDays: number;
  initialBalance: number;
  profile: StrategyProfile;

  costs?: CostConfig;
  grid?: GridSpec;
  /** Verilirse strateji parametreleri taranmaz (sampiyonu ayni hucrede yeniden kosmak icin). */
  fixedParams?: Record<string, number | boolean>;

  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface ChallengeResult {
  ok: boolean;
  /** Basarisizlik nedeni (dogrulama/gauntlet asamasinda dustuyse). */
  failure?: string;
  /** Codex'e onarim turu olarak geri beslenecek metin. */
  feedback?: string;

  validation?: ValidationIssue[];
  gauntlet?: GauntletResult;

  /** Secim penceresindeki grid sonucu. */
  selection?: BacktestOutput;
  /** Kapiya verilecek ozet. */
  evaluated?: EvaluatedRun;
  stress?: BacktestResults;
  holdout?: BacktestResults;
  codeSha256: string;
}

const DAY_MS = 86_400_000;

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export async function challenge(args: ChallengeArgs): Promise<ChallengeResult> {
  const codeSha256 = sha256(args.source);
  const costs = args.costs ?? DEFAULT_COSTS;

  // --- Zaman eksenini bol. Kasa, secim penceresinden FIZIKSEL olarak kesilir.
  const holdoutStart = args.endDate - args.holdoutDays * DAY_MS;
  if (holdoutStart <= args.startDate) {
    throw new Error('Kasa penceresi tum donemi yiyor — backtestDays / holdoutDays orani hatali');
  }

  // --- 1. STATIK DOGRULAMA (sandbox'li adaylar icin).
  let compiledJs = '';
  if (args.sandboxed) {
    const v = validateStrategySource(args.source);
    if (!v.ok) {
      return {
        ok: false,
        codeSha256,
        failure: 'validator',
        validation: v.issues,
        feedback: v.issues.map((i) => `- [${i.code}] satir ${i.line}: ${i.message}`).join('\n'),
      };
    }

    const c = compileStrategy(toSandboxSource(args.source), buildApiDts());
    if (!c.ok) {
      return {
        ok: false,
        codeSha256,
        failure: 'derleyici',
        validation: c.diagnostics,
        feedback: c.diagnostics.map((d) => `- [${d.code}] satir ${d.line}: ${d.message}`).join('\n'),
      };
    }
    compiledJs = c.js!;
  }

  // --- Veriyi bir kez yukle (kasa dahil; kesim asagida yapilir).
  const dsArgs = {
    symbols: args.symbols,
    interval: args.interval,
    startDate: args.startDate,
    endDate: args.endDate,
  };
  const ds = loadDataset(dsArgs);

  try {
    // Eksik veri BIR SONUC DEGILDIR. Kapsam yetersizse burada patlar; aksi halde grid
    // sifir islemli hucrelerle dolar, hepsi AZ_ISLEM'den elenir ve panel bunu stratejinin
    // basarisizligi olarak gosterir — olculmemis bir seyi "olctuk ve kotu" diye raporlamak,
    // bu sistemin uretebilecegi en pahali yalandir.
    assertCoverage(ds, dsArgs);

    // --- 2. GAUNTLET (yalnizca sandbox'li adaylar): determinizm, look-ahead, saglik.
    let gauntlet: GauntletResult | undefined;
    let pool: SandboxPool | null = null;

    if (args.sandboxed) {
      const init = makeInit(compiledJs, args, ds, args.startDate, holdoutStart);

      args.onProgress?.('gauntlet', 0, 1);
      gauntlet = await runGauntlet({
        init,
        job: {
          cellIndex: 0,
          params: defaultParams(args.strategy),
          profile: args.profile,
          macroRiskAppetite: null,
        },
      });
      args.onProgress?.('gauntlet', 1, 1);

      if (!gauntlet.pass) {
        return { ok: false, codeSha256, failure: 'gauntlet', gauntlet, feedback: gauntlet.feedback };
      }

      pool = SandboxPool.create(init);
    }

    try {
      const record = pool
        ? async (params: Record<string, number | boolean>): Promise<RecordedDecision[]> =>
            pool!.run({ cellIndex: 0, params, profile: args.profile, macroRiskAppetite: null })
        : undefined;

      // --- 3. SECIM PENCERESINDE grid backtest. Kasa GORULMEZ (endDate = holdoutStart).
      args.onProgress?.('grid', 0, 1);
      const selection = await runBacktest({
        strategy: args.strategy,
        record,
        symbols: args.symbols,
        interval: args.interval,
        startDate: args.startDate,
        endDate: holdoutStart, // <<< KASA BURADA KESILIR
        initialBalance: args.initialBalance,
        profile: args.profile,
        klines: ds.klines,
        indicators: ds.indicators,
        funding: ds.funding,
        lsr: ds.lsr,
        macroRiskAppetite: null,
        intrabar: ds.intrabar,
        costs,
        grid: args.grid ?? DEFAULT_GRID,
        ...(args.fixedParams ? { fixedParams: args.fixedParams } : {}),
        onProgress: (d, t) => args.onProgress?.('grid', d, t),
      });

      const best = selection.best;
      const scoredBest = selection.scored?.[selection.bestIndex];

      // --- 4. MALIYET STRESI: kazanan hucre, fee x1.5 / slippage x2 ile.
      args.onProgress?.('stres', 0, 1);
      const stressRun = await runBacktest({
        strategy: args.strategy,
        record,
        symbols: args.symbols,
        interval: args.interval,
        startDate: args.startDate,
        endDate: holdoutStart,
        initialBalance: args.initialBalance,
        profile: args.profile,
        klines: ds.klines,
        indicators: ds.indicators,
        funding: ds.funding,
        lsr: ds.lsr,
        macroRiskAppetite: null,
        intrabar: ds.intrabar,
        costs: stressCosts(costs),
        fixedParams: best.params,
        fixedRisk: best.risk,
      });
      args.onProgress?.('stres', 1, 1);

      // --- 5. KASA: kazanan hucre, SECIMDE HIC KULLANILMAYAN pencerede.
      //
      // Not: startDate kasa penceresinin BASI. Warmup mumlari loadDataset tarafindan
      // zaten oncesinden yuklendi, yani strateji burada da 250 mumluk gecmise sahip.
      args.onProgress?.('kasa', 0, 1);
      const holdoutRun = await runBacktest({
        strategy: args.strategy,
        record,
        symbols: args.symbols,
        interval: args.interval,
        startDate: holdoutStart,
        endDate: args.endDate,
        initialBalance: args.initialBalance,
        profile: args.profile,
        klines: ds.klines,
        indicators: ds.indicators,
        funding: ds.funding,
        lsr: ds.lsr,
        macroRiskAppetite: null,
        intrabar: ds.intrabar,
        costs,
        fixedParams: best.params,
        fixedRisk: best.risk,
      });
      args.onProgress?.('kasa', 1, 1);

      const evaluated: EvaluatedRun = {
        verdict: selection.verdict,
        qualified: !selection.fallbackUsed,
        test: best.testResults!,
        windowsPositive: best.windowsPositive ?? 0,
        windowCount: selection.plan.windows.length,
        qualifiedNeighbors: scoredBest?.qualifiedNeighborCount ?? 0,
        dqNeighbors: scoredBest?.dqNeighborCount ?? 0,
        codeSha256,
        entrySignature: entrySignature(selection),
      };

      return {
        ok: true,
        codeSha256,
        gauntlet,
        selection,
        evaluated,
        stress: stressRun.best.results,
        holdout: holdoutRun.best.results,
      };
    } finally {
      await pool?.close();
    }
  } finally {
    ds.close();
  }
}

/** Adayi sampiyonla karsilastirip promosyon hukmu verir. */
export function judge(
  candidate: ChallengeResult,
  champion: EvaluatedRun | null,
): PromotionVerdict {
  if (!candidate.ok || !candidate.evaluated || !candidate.stress || !candidate.holdout) {
    return {
      promote: false,
      reasons: [],
      blockers: [`aday degerlendirilemedi: ${candidate.failure ?? 'bilinmeyen'}`],
    };
  }

  return evaluatePromotion({
    champion,
    challenger: candidate.evaluated,
    challengerStress: candidate.stress,
    holdout: candidate.holdout,
  });
}

// ---------------------------------------------------------------- yardimcilar

function makeInit(
  compiledJs: string,
  args: ChallengeArgs,
  ds: Dataset,
  from: number,
  to: number,
): WorkerInit {
  return {
    compiledJs,
    symbols: args.symbols,
    interval: args.interval,
    // Worker TUM donemin karar noktalarini uretir; backtest hangi araligi kullanacagini
    // kendi secer (kasa kesimi startDate/endDate ile yapilir).
    points: decisionPoints(args.startDate, args.endDate, args.interval),
    klines: ds.klines,
    indicators: ds.indicators,
    funding: ds.funding,
  };
}

function defaultParams(s: Strategy): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const p of s.meta.params) out[p.key] = p.default;
  return out;
}

/** Giris sinyallerinin imzasi — "klon degil" sartinin girdisi. */
function entrySignature(out: BacktestOutput): Set<string> {
  const set = new Set<string>();
  for (const t of out.bestRun.trades) set.add(`${t.entryTime}:${t.symbol}:${t.side}`);
  return set;
}
