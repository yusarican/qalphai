import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { challenge } from '../engine/challenge';
import { DEFAULT_GRID, type GridSpec } from '../engine/backtest';
import { DEFAULT_COSTS, ZERO_COSTS } from '../engine/costModel';
import { ensureDataset } from '../engine/dataset';
import { DQ_LABELS, type DqReason } from '../engine/gridScoring';
import { loadChampionSource, readChampion } from '../orchestrator/champion';
import { loadMeta } from '../strategy/loader';
import mechanicalV0 from '../strategy/builtin/mechanicalV0';
import { DATA_DIR, env, type CandleInterval } from '../config/env';
import type { BacktestResults, StrategyProfile, WalkForwardVerdict } from '../lib/types';

/**
 * Panelden tetiklenen backtest'ler.
 *
 * Motorun GERCEK sinav yolunu (engine/challenge.ts) cagirir — panele ozel, daha yumusak
 * bir backtest YOKTUR. Panelde gordugun hukum (ROBUST/FRAGILE/FAILED), gece dongusunun
 * promosyon karari verirken baktigi hukumle ayni fonksiyondan cikar. Aksi halde panel,
 * sistemin kendisiyle celisen bir ikinci gercek uretirdi.
 *
 * Kosu AGIR (grid x walk-forward, dakikalar surer): HTTP istegi bekletilmez. POST bir is
 * baslatir ve id doner; ilerleme pollenir. Ayni anda TEK kosu — iki grid ayni CPU'da
 * birbirini ac birakir ve sonuclar (sure olcumleri) kirlenir.
 */

const RUNS_DIR = path.join(DATA_DIR, 'backtests');

export type JobStatus = 'running' | 'done' | 'failed';

export interface BacktestParams {
  symbols: string[];
  interval: CandleInterval;
  days: number;
  profile: StrategyProfile;
  initialBalance: number;
  /** true: maliyet modeli kapali — edge'in ne kadarini komisyonun yedigini olcmek icin. */
  noCosts: boolean;
  /** true: grid taranmaz, sampiyonun parametreleri sabitlenir. */
  fixedParams: boolean;
  /**
   * Operatorun kendi risk grid'i. Verilmezse DEFAULT_GRID taranir.
   *
   * Motor bunu zaten destekliyordu (challenge -> runBacktest -> buildRiskCells); tek eksik
   * HTTP ucuydu. Sabit bir grid, "sistem neyi ariyor" sorusunu operatore degil koda
   * sordurur — oysa hangi RR/SL bolgesinin denenmeye deger oldugu bir ARASTIRMA karari.
   * MAX_CELLS tavani hem HTTP ucunde (routes.ts, strateji ekseniyle CARPILMIS haliyle,
   * kosu baslamadan) hem runBacktest'te duruyor: cok buyuk bir grid anlamli hatayla duser,
   * sessizce kirpilmaz (kirpilsaydi panel, istenmeyen bir grid'in sonucunu istenen grid
   * diye gosterirdi).
   */
  grid?: GridSpec;
}

/** Grid ekseni — heatmap'in satir/sutun/panel/sayfa duzenini bu liste belirler. */
export interface GridAxis {
  name: string;
  values: Array<number | boolean>;
}

/**
 * Tek grid hucresinin PANEL icin sadelestirilmis hali.
 *
 * Neden tam BacktestResults degil: 1728 hucre x tam metrik seti onlarca MB'lik bir JSON
 * eder ve her poll'de tel uzerinden gecer. Burada heatmap'in ve tarama tablosunun
 * GOSTERDIGI alanlar var, fazlasi yok. Kazanan hucrenin tam metrikleri zaten `full`/`test`
 * alanlarinda duruyor.
 */
export interface GridCellRow {
  /** Eksen indeksleri — `axes` ile ayni sirada. Heatmap dilimlemeyi bunun uzerinden yapar. */
  idx: number[];
  /** Dolu ise hucre diskalifiye; skor alanlari null. */
  dq: string | null;
  /** Plato havuzlanmis final skor (gridScoring asama 4). Secim bunun argmax'i. */
  score: number | null;
  testPnlPct: number;
  testDDPct: number;
  testTrades: number;
  testWinRate: number;
  testSharpe: number;
  trainPnlPct: number;
  trainDDPct: number;
  fullPnlPct: number;
  /** Gune normalize TEST/TRAIN PnL orani. Train ~0 ise null. */
  testTrainRatio: number | null;
  windowsPositive: number;
  windowCount: number;
  /** Chebyshev kupundeki diskalifiye komsu sayisi — cevresi mayin tarlasi olan hucre supheli. */
  dqNeighbors: number;
}

