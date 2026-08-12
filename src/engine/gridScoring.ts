/**
 * 5 asamali grid skorlama: hard filtreler -> MAR tabanli ham skor -> islem sayisi
 * guven carpani -> komsu havuzlamali plato skoru (+ istikrar cezasi) -> rapor alanlari.
 *
 * Sample'daki (engine/gridScoring.ts) algoritmanin BIREBIR ayni matematigi. Iki degisiklik:
 *
 * 1. Komsuluk N BOYUTLU. Sample 3B (rr, sl, cb) risk kupune sabitlenmisti; bizim grid'imiz
 *    artik (strateji parametreleri) x (risk parametreleri) oldugu icin indeks bir VEKTOR.
 *    Chebyshev mesafesi <= 1 tanimi degismedi, sadece boyut sayisi serbest. 3B vektorlerle
 *    cagrildiginda sonuc sample ile bit-identical kalir (altin fixture bunu dogruluyor).
 *
 * 2. Yeni diskalifiye: MALIYET_YIYOR. Edge'inin yarisindan fazlasi fee+funding'e giden bir
 *    hucre "edge" degildir; negatife donmeyi bekleyen bir yuvarlama hatasidir. Bu DQ olmadan
 *    Codex, maliyet altinda olen yuksek-frekansli stratejileri promote etmeye calisir.
 */

export interface ScoringSliceMetrics {
  totalPnlPercent: number;
  maxDrawdownPercent: number; // pozitif buyukluk (12.5 = -%12.5 drawdown)
  sharpeRatio: number;
  totalTrades: number;
  /** (fee + funding) / brut kar. Maliyet modeli kapaliyken 0. */
  feeShareOfGross?: number;
}

export interface ScoringCell {
  /**
   * Grid eksenlerindeki VEKTOR indeksi, ornegin [rrI, slI, cbI, entryThresholdI, ...].
   * Tum hucrelerde ayni uzunlukta olmali. Plato komsulugu bunun uzerinden hesaplanir.
   */
  idx: number[];
  /** Olu-RR tespiti icin: RR ekseninin bu hucredeki degeri ve RR DISINDAKI eksenlerin imzasi. */
  rewardRatio: number;
  groupKey: string;

  results: ScoringSliceMetrics;
  trainResults?: ScoringSliceMetrics;
  testResults?: ScoringSliceMetrics;

  windowTestPnls?: number[];
  windowsPositive?: number;
}

export type DqReason =
  | 'LIKIDASYON'
  | 'TEST_DD'
  | 'AZ_ISLEM'
  | 'TRAIN_NEGATIF'
  | 'MALIYET_YIYOR'
  | 'OLU_RR';

/**
 * Panelde ve gece raporunda GORUNEN etiketler — bu yuzden Ingilizce.
 * Anahtarlar (DqReason) kod tarafi, degismez.
 */
export const DQ_LABELS: Record<DqReason, string> = {
  LIKIDASYON: 'Liquidated (drawdown >= 100%)',
  TEST_DD: 'Test drawdown > 40%',
  AZ_ISLEM: 'Fewer than 20 test trades',
  TRAIN_NEGATIF: 'Negative train P&L',
  MALIYET_YIYOR: 'Costs eat the edge (fees + funding > 50% of gross profit)',
  OLU_RR: 'Dead risk/reward (identical test result)',
};

export interface ScoredCell {
  idx: number[];
  dq: DqReason | null;
  marTest: number | null;
  marTrain: number | null;
  rawScore: number | null;
  confidence: number | null;
  cellScore: number | null;
  finalScore: number | null;
  testTrainRatio: number | null;
  /** Chebyshev kupundeki diskalifiye komsu sayisi. */
  dqNeighborCount: number;
  /** Chebyshev kupundeki nitelikli (dq'suz) komsu sayisi — promosyon kapisi "plato" sarti. */
  qualifiedNeighborCount: number;
}

/** Edge'in maliyete giden orani bu esigi asarsa hucre diskalifiye. */
export const MAX_FEE_SHARE = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Chebyshev mesafe <= 1 -> N boyutlu grid'de komsu (kosegenler dahil, kendisi haric). */
function isNeighbor(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let d = 0; d < n; d++) {
    if (Math.abs(a[d]! - b[d]!) > 1) return false;
  }
  return true;
}

/**
 * Grid hucrelerini 5 asamali algoritmayla skorlar. Donen dizi hucre sirasini korur.
 * Tum hucrelerde train+test dilimi yoksa null doner (cagiran eski davranisa dusmeli).
 */
