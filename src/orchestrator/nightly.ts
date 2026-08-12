import fs from 'node:fs';
import path from 'node:path';
import { challenge, judge, sha256, type ChallengeResult } from '../engine/challenge';
import { DEFAULT_COSTS } from '../engine/costModel';
import { ensureDataset } from '../engine/dataset';
import { CodexDriver } from '../codex/driver';
import { buildNewStrategyBrief, buildRefineBrief, buildRepairPrompt } from '../codex/prompts';
import { createWorkspace, destroyWorkspace, extractCandidate } from '../codex/workspace';
import { searchArxiv, type ArxivPaper } from '../research/arxiv';
import { queriesForNight } from '../research/queries';
import { selectPaper, type PaperPick } from '../research/selector';
import { loadMeta } from '../strategy/loader';
import { readChampion, promoteChampion, loadChampionSource, type ChampionRecord } from './champion';
import { buildCandidateEvaluation, saveCandidateEvaluation } from './models';
import { renderReport } from './report';
import { diagnoseWeakness } from './weakness';
import mechanicalV0 from '../strategy/builtin/mechanicalV0';
import { env, REPORTS_DIR, STRATEGIES_DIR } from '../config/env';
import type { EvaluatedRun } from '../engine/promotion';
import type { Strategy } from '../strategy/types';
import type { BacktestResults } from '../lib/types';

/**
 * GECE DONGUSU — sistemin kendini gelistirdigi yer.
 *
 * En onemli tasarim kurali: **HATA DURUMUNDA HICBIR SEY DEGISMEZ.**
 *
 * arXiv coker, Codex dusUr, aday derlenmez, gauntlet reddeder, kapi engeller — hepsinde
 * sampiyona DOKUNULMAZ ve gece nedenini raporlar. Parasi olan bir sistemde varsayilan
 * davranis "degistirme" olmalidir; "en iyi tahminle devam et" degil.
 *
 * Idempotent: ayni runId ile yeniden kosulursa asamalar bastan calisir ama sampiyon
 * yalnizca kapi gecilirse degisir — yani tekrar kosmak zararsizdir.
 */

const DAY = 86_400_000;

export interface NightlyResult {
  runId: string;
  championBefore: string;
  championAfter: string;
  promoted: boolean;
  reportPath: string;
  stages: Record<string, { ok: boolean; detail: string }>;
}