export interface BacktestJob {
  id: string;
  status: JobStatus;
  params: BacktestParams;
  strategyName: string;
  startedAt: number;
  finishedAt?: number;
  /** Ilerleme: challenge asamalarindan gelir. */
  stage: string;
  done: number;
  total: number;
  error?: string;
  result?: BacktestRunResult;
}

export interface BacktestRunResult {
  id: string;
  strategyName: string;
  params: BacktestParams;
  startedAt: number;
  finishedAt: number;
  durationMs: number;

  verdict: WalkForwardVerdict;
  /** Kazanan hucre skorlama filtrelerini gecemedi -> en iyi cabaya dusuldu. */
  fallbackUsed: boolean;

  /** Tam donem (train + test). */
  full: BacktestResults;
  /** Secimde KULLANILMAYAN test dilimi — asil sayi budur. */
  test: BacktestResults;
  /** Fee x1.5 / slippage x2 altinda test dilimi. */
  stress: BacktestResults | null;
  /** Secim yolunun HIC gormedigi kasa penceresi. */
  holdout: BacktestResults | null;

  /** Kazanan hucre. */
  best: {
    params: Record<string, number | boolean>;
    risk: Record<string, number>;
    plateauScore: number | null;
    windowsPositive: number;
    windowCount: number;
    qualifiedNeighbors: number;
  };

  equityCurve: { timestamp: number; balance: number }[];
  trades: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryTime: number;
    exitTime: number;
    exitReason: string;
    leverage: number;
    pnl: number;
    pnlPercent: number;
    pnlR: number | null;
    confidence: number;
  }[];
  exitReasons: { reason: string; count: number }[];
  /** Girisin NEDEN atlandigi — bir stratejinin neden az islem actigini bu tablo anlatir. */
  skips: { rule: string; count: number }[];
  /** Grid hucreleri neden elendi. */
  disqualifications: { reason: string; label: string; count: number }[];
  gridCells: number;

  /**
   * Grid'in TAMAMI — heatmap ve parametre taramasi tablosu icin.
   *
   * Eskiden burada yalnizca kazanan hucre vardi ve panel "neden bu hucre" sorusuna
   * cevap veremiyordu. Plato, tek bir hucrenin ozelligi DEGIL — komsulariyla birlikte
   * anlamli. Kazanani gosterip komsulari saklamak, plato skorunu dogrulanamaz bir
   * iddiaya cevirir. Motor bu diziyi zaten uretiyordu (BacktestOutput.cells + scored);
   * sonuc nesnesi kurulurken atiliyordu.
   */
  axes: GridAxis[];
  cells: GridCellRow[];
  /** `cells` icindeki kazanan hucrenin indeksi. */
  bestIndex: number;
}

const jobs = new Map<string, BacktestJob>();
let running = false;

export function isRunning(): boolean {
  return running;
}

export function getJob(id: string): BacktestJob | null {
  return jobs.get(id) ?? null;
}

