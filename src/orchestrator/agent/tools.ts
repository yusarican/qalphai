import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runExclusive } from '../../engine/computeQueue';
import { analyzeGates, chooseAnalysisRisk } from '../../engine/gateAnalysis';
import { DEFAULT_COSTS } from '../../engine/costModel';
import { challenge, judge } from '../../engine/challenge';
import { loadDataset, assertCoverage, ensureDataset } from '../../engine/dataset';
import { computeLiveStats, readTrades } from '../../lib/tradeLog';
import { readRun as readBacktestRun } from '../../api/backtestJobs';
import { detectGates, gateSurgery } from '../../strategy/gateSurgery';
import { loadMeta } from '../../strategy/loader';
import { CodexDriver } from '../../codex/driver';
import { createWorkspace, destroyWorkspace, extractCandidate } from '../../codex/workspace';
import { buildRefineBrief } from '../../codex/prompts';
import { webSearch, webSearchConfigured } from '../../lib/webSearch';
import mechanicalV0 from '../../strategy/builtin/mechanicalV0';
import { runAutopsy } from '../autopsy';
import { addDirective, revokeDirective, readDirectives, DIRECTIVE_TARGETS } from '../directives';
import { buildCandidateEvaluation, listModels, saveCandidateEvaluation } from '../models';
import { readChampion } from '../champion';
import { diagnoseWeakness } from '../weakness';
import { env, REPORTS_DIR, STRATEGIES_DIR, type CandleInterval } from '../../config/env';
import type { StrategyProfile } from '../../lib/types';
import type { JsonSchema, ToolSpec } from '../../lib/agentLlm';
import type { OrchestratorRun } from './state';

/**
 * ============================================================================
 * ORCHESTRATOR TOOL'LARI — ust aklin motora baktigi TIPLI pencere.
 * ============================================================================
 *
 * Her tool dogrudan bir motor fonksiyonunu cagirir. Orchestrator'a ozel, daha yumusak
 * bir yol YOKTUR: backtest challenge()'dan, gate bilancosu analyzeGates()'ten, aday
 * kaydi buildCandidateEvaluation()'dan gecer — panelin ve gece dongusunun kullandigi
 * fonksiyonlarin aynisi. Aksi halde panel, gece ve orchestrator ayni model hakkinda
 * uc farkli gercek anlatirdi.
 *
 * ---------------------------------------------------------------- YETKI SINIRI
 *
 * >>> `activate_model` DIYE BIR TOOL YOK VE OLMAYACAK. <<<
 *
 * Orchestrator model URETIR, olcer, raporlar — canliya ALMAZ. Urettigi aday
 * `strategies/candidates/<runId>/` altina yazilir; listModels() (models.ts:330) o
 * dizini zaten tariyor, yani model panelin /models sayfasinda kendiliginden gorunur ve
 * aktivasyon operatorun bilincli, iki tiklik karari olarak kalir.
 *
 * Bu bir prompt ricasi degil, YAPISAL bir kisit: tool listesinde olmayan bir sey
 * cagrilamaz.
 */

export interface ToolContext {
  run: OrchestratorRun;
  /** Frenler — loop.ts bunlari kosu boyunca gunceller. */
  budget: { backtestsLeft: number };
}

export interface ToolDef {
  spec: ToolSpec;
  /** Modele donen metin. Buyuk nesneler OZETLENIR — ham JSON token butcesini yer. */
  run: (input: unknown, ctx: ToolContext) => Promise<string>;
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- yardimcilar

const obj = (props: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties: props,
  required,
});

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

