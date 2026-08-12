import { DEFAULT_RISK_PARAMS, type RiskParams } from './riskManagement';
import { scoreGrid, type ScoredCell, type ScoringCell } from './gridScoring';
import { decideAt } from './signalRunner';
import { simulate, type RecordedDecision, type SimulateResult } from './simulator';
import { DEFAULT_MIN_CONFIDENCE, DEFAULT_USE_TRAILING, cooldownMsFor } from './execConfig';
import { deriveVerdict, planWalkForward, sliceResults, type WalkForwardPlan } from './walkForward';
import { INTERVAL_MS, type FundingRate, type Kline } from '../lib/klineStore';
import type { TechnicalIndicators } from '../vendor/technicalIndicators';
import type { CostConfig } from './costModel';
import type { CandleInterval } from '../config/env';
import type { GridCellResult, StrategyProfile, WalkForwardVerdict } from '../lib/types';
import type { Strategy, StrategyParamSpec } from '../strategy/types';

/**
 * Backtest orkestratoru: RECORD x REPLAY grid'i, walk-forward, skorlama, en iyi hucre.
 *
 * Grid iki boyutludur:
 *   RECORD boyutu = STRATEJI parametreleri. Her biri FARKLI bir karar akisi uretir,
 *                   yani strateji bir kez degil, hucre basina bir kez kosar.
 *   REPLAY boyutu = RISK parametreleri (rr x sl x cb). Kararlar sabit oldugu icin
 *                   bu boyut BEDAVA: ayni karar akisi farkli risk hucrelerinde
 *                   yeniden oynatilir. Sample'in RECORD/REPLAY fikri buydu ve dogruydu.
 *
 * Toplam simulasyon = |strateji hucreleri| x |risk hucreleri|, MAX_CELLS ile kapaklanir.
 */

/**
 * Toplam hucre tavani.
 *
 * Tavan 2000'di ve gercek sinir HESAP degil BELLEKTI: her hucrenin tam SimulateResult'i
 * (trade listesi + equity egrisi) `runs` dizisinde tutuluyordu, oysa bunlardan yalnizca
 * KAZANAN kullaniliyordu. 540 gun/4h'te hucre basina ~3200 noktalik egri x binlerce hucre
 * = yuzlerce MB. Artik kazananin kosusu secimden SONRA bir kez yeniden uretiliyor
 * (asagida), yani bellek hucre sayisindan bagimsiz.
 *
 * Geriye kalan maliyetler OLCULDU — 13.824 hucrelik gercek kosu (6 sembol, 4h, 540 gun):
 *   - simulasyon: 862 sn toplam, hucre basina ~62 ms  -> 20k hucre ~21 dk
 *   - bellek:     tepe 653 MB, bunun ~510 MB'i veri seti; hucre basina ~10 KB (metrikler)
 *   - skorlama:   gridScoring O(n^2) -> 13.8k hucre ~2.7 sn, 20k ~6 sn
 * Yani bu tavanda kosu UZUN ama bitiyor; panel ilerlemeyi asama asama gosteriyor.
 * Daha yukarisi once skorlamayi (n^2) sisirir.
 */
export const MAX_CELLS = 20_000;

/** meta.maxSweepCells verilmemisse strateji ekseninin kendi tavani. */
export const DEFAULT_MAX_SWEEP_CELLS = 24;

export interface GridSpec {
  rewardRatios: number[];
  slMultipliers: number[];
  callbackMultipliers: number[];
  /** Islem basina riske edilen bakiye orani. */
  riskPerTradePcts: number[];
}

/**
 * riskPerTradePct NEDEN taraniyor:
 *
 * Sample'in DEFAULT_RISK_PARAMS'i islem basina %5 risk aliyordu ("agresif preset",
 * riskManagement.ts:7) ve grid'i yalnizca rr/sl/cb uzerinde tariyordu. Mekanik v0'in
 * kazanma orani ~%22 (kucuk cok kayip + az sayida buyuk trailing kazanc) — %5 risk ile
 * bu, kacinilmaz olarak %45-50 drawdown demek.
 *
 * Sonuc: gridScoring'in TEST_DD > %40 diskalifiyesi HER hucreyi eliyordu (1728'in 1706'si).
 * Yani hicbir aday promosyon kapisini gecemezdi ve gece dongusu dogdugu anda olurdu.
 * Drawdown'i belirleyen en guclu tek kol taranmiyorsa, DD'ye dayali bir kapi kurmanin
 * anlami yok. Bu eksen olmadan sistem calismaz.
 */