export async function runNightly(): Promise<NightlyResult> {
  const runId = `nightly-${new Date().toISOString().slice(0, 10)}`;
  const stages: NightlyResult['stages'] = {};
  const stage = (name: string, ok: boolean, detail: string) => {
    stages[name] = { ok, detail };
    console.log(`  ${ok ? '+' : 'x'} ${name}: ${detail}`);
  };

  console.log(`\n=== ${runId} ===\n`);

  const endDate = Date.now();
  const startDate = endDate - env.nightly.backtestDays * DAY;
  const symbols = [...env.nightly.symbols];
  const interval = env.nightly.interval;

  const championBefore = readChampion();

  // ---------------------------------------------------------------- 1. VERI SENKRONU
  console.log('[1] veri senkronu');
  try {
    const { fetched } = await ensureDataset({ symbols, interval, startDate, endDate });
    stage('data', true, `${fetched} new candles`);
  } catch (err) {
    stage('data', false, msg(err));
    // Veri olmadan hicbir sey yapilamaz — gece burada biter, sampiyon dokunulmaz.
    return finish(runId, championBefore, championBefore, false, stages, null, null, null);
  }

  // ---------------------------------------------------------------- 2. SAMPIYON DEGERLENDIRME
  console.log('[2] sampiyon yeniden kosuluyor (elmayla elma)');

  const { strategy: champStrategy, source: champSource } = await loadChampion(championBefore);

  let champResult: ChallengeResult | null = null;
  try {
    champResult = await challenge({
      strategy: champStrategy,
      source: champSource,
      sandboxed: championBefore !== null, // builtin v0 sandbox'siz; promote edilmis aday sandbox'li
      symbols,
      interval,
      startDate,
      endDate,
      holdoutDays: env.nightly.holdoutDays,
      initialBalance: 10_000,
      profile: 'balanced',
      costs: DEFAULT_COSTS,
      ...(championBefore ? { fixedParams: championBefore.params } : {}),
    });
    stage(
      'champion',
      champResult.ok,
      champResult.ok
        ? `${champResult.evaluated!.verdict} | test ${pct(champResult.evaluated!.test.totalPnlPercent)} | holdout ${pct(champResult.holdout!.totalPnlPercent)}`
        : msg(champResult.failure),
    );
  } catch (err) {
    stage('champion', false, msg(err));
  }

  // ---------------------------------------------------------------- 3. ARASTIRMA
  console.log('[3] arXiv arastirmasi');
  let paper: PaperPick | null = null;
  try {
    const seen = seenPapers();
    const dayIndex = Math.floor(Date.now() / DAY);
    const harvested: ArxivPaper[] = [];

    /**
     * Sorgular AYRI ayri cekilir ama secim TEK havuz uzerinde yapilir.
     *
     * Eskiden her sorgu kendi icinde siralanip birlestiriliyordu; skorlar sorgular
     * arasinda karsilastirilabilir oldugu icin bu zararsizdi. Artik secimi bir model
     * yapiyor ve modelin adaylari YAN YANA gormesi gerekiyor — "bu gecenin en iyisi"
     * ancak tum havuz ortadayken sorulabilecek bir sorudur.
     */
    for (const q of queriesForNight(dayIndex)) {
      try {
        harvested.push(...(await searchArxiv(q.query, 100)));
      } catch (err) {
        // Tek sorgunun coktugu bir gece, makalesiz bir gece olmamali.
        console.log(`     sorgu '${q.name}' basarisiz: ${msg(err)}`);
      }
    }

    const { pick, note } = await selectPaper(harvested, seen);
    paper = pick;

    stage('research', true, paper ? `${note} [${paper.by}]` : `${note} -> falling back to REFINE`);
  } catch (err) {
    stage('research', false, `${msg(err)} -> falling back to REFINE`);
  }

  // ---------------------------------------------------------------- 4-5. CODEX + DOGRULAMA
  console.log('[4] Codex aday uretiyor');
  let candidateSource: string | null = null;
  let candResult: ChallengeResult | null = null;

  try {
    const refineBrief = () =>
      buildRefineBrief({
        champion: championBefore ?? placeholderChampion(),
        championSource: champSource,
        results: champResult?.selection?.best.results ?? emptyResults(),
        weakness: diagnoseWeakness(champResult),
      });

    let mode = paper ? 'NEW' : 'REFINE';
    const brief = paper ? buildNewStrategyBrief(paper) : refineBrief();

    const ws = createWorkspace({ runId, brief, examples: examples() });
    const driver = await CodexDriver.connect();

    try {
      const threadId = await driver.startThread(ws.dir);
      const turn = await driver.turn(threadId, 'BRIEF.md dosyasini oku ve gorevi yap.');

      candidateSource = extractCandidate(ws, turn.text);

      /**
       * REFINE FALLBACK — bos gecelere karsi.
       *
       * Codex'e "makale uygulanamazsa dosyaya DOKUNMA, uydurma bir sey yazma" diyoruz ve
       * buna uyuyor. Ama o zaman gece bir aday uretmeden biter — arXiv'de bir gun boyunca
       * bizim sozlesmemize uyan makale cikmamasi tamamen normaldir (ilk gercek kosuda tam
       * bunu gorduk: ETF stil tahsisi + Fama-French faktor makalesi, kripto perpetual'da
       * ifade edilemez).
       *
       * Sistem o gece HICBIR SEY ogrenmemis olur. Bu kabul edilemez: gece dongusunun degeri
       * her gun bir adim atmasindan gelir. Makale duserse, sampiyonun TESHIS EDILMIS
       * zayifligina karsi bir mutasyon iste — gece yine de bir aday uretsin.
       */
      if (!candidateSource && paper) {
        console.log('     makale uygulanamaz -> REFINE moduna dusuluyor');
        markPaperInfeasible(paper.paper.id);
        mode = 'REFINE (makale uygulanamaz)';

        fs.writeFileSync(path.join(ws.dir, 'BRIEF.md'), refineBrief());
        const retry = await driver.turn(
          threadId,
          'Bu makale bizim sozlesmemizde uygulanamiyor — dogru karar. BRIEF.md dosyasini ' +
            'YENIDEN oku: gorev degisti. Artik mevcut sampiyonu teshis edilmis zayifligina ' +
            'karsi gelistireceksin.',
        );
        candidateSource = extractCandidate(ws, retry.text);
      }

      if (!candidateSource) {
        stage('codex', false, `${mode}: no candidate produced`);
      } else {
        if (paper) markPaperUsed(paper.paper.id);
        stage('codex', true, `${mode}: ${candidateSource.split('\n').length}-line candidate`);

        // --- ONARIM DONGUSU: dogrulama/gauntlet hatalari AYNI thread'de geri beslenir
        //     (Codex reasoning context'ini korur). En fazla 2 onarim.
        for (let attempt = 0; attempt <= 2; attempt++) {
          candResult = await challenge({
            strategy: await loadMeta(candidateSource!),
            source: candidateSource!,
            sandboxed: true,
            symbols,
            interval,
            startDate,
            endDate,
            holdoutDays: env.nightly.holdoutDays,
            initialBalance: 10_000,
            profile: 'balanced',
            costs: DEFAULT_COSTS,
          });

          if (candResult.ok) break;

          if (attempt === 2) {
            stage('validation', false, `${candResult.failure} — still failing after 2 repair rounds`);
            break;
          }

          console.log(`     onarim turu ${attempt + 1}/2 (${candResult.failure})`);
          await driver.turn(threadId, buildRepairPrompt(candResult.failure!, candResult.feedback ?? ''));
          const repaired = extractCandidate(ws);
          if (!repaired) break;
          candidateSource = repaired;
        }

        if (candResult?.ok) {
          stage(
            'validation',
            true,
            `gauntlet passed | ${candResult.selection!.cells.length} cells | ${candResult.evaluated!.verdict}`,
          );
        }
      }
    } finally {
      driver.close();
      saveCandidate(runId, candidateSource);
      destroyWorkspace(ws);
    }
  } catch (err) {
    stage('codex', false, msg(err));
  }

  // ---------------------------------------------------------------- 6. PROMOSYON KAPISI
  console.log('[5] promosyon kapisi');
  let promoted = false;
  let championAfter = championBefore;

  // Sampiyon, kapiya TUM kosusuyla verilir (sadece ozetiyle degil): kapi onu da kendi
  // kapisindan gecirdigi icin stres ve kasa sonuclari da lazim.
  const championRun: ChallengeResult | null = champResult?.ok ? champResult : null;
  const verdict = candResult ? judge(candResult, championRun) : null;

  // Adayin degerlendirmesi, promote edilsin edilmesin diske yazilir. Kapiyi gecemeyen bir
  // aday da operatorun listesinde durmali: kapi otomatik promosyonun bekcisidir, elle
  // secimin yasakcisi degil (bkz. orchestrator/models.ts).
  if (candResult && verdict && candidateSource) {
    const ev = await buildCandidateEvaluation({
      runId,
      source: candidateSource,
      result: candResult,
      verdict,
      symbols,
      interval,
      profile: 'balanced',
    });
    if (ev) saveCandidateEvaluation(runId, ev);
  }

  if (verdict?.promote && candResult?.ok && candidateSource) {
    const meta = (await loadMeta(candidateSource)).meta;
    const best = candResult.selection!.best;

    championAfter = promoteChampion({
      source: candidateSource,
      record: {
        strategyId: meta.id,
        version: (championBefore?.strategyId === meta.id ? championBefore.version : 0) + 1,
        name: meta.name,
        author: 'codex',
        params: best.params,
        risk: best.risk,
        symbols,
        interval,
        profile: 'balanced',
        costConfig: DEFAULT_COSTS,
        promotedFromRunId: runId,
        provenance: paper
          ? {
              arxivId: paper.paper.id,
              arxivTitle: paper.paper.title,
              // Codex kendi hipotezini yazdiysa o gecerlidir: kodu o yazdi. Yazmadiysa
              // seciciden gelen hipotez, makalenin neden secildigini kayitta tutar.
              hypothesis: meta.provenance?.hypothesis ?? (paper.hypothesis || undefined),
            }
          : meta.provenance,
        evaluation: {
          verdict: candResult.evaluated!.verdict,
          testPnlPct: candResult.evaluated!.test.totalPnlPercent,
          testMar: candResult.evaluated!.test.mar,
          testMaxDDPct: candResult.evaluated!.test.maxDrawdownPercent,
          testTrades: candResult.evaluated!.test.totalTrades,
          windowsPositive: candResult.evaluated!.windowsPositive,
          windowCount: candResult.evaluated!.windowCount,
          stressPnlPct: candResult.stress!.totalPnlPercent,
          holdoutPnlPct: candResult.holdout!.totalPnlPercent,
          holdoutMaxDDPct: candResult.holdout!.maxDrawdownPercent,
          qualifiedNeighbors: candResult.evaluated!.qualifiedNeighbors,
          feeShareOfGross: candResult.evaluated!.test.feeShareOfGross,
        },
        live: { enabled: false, startedAt: 0 },
      },
    });

    promoted = true;
    stage('promotion', true, `NEW CHAMPION: ${meta.name} v${championAfter.version}`);
  } else {
    stage(
      'promotion',
      true, // "promote edilmedi" bir HATA degil — sistemin normal ve saglikli hali
      verdict
        ? `rejected (${verdict.blockers.length} blockers) — champion kept`
        : 'no candidate to evaluate — champion kept',
    );
  }

  return finish(runId, championBefore, championAfter, promoted, stages, champResult, candResult, verdict, paper);
}

