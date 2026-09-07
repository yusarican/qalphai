import { decisionPoints } from './backtest';
import { calculateMetrics } from './backtestMetrics';
import { DEFAULT_COSTS, type CostConfig } from './costModel';
import { loadDataset, type Dataset } from './dataset';
import { DEFAULT_MIN_CONFIDENCE, DEFAULT_USE_TRAILING, cooldownMsFor } from './execConfig';
import { decideAt } from './signalRunner';
import { simulate, type RecordedDecision } from './simulator';
import { DEFAULT_RISK_PARAMS, type RiskParams } from './riskManagement';
import { SandboxPool } from '../strategy/sandbox/host';
import { compileStrategy, validateStrategySource } from '../strategy/validator';
import { buildApiDts, toSandboxSource } from '../codex/workspace';
import type { WorkerInit } from '../strategy/sandbox/protocol';
import type { CandleInterval } from '../config/env';
import type { BacktestResults, StrategyProfile } from '../lib/types';
import type { Strategy } from '../strategy/types';

/**
 * ============================================================================
 * GATE BILANCOSU — "bu filtre bize ne kazandiriyor, ne kaybettiriyor?"
 * ============================================================================
 *
 * Bu dosya, sistemin Codex'e VERDIGI ama tutmadigi bir sozu tutuyor.
 * strategy/types.ts:182 ve codex/prompts.ts:61 su cumleyi iceriyor:
 *
 *   "Bu bos bir log degil: sistem her veto kurali icin karsi-olgusal kosar ve
 *    filtrenin sana kar mi kaybettirdigini R cinsinden raporlar."
 *
 * Bu kod hicbir zaman yazilmamisti (referans implementasyondaki backtestAnalysis'ten
 * kalma bir yorumdu). Yani her gece Codex'e "anlamli veto kurallari yaz, olculecekler"
 * diyorduk ve hicbirini olcmuyorduk. Geri bildirim dongusu burada kapaniyor.
 *
 * ---------------------------------------------------------------- YONTEM
 *
 * Bir veto'yu "kaldirmak" icin KODU DEGISTIRMEYE GEREK YOK. StrategyVeto zaten
 * `wouldBe` tasiyor — sozlesme tam olarak bu olcum icin boyle tasarlanmisti. RECORD
 * gecisinde kurali kaldirip karari sinyale ceviriyoruz (signalRunner.liftVeto); allocate,
 * simulator, maliyet modeli, intrabar cozumu — hicbiri degismiyor.
 *
 * Maliyet: kural basina BIR record gecisi. REPLAY zaten bedava (backtest.ts:19).
 *
 * ---------------------------------------------------------------- DURUSTLUK
 *
 * Uc yerde uydurma yapmamak icin ozel caba:
 *
 *  1. **Guven degeri bir VARSAYIMDIR.** Vetolanmis bir barda strateji hicbir zaman bir
 *     confidence uretmedi. Modelin KENDI sinyallerinin medyanini kullaniyoruz ve bunu
 *     sonuca yaziyoruz (`liftedConfidence` + `liftedConfidenceSource`). Panelde ve
 *     raporda gorunmesi sart: bu sayi degisirse karsi-olgu da degisir.
 *
 *  2. **`wouldBe` tasimayan kuralin karsi-olgusu YOKTUR.** Yon bilinmiyorsa uydurulmaz;
 *     `counterfactual: null` doner ve nedeni `note`ta yazar. Bu, Codex'e "veto'na
 *     wouldBe koy" demenin somut karsiligi.
 *
 *  3. **Harness kapilari SIMULATORE DOKUNULMADAN olculur** — girdileri degistirerek
 *     (minConfidence=0, cooldownMs=0, riskCap=1). MIN_MARGIN simulatorde sabit kodlu
 *     ve NO_ATR_SIZING bir POLITIKA degil VERI eksikligi; ikisi de sayilir ama
 *     karsi-olgusu alinmaz.
 */