export const DEFAULT_GRID: GridSpec = {
  rewardRatios: [2, 3.5, 5, 6.5],
  slMultipliers: [0.8, 1.5, 2.2],
  callbackMultipliers: [0.8, 1.5],
  riskPerTradePcts: [0.01, 0.02, 0.035, 0.05],
};

export interface RunBacktestArgs {
  strategy: Strategy;

  /**
   * RECORD pass'ini disaridan saglar — SANDBOX yolu.
   *
   * Codex'in yazdigi bir aday DOGRUDAN cagrilamaz: kodu once vm realm'inde izole edilmeli
   * (bkz. strategy/sandbox/). Bu fonksiyon verilirse karar akisi worker havuzundan gelir;
   * verilmezse strategy.evaluate dogrudan cagrilir (yalnizca builtin sampiyon icin —
   * o bizim kodumuz, izole etmeye gerek yok ve gereksiz serilestirmeden kacinilir).
   *
   * Her iki yolda da kararlari ureten mantik AYNI: signalRunner.decideAt / worker'daki
   * esdegeri. Ayrisirlarsa sandbox'li aday ile builtin sampiyon farkli kurallarla
   * yarisir — yani kiyas anlamsizlasir.
   */
  record?: (params: Record<string, number | boolean>) => Promise<RecordedDecision[]>;

  symbols: string[];
  interval: CandleInterval;
  startDate: number;
  endDate: number;
  initialBalance: number;
  profile: StrategyProfile;

  klines: Record<string, Kline[]>;
  indicators: Record<string, TechnicalIndicators[]>;
  funding: Record<string, FundingRate[]>;
  lsr: Record<string, { longShortRatio: number; longAccount: number; shortAccount: number }>;
  macroRiskAppetite: 'risk_on' | 'risk_off' | 'mixed' | null;
  intrabar: (symbol: string, openTime: number, closeTime: number) => Kline[];

  costs: CostConfig;
  grid?: GridSpec;
  /** Verilirse strateji parametreleri TARANMAZ, bu degerler sabitlenir (sampiyon yeniden kosumu). */
  fixedParams?: Record<string, number | boolean>;
  /** Verilirse risk parametreleri taranmaz (tek hucre). */
  fixedRisk?: RiskParams;

