import fs from 'node:fs';
import { calculateMetrics } from '../engine/backtestMetrics';
import { DEFAULT_COSTS, type CostConfig } from '../engine/costModel';
import { assertCoverage, loadDataset } from '../engine/dataset';
import { DEFAULT_MIN_CONFIDENCE, DEFAULT_USE_TRAILING, cooldownMsFor } from '../engine/execConfig';
import { analyzeGates, type GateAnalysisResult } from '../engine/gateAnalysis';
import { buildMarketContext, type MarketContext } from '../engine/marketContext';
import { decisionPoints } from '../engine/backtest';
import { decideAt } from '../engine/signalRunner';
import { simulate, type RecordedDecision } from '../engine/simulator';
import { SandboxPool } from '../strategy/sandbox/host';
import { compileStrategy, validateStrategySource } from '../strategy/validator';
import { buildApiDts, toSandboxSource } from '../codex/workspace';
import { loadMeta } from '../strategy/loader';
import mechanicalV0 from '../strategy/builtin/mechanicalV0';
import { listModels, type ModelListing } from './models';
import { exitBreakdown } from './weakness';
import { fetchFearGreed, fetchPositioning, type FearGreedWindow, type PositioningWindow } from '../services/sentiment';
import { env, type CandleInterval } from '../config/env';
import type { WorkerInit } from '../strategy/sandbox/protocol';
import type { BacktestResults, BacktestTrade, StrategyProfile } from '../lib/types';

/**
 * ============================================================================
 * OTOPSI — "bu model bu pencerede neden coktu?"
 * ============================================================================
 *
 * Bu dosya YORUM YAPMAZ. Deterministik bir KANIT PAKETI uretir; hipotezi orchestrator'in
 * LLM'i kurar (agent/tools.ts -> agent/prompt.ts). Ayrim bilincli: bir sayinin nereden
 * geldigi her zaman izlenebilir olmali, ve ayni pencere iki kez sorulunca ayni cevabi
 * vermeli. "Model su yuzden coktu" cumlesi bir yargi; "su pencerede kayiplarin %70'i
 * tek sembolde ve BTC SMA200'un altindayken oldu" bir olcum.
 *
 * ---------------------------------------------------------------- ALTI YONTEM
 *
 *  A. PENCERE YENIDEN KOSUMU — model kendi hucresinde, verilen aralikta.
 *  B. ISLEM OTOPSISI       — MAE/MFE: giris hastaligi mi cikis hastaligi mi (weakness.ts).
 *  C. GATE BILANCOSU       — hangi filtre kac islem eledi, R cinsinden ne etti (gateAnalysis.ts).
 *  D. SEGMENT ATIFI        — kayip nerede yogunlasti: sembol / cikis / rejim / ay.
 *  E. PIYASA BAGLAMI       — rejim, volatilite, dispersiyon, korelasyon (+ opsiyonel sentiment).
 *  F. NUKS TARAMASI        — ayni pencere kutuphanedeki DIGER modellerde de mi cokuyor?
 *
 * F en degerlisi ve en cok atlanani: ayni pencerede her model cokuyorsa sorun modelde
 * DEGIL rejimdedir, ve "modeli duzelt" mudahalesi gecelerce bosa gider.
 */

const DAY_MS = 86_400_000;

export interface SegmentRow {
  key: string;
  trades: number;
  pnl: number;
  pnlR: number | null;
  winRate: number;
}

export interface AutopsySegments {
  bySymbol: SegmentRow[];
  byExitReason: SegmentRow[];
  byBtcRegime: SegmentRow[];
  byMonth: SegmentRow[];
  /**
   * Kaybin en yogunlastigi tek dilim — "kayiplarin %X'i burada" cumlesinin kaynagi.
   * Hicbir dilim baskin degilse null; uydurma bir sucluyu one surmemek icin.
   */
  worstConcentration: { dimension: string; key: string; shareOfLossPct: number } | null;
}

export interface RecurrenceRow {
  modelId: string;
  name: string;
  pnlPct: number | null;
  maxDDPct: number | null;
  trades: number;
  /** Kosulamadiysa nedeni — sessizce listeden dusurulmez. */
  error?: string;
}

export interface AutopsyResult {
  model: { id: string; name: string; origin: string; params: Record<string, number | boolean> };
  window: { from: number; to: number; days: number };

  /** A */
  results: BacktestResults;
  equityCurve: Array<{ timestamp: number; balance: number }>;
  trades: BacktestTrade[];
  /** B — weakness.ts'in teshis metni, bu pencerenin kosusu uzerinden. */
  weakness: string;
  /** C */
  gates: GateAnalysisResult | null;
  gatesError?: string;
  /** D */
  segments: AutopsySegments;
  /** E */
  market: MarketContext;
  fearGreed: FearGreedWindow | null;
  positioning: PositioningWindow[];
  /** F */
  recurrence: RecurrenceRow[];