/** Simulatorde girdisi degistirilerek kaldirilabilen harness kapilari. */
const LIFTABLE_HARNESS_GATES = ['MIN_CONF', 'COOLDOWN', 'RISK_CAP'] as const;

/** Sayilir ama karsi-olgusu ALINMAZ — nedeni her biri icin ayri. */
const UNLIFTABLE_HARNESS_GATES: Record<string, string> = {
  MIN_MARGIN: 'simulatorde sabit kodlu esik ($5 margin tabani) — bir politika kolu degil',
  NO_ATR_SIZING: 'veri eksikligi (ATR yok), politika degil — kaldirmak pozisyon buyuklugunu hesaplanamaz kilar',
  ALLOCATION_CAP: 'portfoy tahsis tavani allocate() icinde; profile degistirmeden kaldirilamaz',
  INVALID_CONFIDENCE: 'sozlesme ihlali savunmasi — kaldirilmasi anlamsiz',
};

export interface GateCounterfactual {
  /** Gate OLMASAYDI PnL yuzdesi ne kadar degisirdi (+ = gate kaybettiriyor). */
  deltaPnlPct: number;
  deltaExpectancyR: number;
  /** + = gate olmasaydi drawdown ARTARDI, yani gate koruyor. */
  deltaMaxDDPct: number;
  deltaTrades: number;
  /** Gate olmadan kosunun kendi metrikleri — rapor icin. */
  without: BacktestResults;
  verdict: 'KORUYOR' | 'KAYBETTIRIYOR' | 'NOTR';
}

export interface GateBalance {
  rule: string;
  kind: 'strategy-veto' | 'harness-skip';
  /** Kural kac kez tetiklendi (kac giris adayini eledi). */
  firedCount: number;
  /** Kacini yon bilgisiyle eledi — karsi-olgusu ancak bunlar icin alinabilir. */
  directionalCount: number;
  counterfactual: GateCounterfactual | null;
  /** Karsi-olgu alinamadiysa nedeni. */
  note?: string;
}

export interface GateAnalysisResult {
  baseline: BacktestResults;
  /**
   * Temel kosu bir KIYAS TABANI olarak kullanilabilir mi?
   *
   * false ise `gates` icindeki her hukum anlamsizdir ve OYLE OKUNMALIDIR — bkz.
   * `warnings`. Bu alan olmadan rapor, likide olmus bir hesabin uzerinde "her gate
   * NOTR" diye okunuyordu: -%100 bir TABANDIR, gate kaldirmak onu daha kotu yapamaz,
   * dolayisiyla tum deltalar sifira kirpilir. Sessiz bir sifir, olculmemis bir seyi
   * "olctuk ve etkisiz" diye raporlamak olurdu.
   */
  baselineUsable: boolean;
  warnings: string[];
  gates: GateBalance[];
  /** Kaldirilan veto'lara atanan guven — bir VARSAYIM, rapora yazilmali. */
  liftedConfidence: number;
  liftedConfidenceSource: 'medyan-sinyal' | 'varsayilan';
  /** Kac ek RECORD gecisi kosuldu — maliyet seffafligi. */
  recordPasses: number;
  window: { startDate: number; endDate: number };
}

export interface GateAnalysisArgs {
  strategy: Strategy;
  source: string;
  /** true = Codex adayi, vm realm'inde kosar. false = builtin (bizim kodumuz). */
  sandboxed: boolean;

  symbols: string[];
  interval: CandleInterval;
  startDate: number;
  endDate: number;
  initialBalance: number;
  profile: StrategyProfile;

  /** Modelin KENDI hucresi. Gate bilancosu bir grid taramasi degil, tek hucre analizidir. */
  params: Record<string, number | boolean>;
  risk?: RiskParams;
  costs?: CostConfig;