  minConfidence?: number;
  useTrailing?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BacktestOutput {
  cells: GridCellResult[];
  scored: ScoredCell[] | null;
  bestIndex: number;
  best: GridCellResult;
  /** En iyi hucrenin trade'leri ve equity egrisi (rapor/analiz icin). */
  bestRun: SimulateResult;
  verdict: WalkForwardVerdict;
  plan: WalkForwardPlan;
  /** Hicbir hucre skorlama filtrelerini gecemedi mi? */
  fallbackUsed: boolean;
  /** Grid eksen isimleri — heatmap ve rapor icin. */
  axes: { name: string; values: Array<number | boolean> }[];
}

export async function runBacktest(args: RunBacktestArgs): Promise<BacktestOutput> {
  const grid = args.grid ?? DEFAULT_GRID;

  const paramCells = args.fixedParams
    ? [args.fixedParams]
    : buildParamCells(
        args.strategy.meta.params,
        args.strategy.meta.maxSweepCells ?? DEFAULT_MAX_SWEEP_CELLS,
      );

  const riskCells = args.fixedRisk ? [args.fixedRisk] : buildRiskCells(grid);

  if (paramCells.length * riskCells.length > MAX_CELLS) {
    throw new Error(
      `Grid cok buyuk: ${paramCells.length} strateji x ${riskCells.length} risk = ` +
        `${paramCells.length * riskCells.length} hucre (tavan ${MAX_CELLS}). ` +
        `Risk grid'inin eksenlerini kisalt veya strateji parametrelerini sabitle ` +
        `(fixedParams) — sabitlemek carpani 1'e indirir.`,
    );
  }

  const plan = planWalkForward(args.startDate, args.endDate);
  const points = decisionPoints(args.startDate, args.endDate, args.interval);
  const cooldownMs = cooldownMsFor(args.interval);

  const cells: GridCellResult[] = [];

  const total = paramCells.length * riskCells.length;
  let done = 0;

  // Eksen indeksleri: [rr, sl, cb, ...strateji paramlari]. gridScoring'in Chebyshev
  // plato komsulugu bu vektor uzerinden calisir — yani bir hucre, hem risk hem de
  // strateji ekseninde komsulari saglamsa "plato", degilse "sansli diken" sayilir.
  const paramAxes = args.fixedParams ? [] : sweepableParams(args.strategy.meta.params);

  /**
   * Strateji ekseni TEK hucreyse (fixedParams kosulari, stres ve kasa pencereleri) karar
   * akisi zaten elimizde kalir; kazanan icin RECORD'u tekrarlamak gereksiz is olurdu.
   * Grid taraniyorsa null kalir — 18 karar akisini bellekte tutmanin anlami yok.
   */
  let onlyDecisions: RecordedDecision[] | null = null;

  for (let p = 0; p < paramCells.length; p++) {
    const params = paramCells[p]!;

    // --- RECORD: bu strateji parametreleriyle karar akisini BIR KEZ uret.
    // Sandbox yolu (Codex adayi) veya dogrudan yol (builtin sampiyon).
    const decisions: RecordedDecision[] = args.record
      ? await args.record(params)
      : recordDirect(args, points, params);

    if (paramCells.length === 1) onlyDecisions = decisions;

    // --- REPLAY: ayni kararlari her risk hucresinde yeniden oynat (bedava).
    for (let r = 0; r < riskCells.length; r++) {
      const risk = riskCells[r]!;

      const run = replay(args, decisions, risk, cooldownMs);
      const sliced = sliceResults(run.trades, run.equityCurve, args.initialBalance, plan);

      cells.push({
        cellIndex: cells.length,
        params,
        risk,
        results: sliced.full,
        trainResults: sliced.train,
        testResults: sliced.test,
        windowTestPnls: sliced.windowTestPnls,
        windowsPositive: sliced.windowsPositive,
      });

      // run BURADA BIRAKILIR. Trade listesi ve equity egrisi hucre basina yuz KB'a
      // varabilir ve yalnizca kazananinki lazim; hepsini tutmak MAX_CELLS'i bellege
      // esir ediyordu. Kazananin kosusu secimden sonra yeniden uretilir (deterministik).

      done++;
      args.onProgress?.(done, total);
    }
  }

  // --- Skorlama + en iyi hucre.
  const scoringCells: ScoringCell[] = cells.map((c) => ({
    idx: [
      grid.rewardRatios.indexOf(c.risk.rewardRatio),
      grid.slMultipliers.indexOf(c.risk.slMultiplier),
      grid.callbackMultipliers.indexOf(c.risk.callbackMultiplier),
      grid.riskPerTradePcts.indexOf(c.risk.riskPerTradePct),
      ...paramAxes.map((spec) => (spec.sweep ?? []).indexOf(c.params[spec.key]!)),
    ],
    rewardRatio: c.risk.rewardRatio,
    // Olu-RR tespiti: RR DISINDAKI tum eksenlerin imzasi.
    groupKey: `${c.risk.slMultiplier}|${c.risk.callbackMultiplier}|${c.risk.riskPerTradePct}|${JSON.stringify(c.params)}`,
    results: toScoringSlice(c.results),
    trainResults: c.trainResults ? toScoringSlice(c.trainResults) : undefined,
    testResults: c.testResults ? toScoringSlice(c.testResults) : undefined,
    windowTestPnls: c.windowTestPnls,
    windowsPositive: c.windowsPositive,
  }));

  const scored = scoreGrid(scoringCells, plan.trainRatio);

  let bestIndex = 0;
  let fallbackUsed = false;

  if (scored) {
    const qualified = scored
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s.dq === null && x.s.finalScore !== null);

    if (qualified.length > 0) {
      qualified.sort((a, b) => {
        const d = b.s.finalScore! - a.s.finalScore!;
        if (Math.abs(d) > 1e-12) return d;
        // Esitlik: test PnL'i yuksek olan.
        return cells[b.i]!.testResults!.totalPnlPercent - cells[a.i]!.testResults!.totalPnlPercent;
      });
      bestIndex = qualified[0]!.i;
      for (const q of qualified) cells[q.i]!.plateauScore = q.s.finalScore!;
    } else {
      // HICBIR hucre filtreleri gecemedi. Bu bir basarisizliktir, bir secim degil —
      // en iyi gorunen hucreyi secip "sampiyon" ilan etmek tam olarak self-improvement
      // dongusunun kendini kandirdigi yerdir. Verdict FAILED olur, promosyon reddedilir.
      fallbackUsed = true;
      bestIndex = argmaxBy(cells, (c) => c.results.totalPnlPercent);
    }
  } else {
    fallbackUsed = true;
    bestIndex = argmaxBy(cells, (c) => c.results.totalPnlPercent);
  }