export function scoreGrid(cells: ScoringCell[], trainRatio: number): ScoredCell[] | null {
  if (!cells.length || !cells.every((c) => c.trainResults && c.testResults)) return null;

  const scored: ScoredCell[] = cells.map((c) => ({
    idx: c.idx,
    dq: null,
    marTest: null,
    marTrain: null,
    rawScore: null,
    confidence: null,
    cellScore: null,
    finalScore: null,
    testTrainRatio: null,
    dqNeighborCount: 0,
    qualifiedNeighborCount: 0,
  }));

  // Rapor: gune normalize TEST/TRAIN orani (dq'dan bagimsiz).
  // Alt sinir 0.1: kayan pencereli yapida train dilimi donemin ~1/3'u kadar olabilir.
  const tr = clamp(trainRatio, 0.1, 0.9);
  for (let i = 0; i < cells.length; i++) {
    const trainPnl = cells[i]!.trainResults!.totalPnlPercent;
    const testPnl = cells[i]!.testResults!.totalPnlPercent;
    if (Math.abs(trainPnl) >= 0.01) {
      scored[i]!.testTrainRatio = testPnl / (1 - tr) / (trainPnl / tr);
    }
  }

  // Asama 1 — hard filtreler
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const test = c.testResults!;
    const train = c.trainResults!;
    const feeShare = test.feeShareOfGross ?? 0;

    if (c.results.maxDrawdownPercent >= 100) scored[i]!.dq = 'LIKIDASYON';
    else if (test.maxDrawdownPercent > 40) scored[i]!.dq = 'TEST_DD';
    else if (test.totalTrades < 20) scored[i]!.dq = 'AZ_ISLEM';
    else if (train.totalPnlPercent < 0) scored[i]!.dq = 'TRAIN_NEGATIF';
    else if (feeShare > MAX_FEE_SHARE) scored[i]!.dq = 'MALIYET_YIYOR';
  }

  // Asama 1b — olu RR: RR disindaki eksenler ayniyken TEST sonucu birebir ayni olan
  // hucrelerde RR hic tetiklenmemistir; yalnizca en dusuk RR'li kalir, kalanlar gurultudur.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < cells.length; i++) {
    if (scored[i]!.dq) continue;
    const key = cells[i]!.groupKey;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  for (const idxs of Array.from(groups.values())) {
    const seen = new Set<string>();
    const byRr = [...idxs].sort((a, b) => cells[a]!.rewardRatio - cells[b]!.rewardRatio);
    for (const i of byRr) {
      const t = cells[i]!.testResults!;
      const cluster = `${t.totalPnlPercent}|${t.totalTrades}`;
      if (seen.has(cluster)) scored[i]!.dq = 'OLU_RR';
      else seen.add(cluster);
    }
  }

  const survivors: number[] = [];
  for (let i = 0; i < cells.length; i++) if (!scored[i]!.dq) survivors.push(i);

  if (survivors.length) {
    // Asama 2 — MAR tabanli ham skor (DD %5'ten asagi kirpilir: sifira bolunme onlenir)
    for (const i of survivors) {
      const c = cells[i]!;
      scored[i]!.marTest =
        c.testResults!.totalPnlPercent / Math.max(c.testResults!.maxDrawdownPercent, 5);
      scored[i]!.marTrain =
        c.trainResults!.totalPnlPercent / Math.max(c.trainResults!.maxDrawdownPercent, 5);
    }

    let marScale = median(survivors.map((i) => Math.abs(scored[i]!.marTest!)));
    if (!Number.isFinite(marScale) || marScale === 0) marScale = 1;

    for (const i of survivors) {
      const s = scored[i]!;
      const c = cells[i]!;
      const sharpeTerm = clamp(c.testResults!.sharpeRatio / 3, 0, 1) * marScale;
      s.rawScore = 0.65 * s.marTest! + 0.2 * s.marTrain! + 0.15 * sharpeTerm;

      // Asama 3 — guven carpani: 30 islem -> 0.55, 60 -> 0.77, 100+ -> 1.0
      s.confidence = Math.sqrt(Math.min(c.testResults!.totalTrades, 100) / 100);
      s.cellScore = s.rawScore * s.confidence;

      // Asama 3b — pencere istikrari: toplam test PnL'ini tek sansli pencere tasiyorsa
      // hucre one gecemesin. 8/8 -> x1.0, 4/8 -> x0.75, 0/8 -> x0.5.
      const wp = c.windowTestPnls;
      if (wp && wp.length >= 2) {
        const wins = c.windowsPositive ?? wp.filter((p) => p > 0).length;
        s.cellScore *= 0.5 + 0.5 * (wins / wp.length);
      }
    }

    // Asama 4 — plato: komsu havuzlama (dq'lular komsuluktan cikar) + istikrar cezasi
    for (const i of survivors) {
      const neighborScores: number[] = [];
      for (const j of survivors) {
        if (i !== j && isNeighbor(scored[i]!.idx, scored[j]!.idx)) {
          neighborScores.push(scored[j]!.cellScore!);
        }
      }
      const own = scored[i]!.cellScore!;
      let final = neighborScores.length
        ? 0.5 * own + (0.5 * neighborScores.reduce((s, v) => s + v, 0)) / neighborScores.length
        : own;

      const pool = [own, ...neighborScores];
      if (pool.length >= 2) {
        const mean = pool.reduce((s, v) => s + v, 0) / pool.length;
        const std = Math.sqrt(pool.reduce((s, v) => s + (v - mean) ** 2, 0) / pool.length);
        const cv = Math.abs(mean) < 1e-9 ? 1 : clamp(std / Math.abs(mean), 0, 1);
        final *= 1 - 0.3 * cv;
      }
      scored[i]!.finalScore = final;
    }
  }

  // Asama 5 — komsu sayimlari: cevresi mayin tarlasi olan hucre supheli, cevresi
  // saglam olan hucre plato. Promosyon kapisi ikisini de kullanir.
  for (let i = 0; i < cells.length; i++) {
    let dqN = 0;
    let okN = 0;
    for (let j = 0; j < cells.length; j++) {
      if (i === j || !isNeighbor(scored[i]!.idx, scored[j]!.idx)) continue;
      if (scored[j]!.dq) dqN++;
      else okN++;
    }
    scored[i]!.dqNeighborCount = dqN;
    scored[i]!.qualifiedNeighborCount = okN;
  }

  return scored;
}