  /** Yalnizca bu kurallari olc. Verilmezse tetiklenen TUM kurallar. */
  onlyRules?: string[];
  /** Verilirse veri yeniden yuklenmez (otopsi ayni dataset'i birden cok kez kullanir). */
  dataset?: Dataset;

  onProgress?: (done: number, total: number, rule: string) => void;
}

const MIN_FIRED_TO_MEASURE = 3;
/** Temelin kiyas tabani sayilabilmesi icin gereken asgari islem. */
const MIN_BASELINE_TRADES = 20;
const NOTR_BAND_PCT = 0.5;

export async function analyzeGates(args: GateAnalysisArgs): Promise<GateAnalysisResult> {
  const costs = args.costs ?? DEFAULT_COSTS;
  const risk = args.risk ?? DEFAULT_RISK_PARAMS;
  const points = decisionPoints(args.startDate, args.endDate, args.interval);
  const cooldownMs = cooldownMsFor(args.interval);

  const ownDataset = !args.dataset;
  const ds =
    args.dataset ??
    loadDataset({
      symbols: args.symbols,
      interval: args.interval,
      startDate: args.startDate,
      endDate: args.endDate,
    });

  let pool: SandboxPool | null = null;

  try {
    if (args.sandboxed) {
      // Aday kodu DOGRUDAN cagrilamaz: once dogrulama, sonra derleme, sonra realm.
      // challenge.ts:97 ile ayni sira — burada da atlanmaz.
      const v = validateStrategySource(args.source);
      if (!v.ok) {
        throw new Error(
          `gate analizi icin kaynak dogrulanamadi: ${v.issues.map((i) => i.code).join(', ')}`,
        );
      }
      const c = compileStrategy(toSandboxSource(args.source), buildApiDts());
      if (!c.ok) {
        throw new Error(`gate analizi icin kaynak derlenemedi: ${c.diagnostics[0]?.message ?? '?'}`);
      }

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
    }

    /**
     * Kaldirilan veto'lara atanacak guven. `record`'dan ONCE bildirilir ama degeri
     * ANCAK temel kosudan sonra bilinir: medyan, modelin kendi sinyallerinden cikar.
     * Sira boyle: once kaldirmasiz olc, sonra varsay, sonra kaldirarak olc.
     */
    let liftedConf = 0.5;
    let liftedSource: GateAnalysisResult['liftedConfidenceSource'] = 'varsayilan';

    const record = async (lifted?: string[]): Promise<RecordedDecision[]> => {
      if (pool) {
        return pool.run({
          cellIndex: 0,
          params: args.params,
          profile: args.profile,
          macroRiskAppetite: null,
          ...(lifted ? { liftedVetoRules: lifted, liftedConfidence: liftedConf } : {}),
        });
      }
      const out: RecordedDecision[] = [];
      const liftedSet = lifted ? new Set(lifted) : undefined;
      for (const at of points) {
        const d = decideAt({
          strategy: args.strategy,
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
          ...(liftedSet ? { liftedVetoRules: liftedSet, liftedConfidence: liftedConf } : {}),
        });
        if (d.allocations.length > 0 || d.rejections.length > 0) out.push(d);
      }
      return out;
    };

    const replay = (decisions: RecordedDecision[], over?: Partial<Parameters<typeof simulate>[0]>) => {
      const run = simulate({
        decisions,
        klines: ds.klines,
        indicators: ds.indicators,
        funding: ds.funding,
        intrabar: ds.intrabar,
        risk,
        costs,
        initialBalance: args.initialBalance,
        endDate: args.endDate,
        cooldownMs,
        minConfidence: DEFAULT_MIN_CONFIDENCE,
        useTrailing: DEFAULT_USE_TRAILING,
        ...over,
      });
      return {
        run,
        results: calculateMetrics(run.trades, args.initialBalance, run.equityCurve),
      };
    };

    // ---------------------------------------------------------------- 1. TEMEL KOSU
    const baseDecisions = await record();
    const base = replay(baseDecisions);

    const confidences = baseDecisions
      .flatMap((d) => d.allocations.map((a) => a.confidence))
      .filter((c) => Number.isFinite(c))
      .sort((a, b) => a - b);

    if (confidences.length > 0) {
      liftedConf = confidences[Math.floor(confidences.length / 2)]!;
      liftedSource = 'medyan-sinyal';
    }

    // ---------------------------------------------------------------- 2. KURAL SAYIMI
    const vetoStats = new Map<string, { fired: number; directional: number }>();
    for (const d of baseDecisions) {
      for (const r of d.rejections) {
        const s = vetoStats.get(r.rule) ?? { fired: 0, directional: 0 };
        s.fired++;
        if (r.side === 'LONG' || r.side === 'SHORT') s.directional++;
        vetoStats.set(r.rule, s);
      }
    }

    const harnessStats = new Map<string, number>();
    for (const s of base.run.skips) harnessStats.set(s.rule, (harnessStats.get(s.rule) ?? 0) + 1);

    const wanted = args.onlyRules ? new Set(args.onlyRules) : null;
    const gates: GateBalance[] = [];

    // ---------------------------------------------------------------- 3. STRATEJI VETO'LARI
    const strategyRules = [...vetoStats.entries()]
      .filter(([rule]) => !wanted || wanted.has(rule))
      // Harness'in kendi urettigi red kodlari (allocate/signalRunner) strateji veto'su
      // DEGILDIR; asagida ayri baslikta ele alinirlar.
      .filter(([rule]) => !(rule in UNLIFTABLE_HARNESS_GATES))
      .sort((a, b) => b[1].fired - a[1].fired);

    let passes = 0;
    const total = strategyRules.length + LIFTABLE_HARNESS_GATES.filter((g) => harnessStats.has(g)).length;

    for (const [rule, stat] of strategyRules) {
      args.onProgress?.(passes, total, rule);

      if (stat.directional === 0) {
        gates.push({
          rule,
          kind: 'strategy-veto',
          firedCount: stat.fired,
          directionalCount: 0,
          counterfactual: null,
          note:
            'veto `wouldBe` tasimiyor — hangi yonde girilecegi bilinmedigi icin karsi-olgu ' +
            'UYDURULAMAZ. Bu kuralin olculebilmesi icin stratejinin veto\'suna wouldBe eklenmeli.',
        });
        continue;
      }

      if (stat.fired < MIN_FIRED_TO_MEASURE) {
        gates.push({
          rule,
          kind: 'strategy-veto',
          firedCount: stat.fired,
          directionalCount: stat.directional,
          counterfactual: null,
          note: `yalnizca ${stat.fired} kez tetiklendi (esik ${MIN_FIRED_TO_MEASURE}) — olcum gurultuden ibaret olurdu`,
        });
        continue;
      }

      const lifted = await record([rule]);
      passes++;
      const without = replay(lifted);
      gates.push(makeBalance(rule, 'strategy-veto', stat.fired, stat.directional, base.results, without.results));
    }

    // ---------------------------------------------------------------- 4. HARNESS KAPILARI
    //
    // Simulatorun KODUNA dokunulmuyor; yalnizca GIRDISI degistiriliyor. Bu, olcumun
    // olculen seyi degistirmemesini garanti eder — canlida kosan kapi sirasi ayni kalir
    // (livePlan.ts ile paritenin bozulmamasi icin sart).
    for (const gate of LIFTABLE_HARNESS_GATES) {
      const fired = harnessStats.get(gate) ?? 0;
      if (fired === 0 || (wanted && !wanted.has(gate))) continue;

      args.onProgress?.(passes, total, gate);
      const over =
        gate === 'MIN_CONF'
          ? { minConfidence: 0 }
          : gate === 'COOLDOWN'
            ? { cooldownMs: 0 }
            : { risk: { ...risk, maxPortfolioRiskPct: 1 } };

      const without = replay(baseDecisions, over);
      gates.push(makeBalance(gate, 'harness-skip', fired, fired, base.results, without.results));
    }

    for (const [gate, why] of Object.entries(UNLIFTABLE_HARNESS_GATES)) {
      const fired = (harnessStats.get(gate) ?? 0) + (vetoStats.get(gate)?.fired ?? 0);
      if (fired === 0 || (wanted && !wanted.has(gate))) continue;
      gates.push({
        rule: gate,
        kind: 'harness-skip',
        firedCount: fired,
        directionalCount: fired,
        counterfactual: null,
        note: why,
      });
    }

    gates.sort((a, b) => {
      const av = Math.abs(a.counterfactual?.deltaPnlPct ?? -1);
      const bv = Math.abs(b.counterfactual?.deltaPnlPct ?? -1);
      if (av !== bv) return bv - av;
      return b.firedCount - a.firedCount;
    });

    const { usable, warnings } = judgeBaseline(base.results);

    return {
      baseline: base.results,
      baselineUsable: usable,
      warnings,
      gates,
      liftedConfidence: liftedConf,
      liftedConfidenceSource: liftedSource,
      recordPasses: passes,
      window: { startDate: args.startDate, endDate: args.endDate },
    };
  } finally {
    await pool?.close();
    if (ownDataset) ds.close();
  }
}