/** Bellekteki aktif isler + diske yazilmis gecmis kosular. */
export function listRuns(): Array<Pick<BacktestJob, 'id' | 'status' | 'params' | 'strategyName' | 'startedAt' | 'finishedAt'> & { verdict?: WalkForwardVerdict; testPnlPct?: number }> {
  const out = new Map<string, ReturnType<typeof listRuns>[number]>();

  if (fs.existsSync(RUNS_DIR)) {
    for (const f of fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')) as BacktestRunResult;
        out.set(r.id, {
          id: r.id,
          status: 'done',
          params: r.params,
          strategyName: r.strategyName,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          verdict: r.verdict,
          testPnlPct: r.test.totalPnlPercent,
        });
      } catch {
        // Yarim yazilmis sonuc — listeyi dusurme.
      }
    }
  }

  // Bellekteki is diskteki kaydi EZER: kosan/basarisiz is disk kaydindan tazedir.
  for (const j of jobs.values()) {
    out.set(j.id, {
      id: j.id,
      status: j.status,
      params: j.params,
      strategyName: j.strategyName,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      ...(j.result ? { verdict: j.result.verdict, testPnlPct: j.result.test.totalPnlPercent } : {}),
    });
  }

  return [...out.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function readRun(id: string): BacktestRunResult | null {
  const job = jobs.get(id);
  if (job?.result) return job.result;

  const file = path.join(RUNS_DIR, `${path.basename(id)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BacktestRunResult;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;

export function startBacktest(input: Partial<BacktestParams>): BacktestJob {
  if (running) throw new Error('Bir backtest zaten kosuyor — bitmesini bekle.');

  const params: BacktestParams = {
    symbols: input.symbols?.length ? input.symbols : [...env.nightly.symbols],
    interval: input.interval ?? env.nightly.interval,
    days: input.days ?? env.nightly.backtestDays,
    profile: input.profile ?? 'balanced',
    initialBalance: input.initialBalance ?? 10_000,
    noCosts: input.noCosts ?? false,
    fixedParams: input.fixedParams ?? false,
    // Verilmediyse alan HIC yazilmaz (undefined yerine yok) — sonuc JSON'u "grid: null"
    // diye kaydedip sonradan "operator bos grid istedi" gibi okunmasin.
    ...(input.grid ? { grid: input.grid } : {}),
  };

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

  const job: BacktestJob = {
    id,
    status: 'running',
    params,
    strategyName: readChampion()?.name ?? 'Mekanik Tier-Composite v0 (builtin)',
    startedAt: Date.now(),
    stage: 'baslatiliyor',
    done: 0,
    total: 0,
  };

  jobs.set(id, job);
  running = true;

  void execute(job)
    .catch((err) => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    })
    .finally(() => {
      running = false;
    });

  return job;
}

async function execute(job: BacktestJob): Promise<void> {
  const { params } = job;
  const rec = readChampion();

  // Sampiyon promote edilmisse ONUN kodu kosar (sha dogrulanarak); yoksa builtin v0.
  // Panel "hangi strateji" sorusunu asla belirsiz birakmamali — isim sonuca yazilir.
  const source = rec ? loadChampionSource(rec) : fs.readFileSync('src/strategy/builtin/mechanicalV0.ts', 'utf8');
  const strategy = rec ? await loadMeta(source) : mechanicalV0();

  const endDate = Date.now();
  const startDate = endDate - params.days * DAY_MS;

  // --- Veri senkronu. Gece dongusu bunu kendi yapiyor; panel yapmiyordu ve bu yuzden
  // cache'te olmayan bir mum araligi (ornegin 1h, cache'te yalnizca 4h varken) sifir
  // karar uretiyor, grid'in TUM hucreleri "20 islemden az" diye eleniyor ve kosu
  // stratejinin degil, verinin cokusunu FAILED olarak raporluyordu. Panelden secilen
  // her aralik, kosudan once indirilir.
  job.stage = 'veri';
  await ensureDataset({
    symbols: params.symbols,
    interval: params.interval,
    startDate,
    endDate,
    onProgress: (done, total) => {
      job.done = done;
      job.total = total;
    },
  });

  const res = await challenge({
    strategy,
    source,
    // Builtin bizim kodumuz — izole etmeye gerek yok. Promote edilmis aday Codex'in
    // yazdigi koddur ve HER ZAMAN sandbox'ta kosar.
    sandboxed: rec !== null,
    symbols: params.symbols,
    interval: params.interval,
    startDate,
    endDate,
    holdoutDays: env.nightly.holdoutDays,
    initialBalance: params.initialBalance,
    profile: params.profile,
    costs: params.noCosts ? ZERO_COSTS : DEFAULT_COSTS,
    grid: params.grid ?? DEFAULT_GRID,
    // "Grid'i atla, sampiyonun parametreleriyle kos". Sampiyon promote EDILMEMISSE
    // sampiyon builtin v0'dir ve onun parametreleri meta default'laridir — eskiden bu
    // durumda bayrak sessizce yutuluyor, grid yine taraniyordu ve panel gene de
    // "FIXED PARAMS" rozetini gosteriyordu. Panel, motorun yaptigindan baska bir sey
    // soylemez.
    ...(params.fixedParams ? { fixedParams: rec?.params ?? defaultParamsOf(strategy) } : {}),
    onProgress: (stage, done, total) => {
      job.stage = stage;
      job.done = done;
      job.total = total;
    },
  });

  if (!res.ok || !res.selection || !res.evaluated) {
    throw new Error(res.failure ?? 'backtest sonuc uretmedi');
  }

  const sel = res.selection;
  const best = sel.best;
  const run = sel.bestRun;

  const count = <T>(rows: T[], key: (t: T) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].map(([k, v]) => ({ reason: k, count: v })).sort((a, b) => b.count - a.count);
  };

  const dq = new Map<string, number>();
  for (const s of sel.scored ?? []) {
    if (s.dq) dq.set(s.dq, (dq.get(s.dq) ?? 0) + 1);
  }

  /*
   * Grid'in tamami. Sayilar burada YUVARLANIR (2 basamak): 1728 hucre x 12 alan tam
   * cift duyarlikta yazilirsa JSON birkac MB olur ve panelin gosterdigi hassasiyet
   * zaten iki basamak. Yuvarlama YALNIZCA gosterim icindir — secim, yuvarlanmamis
   * finalScore uzerinden motorda coktan yapildi (bestIndex onu tasiyor).
   */
  const r2 = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  const windowCount = sel.plan.windows.length;

  const cellRows: GridCellRow[] = sel.cells.map((c, i) => {
    const s = sel.scored?.[i];
    const test = c.testResults ?? c.results;
    const train = c.trainResults ?? c.results;
    return {
      idx: s?.idx ?? [],
      dq: s?.dq ?? null,
      score: s?.finalScore ?? null,
      testPnlPct: r2(test.totalPnlPercent),
      testDDPct: r2(test.maxDrawdownPercent),
      testTrades: test.totalTrades,
      testWinRate: r2(test.winRate),
      testSharpe: r2(test.sharpeRatio),
      trainPnlPct: r2(train.totalPnlPercent),
      trainDDPct: r2(train.maxDrawdownPercent),
      fullPnlPct: r2(c.results.totalPnlPercent),
      // null KORUNUR: "train ~0, oran tanimsiz" ile "oran sifir" ayri seylerdir.
      testTrainRatio: s?.testTrainRatio == null ? null : r2(s.testTrainRatio),
      windowsPositive: c.windowsPositive ?? 0,
      windowCount,
      dqNeighbors: s?.dqNeighborCount ?? 0,
    };
  });

  const finishedAt = Date.now();
  const result: BacktestRunResult = {
    id: job.id,
    strategyName: job.strategyName,
    params,
    startedAt: job.startedAt,
    finishedAt,
    durationMs: finishedAt - job.startedAt,

    verdict: sel.verdict,
    fallbackUsed: sel.fallbackUsed,

    full: best.results,
    test: res.evaluated.test,
    stress: res.stress ?? null,
    holdout: res.holdout ?? null,

    best: {
      params: best.params,
      risk: best.risk as unknown as Record<string, number>,
      plateauScore: best.plateauScore ?? null,
      windowsPositive: res.evaluated.windowsPositive,
      windowCount: res.evaluated.windowCount,
      qualifiedNeighbors: res.evaluated.qualifiedNeighbors,
    },

    // Equity egrisi buyuk olabilir; panel icin seyreltilir (max ~600 nokta).
    equityCurve: thin(run.equityCurve, 600),
    trades: run.trades.map((t) => ({
      symbol: t.symbol,
      side: t.side,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      exitReason: t.exitReason,
      leverage: t.leverage,
      pnl: t.pnl,
      pnlPercent: t.pnlPercent,
      pnlR: t.pnlR ?? null,
      confidence: t.confidence,
    })),
    exitReasons: count(run.trades, (t) => t.exitReason),
    skips: count(run.skips, (s) => s.rule).map((r) => ({ rule: r.reason, count: r.count })),
    disqualifications: [...dq.entries()]
      .map(([reason, c]) => ({ reason, label: DQ_LABELS[reason as DqReason] ?? reason, count: c }))
      .sort((a, b) => b.count - a.count),
    gridCells: sel.cells.length,

    axes: sel.axes.map((a) => ({ name: a.name, values: [...a.values] })),
    cells: cellRows,
    bestIndex: sel.bestIndex,
  };

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, `${job.id}.json`), JSON.stringify(result, null, 2));

  job.result = result;
  job.status = 'done';
  job.finishedAt = finishedAt;
  job.stage = 'bitti';
}

/** Stratejinin meta default'lari — promote edilmemis builtin sampiyonun "kendi" parametreleri. */
function defaultParamsOf(strategy: { meta: { params: ReadonlyArray<{ key: string; default: number | boolean }> } }): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const p of strategy.meta.params) out[p.key] = p.default;
  return out;
}

/** Egriyi noktalari ATLAYARAK degil, ESIT ARALIKLA seyreltir; son nokta HER ZAMAN korunur. */
function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows[rows.length - 1]);
  return out;
}