  const best = cells[bestIndex]!;

  /*
   * Kazanan hucrenin TAM kosusu (trade'ler, equity egrisi, skip'ler) burada bir kez
   * yeniden uretilir: RECORD tekrar edilir, ayni kararlar kazanan risk hucresinde
   * yeniden oynatilir. Hem RECORD hem REPLAY deterministik (rastgelelik yok, saat
   * okunmuyor), yani bu, grid sirasinda hesaplanan kosunun BIREBIR aynisidir —
   * ucuz bir yeniden hesap karsiliginda hucre basina bellek O(1) olur.
   */
  const bestDecisions =
    onlyDecisions ??
    (args.record ? await args.record(best.params) : recordDirect(args, points, best.params));
  const bestRun = replay(args, bestDecisions, best.risk, cooldownMs);

  const verdict = deriveVerdict({
    test: best.testResults!,
    windowsPositive: best.windowsPositive ?? 0,
    windowCount: plan.windows.length,
    fallbackUsed,
  });

  const axes: BacktestOutput['axes'] = [
    { name: 'rewardRatio', values: grid.rewardRatios },
    { name: 'slMultiplier', values: grid.slMultipliers },
    { name: 'callbackMultiplier', values: grid.callbackMultipliers },
    { name: 'riskPerTradePct', values: grid.riskPerTradePcts },
    ...paramAxes.map((spec) => ({ name: spec.key, values: [...(spec.sweep ?? [])] })),
  ];

  return {
    cells,
    scored,
    bestIndex,
    best,
    bestRun,
    verdict,
    plan,
    fallbackUsed,
    axes,
  };
}

/** REPLAY: sabit karar akisini tek bir risk hucresinde oynatir. */
function replay(
  args: RunBacktestArgs,
  decisions: RecordedDecision[],
  risk: RiskParams,
  cooldownMs: number,
): SimulateResult {
  return simulate({
    decisions,
    klines: args.klines,
    indicators: args.indicators,
    funding: args.funding,
    intrabar: args.intrabar,
    risk,
    costs: args.costs,
    initialBalance: args.initialBalance,
    endDate: args.endDate,
    cooldownMs,
    minConfidence: args.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    useTrailing: args.useTrailing ?? DEFAULT_USE_TRAILING,
  });
}

/** Sandbox'siz RECORD — yalnizca builtin (bizim yazdigimiz) stratejiler icin. */
function recordDirect(
  args: RunBacktestArgs,
  points: number[],
  params: Record<string, number | boolean>,
): RecordedDecision[] {
  const decisions: RecordedDecision[] = [];
  for (const at of points) {
    const d = decideAt({
      strategy: args.strategy,
      symbols: args.symbols,
      interval: args.interval,
      at,
      klines: args.klines,
      indicators: args.indicators,
      funding: args.funding,
      lsr: args.lsr,
      macroRiskAppetite: args.macroRiskAppetite,
      profile: args.profile,
      params,
    });
    if (d.allocations.length > 0 || d.rejections.length > 0) decisions.push(d);
  }
  return decisions;
}