function makeBalance(
  rule: string,
  kind: GateBalance['kind'],
  fired: number,
  directional: number,
  base: BacktestResults,
  without: BacktestResults,
): GateBalance {
  const deltaPnlPct = without.totalPnlPercent - base.totalPnlPercent;

  return {
    rule,
    kind,
    firedCount: fired,
    directionalCount: directional,
    counterfactual: {
      deltaPnlPct,
      deltaExpectancyR: without.expectancyR - base.expectancyR,
      deltaMaxDDPct: without.maxDrawdownPercent - base.maxDrawdownPercent,
      deltaTrades: without.totalTrades - base.totalTrades,
      without,
      // Isaret KONVANSIYONU: delta, "gate OLMASAYDI" kosusunun temelden farki.
      // Pozitif delta = gate olmadan daha iyiydik = gate KAYBETTIRIYOR.
      verdict:
        deltaPnlPct > NOTR_BAND_PCT
          ? 'KAYBETTIRIYOR'
          : deltaPnlPct < -NOTR_BAND_PCT
            ? 'KORUYOR'
            : 'NOTR',
    },
  };
}


/**
 * Temel kosu bir kiyas tabani olabilir mi?
 *
 * Bu fonksiyon, bu dosyanin en kolay atlanacak ama en pahali hatasini yakaliyor.
 * Karsi-olgusal olcum bir FARK olcumudur; farkin anlamli olmasi icin temelin
 * hareket edebilecek bir yerde durmasi gerekir.
 *
 *  - Hesap likide olduysa (-%100) taban CAKILMISTIR: gate kaldirmak onu daha kotu
 *    yapamaz, tum negatif deltalar sifira kirpilir ve her gate "NOTR" gorunur.
 *    Bu, DEFAULT_RISK_PARAMS'in %5 islem riskiyle mekanik v0'da gercekten olan sey
 *    (bkz. engine/backtest.ts:55-66 — ayni preset grid'in 1728 hucresinin 1706'sini
 *    eliyordu).
 *  - Islem sayisi cok dusukse fark gurultudur.
 */