/** ISO tarih ya da ms damgasi kabul eder — model ikisini de uretebiliyor. */
function parseWhen(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------- OKUMA

const listModelsTool: ToolDef = {
  spec: {
    name: 'list_models',
    description:
      'Kutuphanedeki TUM modeller: builtin, gecmis sampiyonlar, degerlendirilmis adaylar. ' +
      'Her satirda kapinin hukmu (gate), degerlendirme metrikleri ve canliya alinabilir ' +
      'olup olmadigi var. Baslangic noktasi olarak bunu cagir.',
    schema: obj({}),
  },
  async run() {
    const models = await listModels();
    if (models.length === 0) return 'Kutuphane bos.';

    return models
      .map((m) => {
        const e = m.evaluation;
        const g = m.gate;
        return [
          `- id: ${m.id}`,
          `  ad: ${m.name} | kaynak: ${m.origin}${m.isChampion ? ' | CANLIDA' : ''}`,
          `  kosulabilir: ${m.runnable}${m.blockedReason ? ` (${m.blockedReason})` : ''}`,
          e
            ? `  test: ${pct(e.testPnlPct)} PnL, MAR ${e.testMar.toFixed(2)}, DD %${e.testMaxDDPct.toFixed(1)}, ` +
              `${e.testTrades} islem, ${e.windowsPositive}/${e.windowCount} pencere pozitif, ` +
              `stres ${pct(e.stressPnlPct)}, kasa ${pct(e.holdoutPnlPct)}`
            : '  degerlendirme: YOK (hicbir kapidan gecmedi)',
          g
            ? `  kapi: ${g.promote ? 'GECER' : 'GECMEZ'}${g.blockers.length ? ` | engeller: ${g.blockers.join('; ')}` : ''}`
            : '  kapi: hukum yok',
          `  parametreler: ${JSON.stringify(m.params)}`,
        ].join('\n');
      })
      .join('\n\n');
  },
};

const readModelSourceTool: ToolDef = {
  spec: {
    name: 'read_model_source',
    description:
      'Bir modelin TypeScript kaynagini okur. Codex\'in ne yazdigini gormek, gozunden ' +
      'kacani bulmak ve hangi gate\'lerin var oldugunu anlamak icin. Ayrica tespit edilen ' +
      'veto (gate) noktalarini ve her birinin mekanik olarak kaldirilabilir olup ' +
      'olmadigini dondurur.',
    schema: obj({ modelId: str('list_models\'ten gelen id') }, ['modelId']),
  },
  async run(input) {
    const { modelId } = z.object({ modelId: z.string() }).parse(input);
    const m = (await listModels()).find((x) => x.id === modelId);
    if (!m) throw new Error(`model bulunamadi: ${modelId}`);

    const source = fs.readFileSync(m.codePath, 'utf8');
    const gates = detectGates(source);

    const gateList = gates.length
      ? gates
          .map(
            (g) =>
              `  - ${g.rule} (satir ${g.line}) | yon bilgisi: ${g.hasDirection ? 'var' : 'YOK'} | ` +
              `mekanik kaldirilabilir: ${g.removable}${g.reason ? ` (${g.reason})` : ''}`,
          )
          .join('\n')
      : '  (veto kurali yok)';

    return `# ${m.name} (${m.id})\n\nTESPIT EDILEN GATE'LER:\n${gateList}\n\nKAYNAK:\n\`\`\`typescript\n${source}\n\`\`\``;
  },
};

const readLiveStatsTool: ToolDef = {
  spec: {
    name: 'read_live_stats',
    description:
      'Canli islem gecmisi ve istatistikleri (win rate, profit factor, R cinsinden ' +
      'beklenti, kumulatif PnL). Sampiyonun canlida nasil gittigini gormek icin. ' +
      'NOT: canli islem yoksa bos doner — bu bir hata degil, sistem henuz emir gondermemis ' +
      'olabilir (LIVE_TRADING varsayilan olarak kapali).',
    schema: obj({ includeDryRun: bool('kuru kosuda kapanan pozisyonlari da say (varsayilan false)') }),
  },
  async run(input) {
    const { includeDryRun } = z.object({ includeDryRun: z.boolean().optional() }).parse(input ?? {});
    const trades = readTrades();
    const stats = computeLiveStats(trades, { includeDryRun: includeDryRun ?? false });
    const champ = readChampion();

    if (stats.totalTrades === 0) {
      return (
        `Canli kapanmis islem YOK (defterde ${trades.length} kayit, ${stats.unknownPnlTrades} tanesinin PnL'i okunamamis).\n` +
        `Canli sampiyon: ${champ?.name ?? 'promosyon kaydi yok -> builtin mechanical-v0'}\n` +
        `Bu bir hata degil: LIVE_TRADING varsayilan olarak kapali ve sistem henuz emir gondermemis olabilir. ` +
        `Model bozulmasini olcmek icin bunun yerine backtest_model ile kayan pencere kosumu kullan.`
      );
    }

    return [
      `Canli sampiyon: ${champ?.name ?? 'builtin mechanical-v0'}`,
      `Islem: ${stats.totalTrades} (${stats.winningTrades}K / ${stats.losingTrades}Z) | win rate %${stats.winRate.toFixed(1)}`,
      `Toplam PnL: $${stats.totalPnl.toFixed(2)} | profit factor ${stats.profitFactor.toFixed(2)} | beklenti ${stats.expectancyR.toFixed(3)}R`,
      `En iyi: $${stats.bestTrade?.realizedPnl.toFixed(2) ?? '—'} | en kotu: $${stats.worstTrade?.realizedPnl.toFixed(2) ?? '—'}`,
      stats.unknownPnlTrades > 0 ? `${stats.unknownPnlTrades} islemin PnL'i okunamadi ve HICBIR sayiya katilmadi.` : '',
      `\nSon 20 islem:`,
      ...trades.slice(-20).map(
        (t) =>
          `  ${iso(t.exitTime)} ${t.symbol} ${t.side} ${t.reason} $${t.realizedPnl.toFixed(2)}` +
          `${t.dryRun ? ' [kuru]' : ''}${t.pnlUnknown ? ' [PnL bilinmiyor]' : ''}`,
      ),
    ]
      .filter(Boolean)
      .join('\n');
  },
};

const readReportTool: ToolDef = {
  spec: {
    name: 'read_report',
    description:
      'Bir raporu okur (gece raporlari `nightly-YYYY-MM-DD.md`, orchestrator raporlari ' +
      '`orchestrator-*.md`). Ad verilmezse mevcut raporlarin listesini dondurur. ' +
      'Codex\'in dun gece ne yaptigini ve kapinin ne dedigini gormek icin.',
    schema: obj({ name: str('rapor dosya adi; bos birakilirsa liste doner') }),
  },
  async run(input) {
    const { name } = z.object({ name: z.string().optional() }).parse(input ?? {});
    if (!fs.existsSync(REPORTS_DIR)) return 'Rapor dizini yok.';

    const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.md')).sort().reverse();
    if (!name) return `Mevcut raporlar (yeniden eskiye):\n${files.map((f) => `  - ${f}`).join('\n')}`;

    const file = path.join(REPORTS_DIR, path.basename(name));
    if (!fs.existsSync(file)) throw new Error(`rapor bulunamadi: ${name}. Mevcutlar: ${files.slice(0, 10).join(', ')}`);
    return fs.readFileSync(file, 'utf8');
  },
};

const readBacktestRunTool: ToolDef = {
  spec: {
    name: 'read_backtest_run',
    description:
      'Panelden veya orchestrator\'dan daha once kosulmus bir backtest sonucunu okur ' +
      '(grid hucreleri, cikis nedenleri, atlama sebepleri, kasa/stres dilimleri).',
    schema: obj({ runId: str('backtest kosu kimligi') }, ['runId']),
  },
  async run(input) {
    const { runId } = z.object({ runId: z.string() }).parse(input);
    const r = readBacktestRun(runId);
    if (!r) throw new Error(`backtest kosusu bulunamadi: ${runId}`);

    return [
      `# ${r.strategyName} — ${r.id}`,
      `hukum: ${r.verdict}${r.fallbackUsed ? ' (SKORLAMA FILTRELERINI HICBIR HUCRE GECEMEDI)' : ''}`,
      `tam donem: ${pct(r.full.totalPnlPercent)} | test: ${pct(r.test.totalPnlPercent)} (${r.test.totalTrades} islem, DD %${r.test.maxDrawdownPercent.toFixed(1)})`,
      `stres: ${r.stress ? pct(r.stress.totalPnlPercent) : '—'} | kasa: ${r.holdout ? pct(r.holdout.totalPnlPercent) : '—'}`,
      `kazanan hucre: ${JSON.stringify(r.best.params)} risk ${JSON.stringify(r.best.risk)}`,
      `plato: ${r.best.qualifiedNeighbors} nitelikli komsu | ${r.best.windowsPositive}/${r.best.windowCount} pencere pozitif`,
      `\ncikis nedenleri: ${r.exitReasons.map((e) => `${e.reason} x${e.count}`).join(', ')}`,
      `giris atlamalari: ${r.skips.map((s) => `${s.rule} x${s.count}`).join(', ') || '(yok)'}`,
      `grid elemeleri: ${r.disqualifications.map((d) => `${d.label} x${d.count}`).join(', ') || '(yok)'}`,
    ].join('\n');
  },
};

// ---------------------------------------------------------------- OLCME

const backtestModelTool: ToolDef = {
  spec: {
    name: 'backtest_model',
    description:
      'Kutuphanedeki HERHANGI bir modele backtest kosar — baseline olmasi gerekmez. ' +
      'Motorun gercek sinav yolunu kullanir (dogrulama -> gauntlet -> grid -> maliyet ' +
      'stresi -> kasa penceresi -> kapi). AGIR: dakikalar surer ve kosu basina frenli. ' +
      'Gecmis bir pencereyi incelemek icin `endDate` ver.',
    schema: obj(
      {
        modelId: str('list_models\'ten gelen id'),
        days: num('pencere uzunlugu (gun). Varsayilan 540.'),
        endDate: str('pencerenin BITISI (ISO tarih). Verilmezse bugun.'),
        fixedParams: bool('true = grid taranmaz, modelin kendi parametreleri kullanilir (cok daha hizli)'),
      },
      ['modelId'],
    ),
  },
  async run(input, ctx) {
    const a = z
      .object({
        modelId: z.string(),
        days: z.number().optional(),
        endDate: z.union([z.string(), z.number()]).optional(),
        fixedParams: z.boolean().optional(),
      })
      .parse(input);

    if (ctx.budget.backtestsLeft <= 0) {
      throw new Error(
        `bu kosunun agir backtest butcesi bitti (ORCH_MAX_BACKTESTS=${env.orchestrator.maxBacktests}). ` +
          'Elindeki olcumlerle sonuclandir.',
      );
    }
    ctx.budget.backtestsLeft--;
    ctx.run.backtestsRun++;

    const m = (await listModels()).find((x) => x.id === a.modelId);
    if (!m) throw new Error(`model bulunamadi: ${a.modelId}`);
    if (!m.runnable) throw new Error(`${m.name} kosulamaz: ${m.blockedReason}`);

    const days = a.days ?? env.nightly.backtestDays;
    const endDate = parseWhen(a.endDate, Date.now());
    const startDate = endDate - days * DAY_MS;
    const symbols = m.symbols.length ? m.symbols : [...env.nightly.symbols];

    await ensureDataset({ symbols, interval: m.interval, startDate, endDate });
    const source = fs.readFileSync(m.codePath, 'utf8');

    // Sandbox'li modelde de META lazim: grid'in strateji ekseni meta.params'in `sweep`
    // listelerinden kuruluyor (backtest.ts:buildParamCells). Sahte bos bir meta gecmek,
    // grid'i SESSIZCE tek hucreye indirirdi — kosu calisir gorunur, ama modelin taramasi
    // gereken parametreleri hic taramamis olurdu.
    const strategy = m.origin === 'builtin' ? mechanicalV0() : await loadMeta(source);

    const res = await runExclusive('orchestrator', `backtest ${m.name}`, () =>
      challenge({
        strategy,
        source,
        sandboxed: m.origin !== 'builtin',
        symbols,
        interval: m.interval,
        startDate,
        endDate,
        holdoutDays: env.nightly.holdoutDays,
        initialBalance: 10_000,
        profile: m.profile,
        costs: DEFAULT_COSTS,
        ...(a.fixedParams ? { fixedParams: m.params } : {}),
      }),
    );

    if (!res.ok) return `Backtest DUSTU (${res.failure}): ${res.feedback ?? ''}`;

    const e = res.evaluated!;
    const verdict = judge(res, null);

    return [
      `# ${m.name} — ${iso(startDate)} .. ${iso(endDate)} (${days}g)`,
      `hukum: ${e.verdict} | ${res.selection!.cells.length} grid hucresi | nitelikli hucre ${e.gridQualified}/${e.gridTotal}`,
      `test: ${pct(e.test.totalPnlPercent)} PnL, MAR ${e.test.mar.toFixed(2)}, DD %${e.test.maxDrawdownPercent.toFixed(1)}, ${e.test.totalTrades} islem`,
      `pencereler: ${e.windowsPositive}/${e.windowCount} pozitif | plato komsulari: ${e.qualifiedNeighbors}`,
      `maliyet stresi: ${pct(res.stress!.totalPnlPercent)} | KASA: ${pct(res.holdout!.totalPnlPercent)} (DD %${res.holdout!.maxDrawdownPercent.toFixed(1)}, ${res.holdout!.totalTrades} islem)`,
      `kazanan hucre: ${JSON.stringify(res.selection!.best.params)}`,
      `maliyet payi: brut karin %${(e.test.feeShareOfGross * 100).toFixed(1)}i`,
      ``,
      `KAPI (sampiyonsuz, tek basina sartlar): ${verdict.promote ? 'GECER' : 'GECMEZ'}`,
      verdict.blockers.length ? `engeller: ${verdict.blockers.join('; ')}` : '',
      verdict.warnings.length ? `uyarilar: ${verdict.warnings.join('; ')}` : '',
      ``,
      `ZAYIFLIK TESHISI:\n${diagnoseWeakness(res)}`,
    ]
      .filter(Boolean)
      .join('\n');
  },
};

const analyzeGatesTool: ToolDef = {
  spec: {
    name: 'analyze_gates',
    description:
      'GATE BILANCOSU: modelin her veto kurali ve her harness kapisi icin "bu filtre ' +
      'olmasaydi ne olurdu" karsi-olgusunu kosar. Her kural icin kac giris adayi eledigini ' +
      've kaldirilsaydi PnL/beklenti/drawdown\'un nasil degisecegini R cinsinden dondurur. ' +
      'Hangi filtreyi kaldirmak/degistirmek gerektigine karar vermek icin ONCE bunu cagir.',
    schema: obj(
      {
        modelId: str('list_models\'ten gelen id'),
        days: num('pencere uzunlugu (gun). Varsayilan 365.'),
        endDate: str('pencerenin BITISI (ISO tarih). Verilmezse bugun.'),
        riskPerTrade: num(
          'islem basina risk orani (0.01 = %1). Verilmezse modelin kendi hucresi, ' +
            'kayitli hucresi yoksa muhafazakar bir taban. Temel kosu likide oluyorsa dusur.',
        ),
      },
      ['modelId'],
    ),
  },
  async run(input, ctx) {
    const a = z
      .object({
        modelId: z.string(),
        days: z.number().optional(),
        endDate: z.union([z.string(), z.number()]).optional(),
        riskPerTrade: z.number().positive().max(1).optional(),
      })
      .parse(input);

    if (ctx.budget.backtestsLeft <= 0) throw new Error('agir hesap butcesi bitti — elindeki olcumlerle sonuclandir');
    ctx.budget.backtestsLeft--;
    ctx.run.backtestsRun++;

    const m = (await listModels()).find((x) => x.id === a.modelId);
    if (!m) throw new Error(`model bulunamadi: ${a.modelId}`);
    if (!m.runnable) throw new Error(`${m.name} kosulamaz: ${m.blockedReason}`);

    const days = a.days ?? 365;
    const endDate = parseWhen(a.endDate, Date.now());
    const startDate = endDate - days * DAY_MS;
    const symbols = m.symbols.length ? m.symbols : [...env.nightly.symbols];

    await ensureDataset({ symbols, interval: m.interval, startDate, endDate });
    const source = fs.readFileSync(m.codePath, 'utf8');
    const meta = m.origin === 'builtin' ? mechanicalV0() : await loadMeta(source);
    const params = Object.keys(m.params).length ? m.params : defaultsOf(meta);

    // Hangi risk hucresinde olctugumuz raporda YAZAR (bkz. chooseAnalysisRisk):
    // varsayilan %5 preset builtin'i likide ediyor ve karsi-olgusal olcumu
    // sessizce anlamsiz kilardi.
    const chosen = chooseAnalysisRisk({
      risk: m.risk,
      hasRecordedCell: m.evaluation !== null,
      ...(a.riskPerTrade !== undefined ? { override: a.riskPerTrade } : {}),
    });

    const ds = loadDataset({ symbols, interval: m.interval, startDate, endDate });
    try {
      assertCoverage(ds, { symbols, interval: m.interval, startDate, endDate });

      const res = await runExclusive('orchestrator', `gate bilancosu ${m.name}`, () =>
        analyzeGates({
          strategy: meta,
          source,
          sandboxed: m.origin !== 'builtin',
          symbols,
          interval: m.interval,
          startDate,
          endDate,
          initialBalance: 10_000,
          profile: m.profile,
          params,
          risk: chosen.risk,
          costs: DEFAULT_COSTS,
          dataset: ds,
        }),
      );

      const head = [
        `# GATE BILANCOSU — ${m.name}, ${iso(startDate)} .. ${iso(endDate)}`,
        `risk hucresi: ${chosen.note}`,
        `temel kosu: ${pct(res.baseline.totalPnlPercent)} PnL, ${res.baseline.totalTrades} islem, DD %${res.baseline.maxDrawdownPercent.toFixed(1)}`,
        `karsi-olgu guveni: ${res.liftedConfidence.toFixed(2)} (${res.liftedConfidenceSource}) — VARSAYIM, vetolanmis barda strateji confidence uretmedi`,
      ];

      if (!res.baselineUsable) {
        head.push('', '!!! TEMEL KOSU KIYAS TABANI OLARAK KULLANILAMAZ !!!', ...res.warnings.map((w) => `  ${w}`), '');
      }

      const rows = res.gates.map((g) => {
        const c = g.counterfactual;
        return c
          ? `- ${g.rule} (${g.kind}, ${g.firedCount} tetik): kaldirilsaydi PnL ${pct(c.deltaPnlPct)}, ` +
            `beklenti ${c.deltaExpectancyR >= 0 ? '+' : ''}${c.deltaExpectancyR.toFixed(3)}R, ` +
            `DD ${c.deltaMaxDDPct >= 0 ? '+' : ''}${c.deltaMaxDDPct.toFixed(1)} puan, ` +
            `islem ${c.deltaTrades >= 0 ? '+' : ''}${c.deltaTrades} -> ${c.verdict}`
          : `- ${g.rule} (${g.kind}, ${g.firedCount} tetik): OLCULEMEDI — ${g.note}`;
      });

      return [
        ...head,
        ...rows,
        '',
        'OKUMA: delta = "gate OLMASAYDI" kosusunun temelden farki.',
        '  PnL deltasi POZITIF -> gate KAYBETTIRIYOR (kaldirmak kar getirirdi)',
        '  PnL deltasi NEGATIF -> gate KORUYOR (kaldirmak zarar getirirdi)',
      ].join('\n');
    } finally {
      ds.close();
    }
  },
};

const autopsyTool: ToolDef = {
  spec: {
    name: 'autopsy',
    description:
      'OTOPSI: bir modelin belirli bir tarih araliginda neden coktugunu alti yontemle ' +
      'inceler — pencere yeniden kosumu, MAE/MFE islem otopsisi, gate bilancosu, segment ' +
      'atifi (sembol/cikis/rejim/ay), piyasa baglami (rejim, volatilite, korelasyon) ve ' +
      'NUKS TARAMASI (ayni pencere diger modellerde de mi cokuyor?). ' +
      'Anormal bir donem gordugunde bunu cagir. AGIR.',
    schema: obj(
      {
        modelId: str('list_models\'ten gelen id. Verilmezse builtin.'),
        from: str('pencere BASI (ISO tarih)'),
        to: str('pencere SONU (ISO tarih)'),
        checkRecurrence: bool('kutuphanedeki diger modelleri de ayni pencerede kos (nuks hipotezi icin). Varsayilan true.'),
        includeSentiment: bool('Fear&Greed ve Binance konumlanma verisine git. Varsayilan true.'),
      },
      ['from', 'to'],
    ),
  },
  async run(input, ctx) {
    const a = z
      .object({
        modelId: z.string().optional(),
        from: z.union([z.string(), z.number()]),
        to: z.union([z.string(), z.number()]),
        checkRecurrence: z.boolean().optional(),
        includeSentiment: z.boolean().optional(),
      })
      .parse(input);

    if (ctx.budget.backtestsLeft <= 0) throw new Error('agir hesap butcesi bitti — elindeki olcumlerle sonuclandir');
    ctx.budget.backtestsLeft--;
    ctx.run.backtestsRun++;

    const from = parseWhen(a.from, 0);
    const to = parseWhen(a.to, Date.now());
    if (!(to > from)) throw new Error('gecersiz pencere: `to` > `from` olmali');

    const symbols = [...env.nightly.symbols];
    await ensureDataset({ symbols, interval: env.nightly.interval, startDate: from, endDate: to });

    const r = await runExclusive('orchestrator', `otopsi ${a.modelId ?? 'builtin'}`, () =>
      runAutopsy({
        ...(a.modelId ? { modelId: a.modelId } : {}),
        from,
        to,
        checkRecurrence: a.checkRecurrence ?? true,
        includeSentiment: a.includeSentiment ?? true,
      }),
    );

    return renderAutopsy(r);
  },
};

function renderAutopsy(r: Awaited<ReturnType<typeof runAutopsy>>): string {
  const seg = (rows: typeof r.segments.bySymbol) =>
    rows.map((x) => `${x.key}: ${x.trades} islem, $${x.pnl.toFixed(0)}, win %${x.winRate.toFixed(0)}${x.pnlR === null ? '' : `, ${x.pnlR.toFixed(1)}R`}`).join(' | ');

  const out = [
    `# OTOPSI — ${r.model.name} (${r.model.origin})`,
    `pencere: ${iso(r.window.from)} .. ${iso(r.window.to)} (${r.window.days} gun)`,
    `sonuc: ${pct(r.results.totalPnlPercent)} PnL | ${r.results.totalTrades} islem | DD %${r.results.maxDrawdownPercent.toFixed(1)} | beklenti ${r.results.expectancyR.toFixed(3)}R`,
    '',
    `## A+B — ISLEM OTOPSISI`,
    r.weakness,
    '',
    `## D — SEGMENT ATIFI`,
    `sembol : ${seg(r.segments.bySymbol)}`,
    `cikis  : ${seg(r.segments.byExitReason)}`,
    `rejim  : ${seg(r.segments.byBtcRegime)}`,
    `ay     : ${seg(r.segments.byMonth)}`,
    r.segments.worstConcentration
      ? `YOGUNLASMA: kayiplarin %${r.segments.worstConcentration.shareOfLossPct.toFixed(0)}i tek dilimde — ` +
        `${r.segments.worstConcentration.dimension} = ${r.segments.worstConcentration.key}`
      : 'YOGUNLASMA: baskin bir dilim yok — kayip dagilmis',
    '',
    `## E — PIYASA BAGLAMI`,
    `BTC rejimi: SMA200 ustunde %${r.market.regimeSummary.abovePct.toFixed(0)}, altinda %${r.market.regimeSummary.belowPct.toFixed(0)}, ${r.market.regimeSummary.flips} rejim degisimi`,
    `sembol dispersiyonu: %${r.market.dispersionPct.toFixed(1)} | ortalama ikili korelasyon: ${r.market.avgCorrelation.toFixed(2)}`,
    ...r.market.symbols.map(
      (s) =>
        `  ${s.symbol}: getiri ${pct(s.returnPct)}, yillik vol %${s.annualizedVolPct.toFixed(0)}, ` +
        `trend verimi ${s.trendEfficiency.toFixed(2)}, ort. funding ${s.avgFunding === null ? '—' : `${(s.avgFunding * 100).toFixed(4)}%`}`,
    ),
  ];

  if (r.fearGreed) {
    out.push(
      r.fearGreed.unavailable
        ? `Korku&Acgozluluk: KULLANILAMADI — ${r.fearGreed.unavailable}`
        : `Korku&Acgozluluk: ortalama ${r.fearGreed.average!.toFixed(0)} | dip ${r.fearGreed.min!.value} (${iso(r.fearGreed.min!.timestamp)}) | tepe ${r.fearGreed.max!.value} (${iso(r.fearGreed.max!.timestamp)})`,
    );
  }
  for (const p of r.positioning) {
    out.push(
      p.unavailable
        ? `Konumlanma ${p.symbol}: KULLANILAMADI — ${p.unavailable}`
        : `Konumlanma ${p.symbol}: ${p.points.length} kayit, son L/S ${p.points[p.points.length - 1]?.longShortRatio ?? '—'}`,
    );
  }

  out.push('', `## C — GATE BILANCOSU`);
  if (r.gates) {
    if (!r.gates.baselineUsable) out.push('!!! temel kosu kiyas tabani degil: ' + r.gates.warnings.join(' / '));
    out.push(
      ...r.gates.gates.map((g) =>
        g.counterfactual
          ? `- ${g.rule} (${g.firedCount} tetik): kaldirilsaydi PnL ${pct(g.counterfactual.deltaPnlPct)}, islem ${g.counterfactual.deltaTrades >= 0 ? '+' : ''}${g.counterfactual.deltaTrades} -> ${g.counterfactual.verdict}`
          : `- ${g.rule} (${g.firedCount} tetik): OLCULEMEDI — ${g.note}`,
      ),
    );
  } else {
    out.push(`alinamadi: ${r.gatesError}`);
  }

  out.push('', `## F — NUKS TARAMASI`);
  if (r.recurrence.length === 0) {
    out.push('(calistirilmadi veya kutuphanede baska kosulabilir model yok)');
  } else {
    out.push(
      ...r.recurrence.map((x) =>
        x.error
          ? `- ${x.name}: KOSULAMADI — ${x.error}`
          : `- ${x.name}: ${pct(x.pnlPct!)} PnL, DD %${x.maxDDPct!.toFixed(1)}, ${x.trades} islem`,
      ),
      '',
      'OKUMA: ayni pencerede TUM modeller cokuyorsa sorun modelde degil REJIMDE olabilir — ' +
        'o durumda "modeli duzelt" mudahalesi bosa gider, rejim filtresi gerekir.',
    );
  }

  if (r.notes.length) out.push('', `NOTLAR: ${r.notes.join(' | ')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- ARASTIRMA

const webSearchTool: ToolDef = {
  spec: {
    name: 'web_search',
    description:
      'Web araması. Otopsi penceresinde piyasada ne oldugunu (borsa olayi, regulasyon, ' +
      'likidasyon kaskadi) arastirmak icin. DETERMINISTIK DEGILDIR: sonuclar bir IPUCUDUR, ' +
      'kanit degil. Sayilar her zaman motordan gelmeli.',
    schema: obj({ query: str('arama sorgusu') }, ['query']),
  },
  async run(input) {
    const { query } = z.object({ query: z.string() }).parse(input);
    const res = await webSearch(query);
    if (res.unavailable) return `Arama yapilamadi: ${res.unavailable}`;
    if (res.results.length === 0) return `"${query}" icin sonuc yok.`;

    return [
      `${res.results.length} sonuc (${res.provider}) — DETERMINISTIK DEGIL, ipucu olarak oku:`,
      ...res.results.map((r) => `- ${r.title}${r.published ? ` (${r.published})` : ''}\n  ${r.url}\n  ${r.snippet}`),
    ].join('\n');
  },
};

// ---------------------------------------------------------------- MODEL URETME

const gateSurgeryTool: ToolDef = {
  spec: {
    name: 'gate_surgery',
    description:
      'Bir modelin veto kurallarini (gate) ACILIP KAPANABILIR parametrelere cevirerek YENI ' +
      'bir model uretir ve tam sinavdan gecirir. Gate kaldirmak boylece bir grid eksenine ' +
      'donusur: sistem hangi kombinasyonun iyi oldugunu kendisi arar. Ayni anda en fazla 3 ' +
      'gate. Sonuc `strategies/candidates/` altina yazilir ve /models sayfasinda gorunur — ' +
      'CANLIYA ALINMAZ. Once analyze_gates ile hangi gate\'lerin sorunlu oldugunu olc.',
    schema: obj(
      {
        modelId: str('kaynak modelin id\'si'),
        rules: { type: 'array', items: { type: 'string' }, description: 'parametrelestirilecek veto kurallari (en fazla 3)' },
        days: num('degerlendirme penceresi (gun). Varsayilan 540.'),
      },
      ['modelId', 'rules'],
    ),
  },
  async run(input, ctx) {
    const a = z
      .object({ modelId: z.string(), rules: z.array(z.string()), days: z.number().optional() })
      .parse(input);

    if (ctx.budget.backtestsLeft <= 0) throw new Error('agir hesap butcesi bitti — elindeki olcumlerle sonuclandir');

    const m = (await listModels()).find((x) => x.id === a.modelId);
    if (!m) throw new Error(`model bulunamadi: ${a.modelId}`);
    if (!m.runnable) throw new Error(`${m.name} kosulamaz: ${m.blockedReason}`);

    const source = fs.readFileSync(m.codePath, 'utf8');
    const surgery = await gateSurgery({ source, rules: a.rules, pinnedParams: m.params });

    if (surgery.applied.length === 0) {
      return `Hicbir gate parametrelestirilemedi.\n${surgery.skipped.map((s) => `- ${s.rule}: ${s.reason}`).join('\n')}`;
    }

    ctx.budget.backtestsLeft--;
    ctx.run.backtestsRun++;

    const evaluated = await evaluateAndSave({
      run: ctx.run,
      source: surgery.source,
      symbols: m.symbols.length ? m.symbols : [...env.nightly.symbols],
      interval: m.interval,
      profile: m.profile,
      days: a.days ?? env.nightly.backtestDays,
      label: `gate cerrahisi: ${surgery.applied.join(', ')}`,
    });

    const skipNote = surgery.skipped.length
      ? `\nUYGULANMAYANLAR:\n${surgery.skipped.map((s) => `- ${s.rule}: ${s.reason}`).join('\n')}`
      : '';

    return `Gate cerrahisi: ${surgery.applied.join(', ')} (${surgery.sweepCells} grid hucresi)${skipNote}\n\n${evaluated}`;
  },
};

const askCodexTool: ToolDef = {
  spec: {
    name: 'ask_codex',
    description:
      'Codex\'e bir strateji varyanti YAZDIRIR ve tam sinavdan gecirir. Gate cerrahisiyle ' +
      'yapilamayan degisiklikler icin: yeni bir filtre EKLEMEK, mevcut bir kurali ' +
      'DEGISTIRMEK, giris mantigini yeniden kurmak. Brief\'e teshisini ve neyi neden ' +
      'istedigini YAZ — Codex modelin kaynagini ve sozlesmeyi gorur ama senin olcumlerini ' +
      'gormez. COK AGIR: 30 dakikaya kadar surer. Sonuc /models sayfasinda gorunur, ' +
      'CANLIYA ALINMAZ.',
    schema: obj(
      {
        modelId: str('gelistirilecek modelin id\'si'),
        instruction: str('Codex\'e ne yapmasini istedigin — teshisin ve somut istegin. En az bir paragraf.'),
        days: num('degerlendirme penceresi (gun). Varsayilan 540.'),
      },
      ['modelId', 'instruction'],
    ),
  },
  async run(input, ctx) {
    const a = z
      .object({ modelId: z.string(), instruction: z.string().min(40), days: z.number().optional() })
      .parse(input);

    if (ctx.budget.backtestsLeft <= 0) throw new Error('agir hesap butcesi bitti — elindeki olcumlerle sonuclandir');

    const m = (await listModels()).find((x) => x.id === a.modelId);
    if (!m) throw new Error(`model bulunamadi: ${a.modelId}`);
    if (!m.runnable) throw new Error(`${m.name} kosulamaz: ${m.blockedReason}`);

    const source = fs.readFileSync(m.codePath, 'utf8');

    // buildRefineBrief sampiyon kaydi bekliyor; ModelListing ayni alanlari tasiyor.
    // Ikinci bir brief sablonu yazmak, Codex'e iki farkli sozlesme anlatmak olurdu.
    const brief = buildRefineBrief({
      champion: {
        strategyId: m.strategyId,
        version: m.version,
        name: m.name,
        author: m.author,
        params: m.params,
        risk: m.risk,
        symbols: m.symbols,
        interval: m.interval,
        profile: m.profile,
      } as never,
      championSource: source,
      results: (m.evaluation
        ? {
            totalPnlPercent: m.evaluation.testPnlPct,
            mar: m.evaluation.testMar,
            maxDrawdownPercent: m.evaluation.testMaxDDPct,
            totalTrades: m.evaluation.testTrades,
            winRate: 0,
            expectancyR: 0,
            feeShareOfGross: m.evaluation.feeShareOfGross,
          }
        : { totalPnlPercent: 0, mar: 0, maxDrawdownPercent: 0, totalTrades: 0, winRate: 0, expectancyR: 0, feeShareOfGross: 0 }) as never,
      weakness: `**Ust aklin (orchestrator) teshisi ve istegi:**\n\n${a.instruction}`,
    });

    const ws = createWorkspace({ runId: ctx.run.id, brief, examples: {} });
    let candidate: string | null = null;

    try {
      const driver = await CodexDriver.connect();
      try {
        const threadId = await driver.startThread(ws.dir);
        const turn = await driver.turn(threadId, 'BRIEF.md dosyasini oku ve gorevi yap.');
        candidate = extractCandidate(ws, turn.text);
      } finally {
        driver.close();
      }
    } finally {
      destroyWorkspace(ws);
    }

    if (!candidate) return 'Codex aday uretmedi (dosyaya dokunmadi). Istegini daha somut yaz ve tekrar dene.';

    ctx.budget.backtestsLeft--;
    ctx.run.backtestsRun++;

    return evaluateAndSave({
      run: ctx.run,
      source: candidate,
      symbols: m.symbols.length ? m.symbols : [...env.nightly.symbols],
      interval: m.interval,
      profile: m.profile,
      days: a.days ?? env.nightly.backtestDays,
      label: 'Codex varyanti',
    });
  },
};

/**
 * Uretilen kaynagi TAM sinavdan gecirir ve aday olarak kaydeder.
 *
 * gate_surgery ve ask_codex AYNI yolu kullanir — iki farkli kayit sekli olsaydi,
 * /models listesi hangi yoldan uretildigine gore farkli davranan satirlar gosterirdi
 * (models.ts:136 ile ayni gerekce).
 */
async function evaluateAndSave(args: {
  run: OrchestratorRun;
  source: string;
  symbols: string[];
  interval: CandleInterval;
  profile: StrategyProfile;
  days: number;
  label: string;
}): Promise<string> {
  const { interval } = args;
  const endDate = Date.now();
  const startDate = endDate - args.days * DAY_MS;

  await ensureDataset({ symbols: args.symbols, interval, startDate, endDate });

  const strategy = await loadMeta(args.source);
  const res = await runExclusive('orchestrator', args.label, () =>
    challenge({
      strategy,
      source: args.source,
      sandboxed: true,
      symbols: args.symbols,
      interval,
      startDate,
      endDate,
      holdoutDays: env.nightly.holdoutDays,
      initialBalance: 10_000,
      profile: args.profile,
      costs: DEFAULT_COSTS,
    }),
  );

  if (!res.ok) {
    return `${args.label}: SINAVDAN DUSTU (${res.failure})\n${res.feedback ?? ''}`;
  }

  const verdict = judge(res, null);
  const candidateRunId = `${args.run.id}-${args.run.producedCandidates.length + 1}`;

  const ev = await buildCandidateEvaluation({
    runId: candidateRunId,
    source: args.source,
    result: res,
    verdict,
    symbols: args.symbols,
    interval,
    profile: args.profile,
  });

  if (!ev) return `${args.label}: degerlendirme kaydi olusturulamadi`;

  // Kaynak ve degerlendirme aday dizinine — listModels() burayi zaten tariyor.
  const dir = path.join(STRATEGIES_DIR, 'candidates', candidateRunId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'strategy.ts'), args.source);
  saveCandidateEvaluation(candidateRunId, ev);
  args.run.producedCandidates.push(`candidate:${candidateRunId}`);

  const e = res.evaluated!;
  return [
    `${args.label} -> ADAY KAYDEDILDI: candidate:${candidateRunId}`,
    `${strategy.meta.name}`,
    `hukum: ${e.verdict} | test ${pct(e.test.totalPnlPercent)} (MAR ${e.test.mar.toFixed(2)}, DD %${e.test.maxDrawdownPercent.toFixed(1)}, ${e.test.totalTrades} islem)`,
    `stres ${pct(res.stress!.totalPnlPercent)} | KASA ${pct(res.holdout!.totalPnlPercent)}`,
    `kazanan hucre: ${JSON.stringify(res.selection!.best.params)}`,
    `KAPI: ${verdict.promote ? 'GECER' : 'GECMEZ'}${verdict.blockers.length ? ` | engeller: ${verdict.blockers.join('; ')}` : ''}`,
    '',
    'Bu model CANLIYA ALINMADI. /models sayfasinda operatorun onayini bekliyor.',
  ].join('\n');
}

function defaultsOf(s: { meta: { params: ReadonlyArray<{ key: string; default: number | boolean }> } }): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const p of s.meta.params) out[p.key] = p.default;
  return out;
}

// ---------------------------------------------------------------- YONLENDIRME

const addDirectiveTool: ToolDef = {
  spec: {
    name: 'add_directive',
    description:
      'Gece dongusune YON verir: makale sorgusuna, makale triaj/secim promptuna veya ' +
      'Codex\'in brief\'ine metin enjekte eder. Yonlendirme bir ONCELIK bildirir, bir IZIN ' +
      'degildir — katı kurallar ve degerlendirme olcutleri bundan bagimsizdir ve makine ' +
      'tarafindan zorlanir. Sistemin neye ihtiyaci oldugunu gordugunde kullan.',
    schema: obj(
      {
        target: {
          type: 'string',
          enum: DIRECTIVE_TARGETS,
          description:
            'arxiv-queries: ek arXiv sorgusu (ONCEDEN URL-KODLANMIS olmali, bosluksuz) | ' +
            'paper-triage / paper-final: makale secici promptu | ' +
            'codex-new / codex-refine: Codex brief\'i',
        },
        text: str('enjekte edilecek metin (en fazla 2000 karakter)'),
        rationale: str('neden — hangi olcum bu yonlendirmeyi gerektirdi'),
        ttlDays: num('kac gun sonra kendiliginden sonecek. Varsayilan 14.'),
      },
      ['target', 'text', 'rationale'],
    ),
  },
  async run(input, ctx) {
    const a = z
      .object({
        target: z.enum(['arxiv-queries', 'paper-triage', 'paper-final', 'codex-new', 'codex-refine']),
        text: z.string(),
        rationale: z.string(),
        ttlDays: z.number().optional(),
      })
      .parse(input);

    const d = addDirective({
      target: a.target,
      text: a.text,
      rationale: a.rationale,
      runId: ctx.run.id,
      ...(a.ttlDays !== undefined ? { ttlDays: a.ttlDays } : {}),
    });
    ctx.run.directives.push(d.id);

    return `Yonlendirme kaydedildi: ${d.id} -> ${d.target}, ${d.expiresAt ? `${iso(d.expiresAt)} tarihinde soner` : 'suresiz'}.`;
  },
};

const listDirectivesTool: ToolDef = {
  spec: {
    name: 'list_directives',
    description: 'Su an gecerli olan yonlendirmeleri listeler. Yeni bir tane yazmadan once mevcutlari gor.',
    schema: obj({}),
  },
  async run() {
    const all = readDirectives().filter((d) => !d.revoked && (d.expiresAt === null || d.expiresAt > Date.now()));
    if (all.length === 0) return 'Aktif yonlendirme yok.';
    return all
      .map((d) => `- ${d.id} [${d.target}] ${d.expiresAt ? `(${iso(d.expiresAt)}\'e kadar)` : '(suresiz)'}\n  ${d.text}\n  gerekce: ${d.rationale}`)
      .join('\n');
  },
};

const revokeDirectiveTool: ToolDef = {
  spec: {
    name: 'revoke_directive',
    description: 'Bir yonlendirmeyi iptal eder. Artik gecerli olmadigini gordugunde kullan.',
    schema: obj({ id: str('yonlendirme kimligi') }, ['id']),
  },
  async run(input) {
    const { id } = z.object({ id: z.string() }).parse(input);
    return revokeDirective(id) ? `Iptal edildi: ${id}` : `Bulunamadi veya zaten iptal edilmis: ${id}`;
  },
};

// ---------------------------------------------------------------- RAPOR

const writeReportTool: ToolDef = {
  spec: {
    name: 'write_report',
    description:
      'Bulgularini bir markdown raporuna yazar. Panelin /reports sayfasinda gorunur. ' +
      'Kosuyu bitirmeden ONCE cagir — sayilari, hipotezini ve neyi neden onerdigini yaz.',
    schema: obj({ markdown: str('rapor govdesi (markdown)') }, ['markdown']),
  },
  async run(input, ctx) {
    const { markdown } = z.object({ markdown: z.string().min(1) }).parse(input);

    const file = path.join(REPORTS_DIR, `${ctx.run.id}.md`);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const header = [
      `# Orchestrator — ${ctx.run.id}`,
      '',
      `- gorev: ${ctx.run.task}`,
      `- tetik: ${ctx.run.trigger}`,
      `- model: ${ctx.run.provider}/${ctx.run.model}`,
      `- uretilen adaylar: ${ctx.run.producedCandidates.join(', ') || '(yok)'}`,
      `- yazilan yonlendirmeler: ${ctx.run.directives.join(', ') || '(yok)'}`,
      '',
      '> Bu raporda onerilen modellerin HICBIRI canliya alinmadi. Aktivasyon operatorun karari.',
      '',
      '---',
      '',
    ].join('\n');

    fs.writeFileSync(file, header + markdown);
    ctx.run.reportPath = file;
    return `Rapor yazildi: ${file}`;
  },
};

// ---------------------------------------------------------------- kayit

/**
 * Bu kosuda kullanilabilir tool'lar.
 *
 * web_search YALNIZCA yapilandirilmissa verilir: kullanilamayacak bir tool'u listede
 * tutmak, modele her cagirdiginda hata dondurmek ve turlarini bosa harcamak demektir.
 */
export function buildTools(): Map<string, ToolDef> {
  const defs = [
    listModelsTool,
    readModelSourceTool,
    readLiveStatsTool,
    readReportTool,
    readBacktestRunTool,
    backtestModelTool,
    analyzeGatesTool,
    autopsyTool,
    gateSurgeryTool,
    askCodexTool,
    addDirectiveTool,
    listDirectivesTool,
    revokeDirectiveTool,
    writeReportTool,
    ...(webSearchConfigured() ? [webSearchTool] : []),
  ];

  return new Map(defs.map((d) => [d.spec.name, d]));
}