// ---------------------------------------------------------------- grid insasi

function sweepableParams(specs: ReadonlyArray<StrategyParamSpec>): StrategyParamSpec[] {
  return specs.filter((s) => s.sweep && s.sweep.length > 1);
}

/**
 * Strateji ekseninin kac hucre oldugu — grid'i KURMADAN.
 *
 * Toplam hucre = bu sayi x risk hucreleri. HTTP ucu ve panel tavani bununla kontrol
 * eder; boylece "grid cok buyuk" hatasi veri indirilip dakikalar harcandiktan sonra
 * degil, operator Start'a basmadan once soylenir.
 */
export function paramCellCount(specs: ReadonlyArray<StrategyParamSpec>): number {
  return sweepableParams(specs).reduce((n, s) => n * s.sweep!.length, 1);
}

/** Strateji parametrelerinin kartezyen carpimi. Taranmayanlar default'ta sabitlenir. */
export function buildParamCells(
  specs: ReadonlyArray<StrategyParamSpec>,
  maxCells: number,
): Array<Record<string, number | boolean>> {
  const base: Record<string, number | boolean> = {};
  for (const s of specs) base[s.key] = s.default;

  const sweeps = sweepableParams(specs);
  if (sweeps.length === 0) return [base];

  let cells: Array<Record<string, number | boolean>> = [base];
  for (const s of sweeps) {
    const next: Array<Record<string, number | boolean>> = [];
    for (const cell of cells) {
      for (const v of s.sweep!) next.push({ ...cell, [s.key]: v });
    }
    cells = next;
  }

  if (cells.length > maxCells) {
    throw new Error(
      `Strateji parametre grid'i ${cells.length} hucre, meta.maxSweepCells = ${maxCells}. ` +
        `Sweep listelerini kisalt.`,
    );
  }
  return cells;
}

export function buildRiskCells(grid: GridSpec): RiskParams[] {
  const out: RiskParams[] = [];
  // Iç ice sira ONEMLI: heatmap ve gridScoring'in eksen indeksleri buna dayanir.
  for (const rp of grid.riskPerTradePcts) {
    for (const sl of grid.slMultipliers) {
      for (const cb of grid.callbackMultipliers) {
        for (const rr of grid.rewardRatios) {
          out.push({
            ...DEFAULT_RISK_PARAMS,
            riskPerTradePct: rp,
            // Portfoy risk tavani islem riskiyle olceklenir: sabit %15 tavan, %1 islem
            // riskiyle 15 es zamanli pozisyona izin verirdi (sembol sayimizdan fazla),
            // %5 ile 3'e dusurup RISK_CAP'i surekli tetikliyordu. ~4 pozisyonluk butce.
            maxPortfolioRiskPct: Math.min(0.15, rp * 4),
            atrMultiplier: sl,
            slMultiplier: sl,
            callbackMultiplier: cb,
            rewardRatio: rr,
          });
        }
      }
    }
  }
  return out;
}

/** Karar noktalari: her mum kapanisinda. Ilk nokta UTC mum sinirina yukari yuvarlanir. */
export function decisionPoints(startDate: number, endDate: number, interval: CandleInterval): number[] {
  const ms = INTERVAL_MS[interval];
  const first = Math.ceil(startDate / ms) * ms;
  const out: number[] = [];
  for (let t = first; t <= endDate; t += ms) out.push(t);
  return out;
}

// ---------------------------------------------------------------- yardimcilar

function toScoringSlice(r: GridCellResult['results']) {
  return {
    totalPnlPercent: r.totalPnlPercent,
    maxDrawdownPercent: r.maxDrawdownPercent,
    sharpeRatio: r.sharpeRatio,
    totalTrades: r.totalTrades,
    feeShareOfGross: r.feeShareOfGross,
  };
}

function argmaxBy<T>(items: T[], score: (t: T) => number): number {
  let bestI = 0;
  let bestV = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const v = score(items[i]!);
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  return bestI;
}