  notes: string[];
}

export interface AutopsyArgs {
  /** listModels() id'si. Verilmezse builtin. */
  modelId?: string;
  from: number;
  to: number;
  symbols?: string[];
  interval?: CandleInterval;
  initialBalance?: number;
  profile?: StrategyProfile;
  costs?: CostConfig;
  /** F yontemi: kutuphanedeki diger modellerde de ayni pencereyi kos. */
  checkRecurrence?: boolean;
  /** E yontemi: dis kaynaklara (Fear&Greed, Binance konumlanma) git. */
  includeSentiment?: boolean;
  onProgress?: (stage: string, detail: string) => void;
}

/** Nuks taramasinda kosulacak azami model — her biri bir RECORD gecisi. */
const MAX_RECURRENCE_MODELS = 5;

export async function runAutopsy(args: AutopsyArgs): Promise<AutopsyResult> {
  const symbols = args.symbols ?? [...env.nightly.symbols];
  const interval = args.interval ?? env.nightly.interval;
  const initialBalance = args.initialBalance ?? 10_000;
  const profile = args.profile ?? 'balanced';
  const costs = args.costs ?? DEFAULT_COSTS;
  const notes: string[] = [];

  if (!(args.to > args.from)) throw new Error('otopsi penceresi gecersiz: `to` > `from` olmali');

  const models = await listModels();
  const model = await resolveModel(models, args.modelId);
  const params = resolvedParams(model);

  args.onProgress?.('veri', `${symbols.length} sembol, ${interval}`);
  const ds = loadDataset({ symbols, interval, startDate: args.from, endDate: args.to });

  try {
    assertCoverage(ds, { symbols, interval, startDate: args.from, endDate: args.to });

    // ---------------------------------------------------------------- A
    args.onProgress?.('yeniden kosum', model.name);
    const runOne = await runWindow({
      model,
      params,
      symbols,
      interval,
      from: args.from,
      to: args.to,
      initialBalance,
      profile,
      costs,
      dataset: ds,
    });

    // ---------------------------------------------------------------- B
    // weakness.ts bir ChallengeResult bekliyor; otopsi tek hucre kosuyor (grid yok).
    // Ihtiyac duydugu tek sey bestRun.trades + best.results, o yuzden minimal bir
    // sekil veriliyor — ikinci bir teshis fonksiyonu yazmak, iki gerceğe yol acardi.
    const { diagnoseWeakness } = await import('./weakness');
    const weakness = diagnoseWeakness({
      ok: true,
      codeSha256: '',
      selection: {
        bestRun: { trades: runOne.trades, equityCurve: runOne.equityCurve, skips: runOne.skips },
        best: { results: runOne.results },
      },
    } as unknown as Parameters<typeof diagnoseWeakness>[0]);

    // ---------------------------------------------------------------- C
    args.onProgress?.('gate bilancosu', model.name);
    let gates: GateAnalysisResult | null = null;
    let gatesError: string | undefined;
    try {
      gates = await analyzeGates({
        strategy: model.strategy,
        source: model.source,
        sandboxed: model.sandboxed,
        symbols,
        interval,
        startDate: args.from,
        endDate: args.to,
        initialBalance,
        profile,
        params,
        risk: model.listing.risk,
        costs,
        dataset: ds,
      });
    } catch (err) {
      // Gate bilancosu otopsinin BIR parcasi; dusmesi otopsinin tamamini dusurmemeli.
      gatesError = err instanceof Error ? err.message : String(err);
      notes.push(`gate bilancosu alinamadi: ${gatesError}`);
    }

    // ---------------------------------------------------------------- D
    const market = buildMarketContext({
      klines: ds.klines,
      indicators: ds.indicators,
      funding: ds.funding,
      symbols,
      interval,
      from: args.from,
      to: args.to,
    });
    const segments = segmentTrades(runOne.trades, market);

    // ---------------------------------------------------------------- E
    let fearGreed: FearGreedWindow | null = null;
    const positioning: PositioningWindow[] = [];
    if (args.includeSentiment) {
      args.onProgress?.('sentiment', 'fear&greed + konumlanma');
      fearGreed = await fetchFearGreed(args.from, args.to);
      for (const s of symbols.slice(0, 3)) {
        positioning.push(await fetchPositioning(s, args.from, args.to));
      }
    }

    // ---------------------------------------------------------------- F
    const recurrence: RecurrenceRow[] = [];
    if (args.checkRecurrence) {
      const others = models
        .filter((m) => m.id !== model.listing.id && m.runnable)
        .slice(0, MAX_RECURRENCE_MODELS);

      for (const other of others) {
        args.onProgress?.('nuks taramasi', other.name);
        try {
          const om = await resolveModel(models, other.id);
          const r = await runWindow({
            model: om,
            params: resolvedParams(om),
            symbols,
            interval,
            from: args.from,
            to: args.to,
            initialBalance,
            profile,
            costs,
            dataset: ds,
          });
          recurrence.push({
            modelId: other.id,
            name: other.name,
            pnlPct: r.results.totalPnlPercent,
            maxDDPct: r.results.maxDrawdownPercent,
            trades: r.results.totalTrades,
          });
        } catch (err) {
          // Kosulamayan model listeden DUSURULMEZ: "denendi, olmadi" ile "hic denenmedi"
          // farkli seyler ve nuks hipotezi kac modele bakildigina dayaniyor.
          recurrence.push({
            modelId: other.id,
            name: other.name,
            pnlPct: null,
            maxDDPct: null,
            trades: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      model: {
        id: model.listing.id,
        name: model.name,
        origin: model.listing.origin,
        params,
      },
      window: { from: args.from, to: args.to, days: Math.round((args.to - args.from) / DAY_MS) },
      results: runOne.results,
      equityCurve: runOne.equityCurve,
      trades: runOne.trades,
      weakness,
      gates,
      ...(gatesError ? { gatesError } : {}),
      segments,
      market,
      fearGreed,
      positioning,
      recurrence,
      notes: [...notes, ...market.notes],
    };
  } finally {
    ds.close();
  }
}

// ---------------------------------------------------------------- model cozumu

interface ResolvedModel {
  listing: ModelListing;
  name: string;
  source: string;
  sandboxed: boolean;
  strategy: Awaited<ReturnType<typeof loadMeta>>;
}

async function resolveModel(models: ModelListing[], id: string | undefined): Promise<ResolvedModel> {
  const listing = id ? models.find((m) => m.id === id) : models.find((m) => m.origin === 'builtin');
  if (!listing) throw new Error(`model bulunamadi: ${id ?? '(builtin)'}`);
  if (!listing.runnable) throw new Error(`${listing.name} kosulamaz: ${listing.blockedReason}`);

  const source = fs.readFileSync(listing.codePath, 'utf8');

  return {
    listing,
    name: listing.name,
    source,
    // Builtin BIZIM kodumuz — dogrudan cagrilabilir. Digerleri Codex'in yazdigi koddur
    // ve karar akisi HER ZAMAN vm realm'inden gecer.
    sandboxed: listing.origin !== 'builtin',
    // Sandbox'li modelde de meta LAZIM (parametre varsayilanlari, warmupBars). loadMeta
    // zaten izole bir realm'de yukleyip JSON ile yikayarak donduruyor (loader.ts:9),
    // yani burada aday kodu ana surece dokunmuyor. Onceden burada `undefined as never`
    // vardi ve builtin olmayan her modelde resolvedParams sessizce bos donuyordu.
    strategy: listing.origin === 'builtin' ? mechanicalV0() : await loadMeta(source),
  };
}

function resolvedParams(m: ResolvedModel): Record<string, number | boolean> {
  if (Object.keys(m.listing.params).length > 0) return m.listing.params;
  const out: Record<string, number | boolean> = {};
  for (const p of m.strategy.meta.params) out[p.key] = p.default;
  return out;
}

// ---------------------------------------------------------------- A: pencere kosumu

interface RunWindowArgs {
  model: ResolvedModel;
  params: Record<string, number | boolean>;
  symbols: string[];
  interval: CandleInterval;
  from: number;
  to: number;
  initialBalance: number;
  profile: StrategyProfile;
  costs: CostConfig;
  dataset: ReturnType<typeof loadDataset>;
}

/**
 * Modeli KENDI hucresinde, verilen pencerede kosar. Grid YOK.
 *
 * Otopsi bir arama degil bir INCELEME: "hangi parametre daha iyi olurdu" sorusu
 * backtest'in isi. Burada sorulan soru "uretimde kosan haliyle ne oldu" ve grid taramak
 * bu soruyu baska bir soruyla degistirirdi.
 */
async function runWindow(args: RunWindowArgs) {
  const points = decisionPoints(args.from, args.to, args.interval);
  const ds = args.dataset;
  let pool: SandboxPool | null = null;

  try {
    let decisions: RecordedDecision[];

    if (args.model.sandboxed) {
      const v = validateStrategySource(args.model.source);
      if (!v.ok) throw new Error(`kaynak dogrulanamadi: ${v.issues.map((i) => i.code).join(', ')}`);
      const c = compileStrategy(toSandboxSource(args.model.source), buildApiDts());
      if (!c.ok) throw new Error(`kaynak derlenemedi: ${c.diagnostics[0]?.message ?? '?'}`);

      const init: WorkerInit = {
        compiledJs: c.js!,
        symbols: args.symbols,
        interval: args.interval,
        points,
        klines: ds.klines,
        indicators: ds.indicators,
        funding: ds.funding,
      };
      pool = SandboxPool.create(init);
      decisions = await pool.run({
        cellIndex: 0,
        params: args.params,
        profile: args.profile,
        macroRiskAppetite: null,
      });
    } else {
      decisions = [];
      for (const at of points) {
        const d = decideAt({
          strategy: args.model.strategy,
          symbols: args.symbols,
          interval: args.interval,
          at,
          klines: ds.klines,
          indicators: ds.indicators,
          funding: ds.funding,
          lsr: ds.lsr,
          macroRiskAppetite: null,
          profile: args.profile,
          params: args.params,
        });
        if (d.allocations.length > 0 || d.rejections.length > 0) decisions.push(d);
      }
    }

    const run = simulate({
      decisions,
      klines: ds.klines,
      indicators: ds.indicators,
      funding: ds.funding,
      intrabar: ds.intrabar,
      risk: args.model.listing.risk,
      costs: args.costs,
      initialBalance: args.initialBalance,
      endDate: args.to,
      cooldownMs: cooldownMsFor(args.interval),
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      useTrailing: DEFAULT_USE_TRAILING,
    });

    return {
      ...run,
      results: calculateMetrics(run.trades, args.initialBalance, run.equityCurve),
    };
  } finally {
    await pool?.close();
  }
}

// ---------------------------------------------------------------- D: segment atifi

function segmentTrades(trades: BacktestTrade[], market: MarketContext): AutopsySegments {
  const bySymbol = group(trades, (t) => t.symbol);
  const byExitReason = group(trades, (t) => t.exitReason);
  const byBtcRegime = group(trades, (t) => regimeAt(market, t.entryTime));
  const byMonth = group(trades, (t) => new Date(t.entryTime).toISOString().slice(0, 7));

  return {
    bySymbol,
    byExitReason,
    byBtcRegime,
    byMonth,
    worstConcentration: concentration(trades, { sembol: bySymbol, cikis: byExitReason, rejim: byBtcRegime, ay: byMonth }),
  };
}

function group(trades: BacktestTrade[], key: (t: BacktestTrade) => string): SegmentRow[] {
  const buckets = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const arr = buckets.get(k);
    if (arr) arr.push(t);
    else buckets.set(k, [t]);
  }

  return [...buckets.entries()]
    .map(([k, rows]) => {
      const withR = rows.filter((t) => typeof t.pnlR === 'number');
      return {
        key: k,
        trades: rows.length,
        pnl: rows.reduce((s, t) => s + t.pnl, 0),
        // R toplami ancak islemlerin R'si varsa anlamli; yoksa null (0 DEGIL).
        pnlR: withR.length > 0 ? withR.reduce((s, t) => s + t.pnlR!, 0) : null,
        winRate: rows.length > 0 ? (rows.filter((t) => t.pnl > 0).length / rows.length) * 100 : 0,
      };
    })
    .sort((a, b) => a.pnl - b.pnl);
}

/** Kayiplarin belirli bir dilimde yogunlasmasi. Baskin dilim yoksa null. */
const CONCENTRATION_THRESHOLD_PCT = 45;

function concentration(
  trades: BacktestTrade[],
  dims: Record<string, SegmentRow[]>,
): AutopsySegments['worstConcentration'] {
  const totalLoss = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  if (totalLoss >= 0) return null;

  let best: AutopsySegments['worstConcentration'] = null;

  for (const [dimension, rows] of Object.entries(dims)) {
    // Tek dilimli bir boyut her zaman %100 yogunlasma gosterir ve hicbir sey soylemez.
    if (rows.length < 2) continue;
    for (const r of rows) {
      if (r.pnl >= 0) continue;
      const share = (r.pnl / totalLoss) * 100;
      if (share >= CONCENTRATION_THRESHOLD_PCT && (!best || share > best.shareOfLossPct)) {
        best = { dimension, key: r.key, shareOfLossPct: share };
      }
    }
  }

  return best;
}

function regimeAt(market: MarketContext, ts: number): string {
  const slice = market.regime.find((r) => ts >= r.from && ts <= r.to);
  return slice?.label ?? 'BILINMIYOR';
}

export { exitBreakdown };