// ---------------------------------------------------------------- yardimcilar

function finish(
  runId: string,
  before: ChampionRecord | null,
  after: ChampionRecord | null,
  promoted: boolean,
  stages: NightlyResult['stages'],
  champ: ChallengeResult | null,
  cand: ChallengeResult | null,
  verdict: ReturnType<typeof judge> | null,
  paper: PaperPick | null = null,
): NightlyResult {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${runId}.md`);
  fs.writeFileSync(
    reportPath,
    renderReport({ runId, before, after, promoted, stages, champ, cand, verdict, paper }),
  );

  console.log(`\nRapor: ${reportPath}`);
  console.log(promoted ? 'SAMPIYON DEGISTI.\n' : 'Sampiyona dokunulmadi.\n');

  return {
    runId,
    championBefore: before?.name ?? 'mekanik-v0 (builtin)',
    championAfter: after?.name ?? 'mekanik-v0 (builtin)',
    promoted,
    reportPath,
    stages,
  };
}

/** Sampiyon yoksa builtin mekanik v0 baslangic sampiyonudur. */
async function loadChampion(rec: ChampionRecord | null): Promise<{ strategy: Strategy; source: string }> {
  if (!rec) {
    return {
      strategy: mechanicalV0(),
      source: fs.readFileSync(path.join('src', 'strategy', 'builtin', 'mechanicalV0.ts'), 'utf8'),
    };
  }
  // sha DOGRULANIR — uyusmazsa firlatir.
  const source = loadChampionSource(rec);
  return { strategy: await loadMeta(source), source };
}

const SEEN_FILE = path.join(STRATEGIES_DIR, 'seen-papers.json');

function seenPapers(): Set<string> {
  if (!fs.existsSync(SEEN_FILE)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) as string[]);
}

/**
 * Makaleyi kalici olarak "gorulmus" isaretle.
 *
 * Codex bir makaleyi "uygulanamaz" diye reddettiyse, o karar YARIN DA gecerlidir —
 * sozlesmemiz degismedi. Isaretlemezsek siralayici ayni makaleyi her gece yeniden secer
 * (skoru yuksek), Codex her gece yeniden reddeder ve sistem sonsuza kadar ayni duvara
 * toslar. Bu, sessizce olen bir gece dongusudur.
 */
function markPaperInfeasible(arxivId: string): void {
  const seen = seenPapers();
  seen.add(arxivId);
  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2));
}

/** Aday uretilen makaleyi de isaretle — ayni makaleden iki kez strateji cikarmayalim. */
function markPaperUsed(arxivId: string): void {
  markPaperInfeasible(arxivId);
}

function saveCandidate(runId: string, source: string | null): void {
  if (!source) return;
  const dir = path.join(STRATEGIES_DIR, 'candidates', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'strategy.ts'), source);
}

function examples(): Record<string, string> {
  return {
    'mechanicalV0.example.ts': fs
      .readFileSync(path.join('src', 'strategy', 'builtin', 'mechanicalV0.ts'), 'utf8')
      .replace("from '../types'", "from './strategy-api'"),
  };
}

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function placeholderChampion(): ChampionRecord {
  return {
    strategyId: 'mechanical-v0',
    version: 0,
    name: 'Mekanik Tier-Composite v0',
    author: 'human',
    codePath: 'src/strategy/builtin/mechanicalV0.ts',
    codeSha256: '',
    params: {},
    risk: {} as ChampionRecord['risk'],
    symbols: [],
    interval: '4h',
    profile: 'balanced',
    costConfig: DEFAULT_COSTS,
    promotedAt: 0,
    promotedFromRunId: '',
    evaluation: {} as ChampionRecord['evaluation'],
    live: { enabled: false, startedAt: 0 },
  };
}

function emptyResults(): BacktestResults {
  return {
    finalBalance: 0, totalPnl: 0, totalPnlPercent: 0, totalTrades: 0, winningTrades: 0,
    losingTrades: 0, winRate: 0, maxDrawdown: 0, maxDrawdownPercent: 0, sharpeRatio: 0,
    sortinoRatio: 0, mar: 0, cagr: 0, profitFactor: 0, avgTradeReturn: 0, expectancyR: 0,
    totalFeesUSD: 0, totalFundingUSD: 0, feeShareOfGross: 0, turnoverUSD: 0,
    bestTrade: null, worstTrade: null,
  };
}

if (require.main === module) {
  runNightly().catch((err) => {
    console.error('\nGECE DONGUSU HATASI:', msg(err));
    console.error('Sampiyona dokunulmadi.');
    process.exit(1);
  });
}