function judgeBaseline(base: BacktestResults): { usable: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let usable = true;

  if (base.totalPnlPercent <= -99 || base.maxDrawdownPercent >= 99.5) {
    usable = false;
    warnings.push(
      `TEMEL KOSU LIKIDE OLDU (PnL %${base.totalPnlPercent.toFixed(1)}, DD ` +
        `%${base.maxDrawdownPercent.toFixed(1)}). -%100 bir TABANDIR: hicbir gate ` +
        `kaldirmasi bunu daha kotu yapamaz, bu yuzden tum karsi-olgu deltalari sifira ` +
        `kirpilir ve hukumler ANLAMSIZDIR. Once calisir bir risk hucresi secin ` +
        `(islem basina risk dusurun) ve olcumu tekrarlayin.`,
    );
  }

  if (base.totalTrades < MIN_BASELINE_TRADES) {
    usable = false;
    warnings.push(
      `temel kosuda yalnizca ${base.totalTrades} islem var (esik ${MIN_BASELINE_TRADES}) — ` +
        `gate karsi-olgulari gurultuden ayirt edilemez`,
    );
  }

  return { usable, warnings };
}

/**
 * Gate bilancosunun olculecegi risk hucresini secer.
 *
 * BU FONKSIYON, BU DOSYANIN EN KOLAY ATLANAN TUZAGINI KAPATIYOR.
 *
 * `DEFAULT_RISK_PARAMS` "agresif preset"tir: islem basina %5 risk (riskManagement.ts:7).
 * Mekanik v0 bu hucrede hesabi likide ediyor — engine/backtest.ts:55-66 tam olarak bunu
 * anlatiyor: ayni preset grid'in 1728 hucresinin 1706'sini TEST_DD>%40'tan eliyordu.
 *
 * Likide olmus bir tabanda karsi-olgusal olcum ANLAMSIZDIR: -%100 bir TABANDIR, hicbir
 * gate kaldirmasi onu daha kotu yapamaz, tum negatif deltalar sifira kirpilir ve her
 * gate "NOTR" gorunur. Yani olcum calisiyor gibi durur ve hicbir sey soylemez.
 *
 * Kapiyi gecmis bir modelin KENDI risk hucresi vardir ve o kullanilir. Builtin'in yoktur
 * (models.ts:317 ona DEFAULT_RISK_PARAMS veriyor, cunku "kayitli hucresi yok" demenin
 * baska bir yolu yok). O durumda muhafazakar bir taban secilir ve bu SOYLENIR — sessizce
 * baska bir hucrede olcup sonucu "modelin gate bilancosu" diye sunmak, raporun neyi
 * olctugu hakkinda yalan olurdu.
 */
export const CONSERVATIVE_RISK_PER_TRADE = 0.01;

export interface ChosenRisk {
  risk: RiskParams;
  /** Rapora AYNEN yazilir: hangi hucrede olctuk ve neden. */
  note: string;
}

export function chooseAnalysisRisk(args: {
  risk: RiskParams;
  /** Modelin kayitli bir hucresi var mi? (kapidan gecmis / elle degerlendirilmis) */
  hasRecordedCell: boolean;
  override?: number;
}): ChosenRisk {
  if (args.override !== undefined) {
    return {
      risk: scaled(args.risk, args.override),
      note: `islem basina %${(args.override * 100).toFixed(1)} — elle verildi`,
    };
  }

  if (args.hasRecordedCell) {
    return {
      risk: args.risk,
      note: `islem basina %${(args.risk.riskPerTradePct * 100).toFixed(1)} — modelin kendi kayitli hucresi`,
    };
  }

  return {
    risk: scaled(args.risk, CONSERVATIVE_RISK_PER_TRADE),
    note:
      `islem basina %${(CONSERVATIVE_RISK_PER_TRADE * 100).toFixed(1)} — modelin kayitli risk ` +
      `hucresi YOK, muhafazakar taban secildi (varsayilan %5 preset tabani likide ediyor ve ` +
      `karsi-olgusal olcumu anlamsiz kilardi)`,
  };
}

function scaled(base: RiskParams, riskPerTradePct: number): RiskParams {
  return {
    ...base,
    riskPerTradePct,
    // Portfoy tavani islem riskiyle olceklenir — backtest.ts:buildRiskCells ile ayni kural.
    maxPortfolioRiskPct: Math.min(0.15, riskPerTradePct * 4),
  };
}
