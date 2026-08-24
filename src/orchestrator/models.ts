import fs from 'node:fs';
import path from 'node:path';
import { STRATEGIES_DIR, env } from '../config/env';
import { DEFAULT_RISK_PARAMS, type RiskParams } from '../engine/riskManagement';
import { DEFAULT_COSTS, type CostConfig } from '../engine/costModel';
import { loadMeta } from '../strategy/loader';
import { promoteChampion, readChampion, sha256, type ChampionRecord } from './champion';
import type { ChallengeResult } from '../engine/challenge';
import type { PromotionVerdict } from '../engine/promotion';
import type { CandleInterval } from '../config/env';
import type { StrategyProfile } from '../lib/types';

/**
 * MODEL DEFTERI — "canliya alabilecegim ne var?"
 *
 * Promosyon kapisi (engine/promotion.ts) sorunun BIR tanesini cevaplar: "bu aday sansi
 * eleyebildi mi?". Ama operatorun sordugu soru baskadir: "elimde ne var ve hangisini
 * kosturuyorum?". Kapi otomatik promosyonun bekcisidir; bu dosya ELLE secimin defteridir.
 *
 * Ikisi birbirinin yerine gecmez ve BIRI DIGERINI IPTAL ETMEZ:
 *
 *   - Kapi hala her gece calisir ve hukmunu verir.
 *   - Elle secim kapiyi BYPASS EDER — ama kapinin o model hakkindaki hukmu (engeller
 *     dahil) kayitta ve listede DURUR. Bypass etmek ile bilmemek ayri seylerdir; bu
 *     defterin tek isi, elle verilen kararin bilgili bir karar olmasini saglamak.
 *   - Elle aktive edilen kayitta `activatedBy: 'operator'` yazar. Denetim izi, kapinin
 *     onaylamadigi bir modeli onaylamis gibi gostermez.
 *
 * ACIK POZISYONLAR: model degistirmek pozisyon kapatmaz. Defter (lib/liveState.ts:94)
 * sampiyon degistiginde acik pozisyonlari KORUR, yalnizca cikis/cooldown gecmisini siler
 * — pozisyonlar borsada gercekten duruyor ve yonetilmeye (breakeven/TP/SL) devam ediyor.
 */

export type ModelOrigin = 'builtin' | 'candidate' | 'champion';

/** Kapinin bir model hakkindaki hukmu — elle secimde bilgi, otomatikte karar. */
export interface ModelGate {
  promote: boolean;
  blockers: string[];
  warnings: string[];
  incumbentQualified: boolean | null;
}

export interface ModelEvaluation {
  verdict: string;
  testPnlPct: number;
  testMar: number;
  testMaxDDPct: number;
  testTrades: number;
  windowsPositive: number;
  windowCount: number;
  stressPnlPct: number;
  holdoutPnlPct: number;
  holdoutMaxDDPct: number;
  qualifiedNeighbors: number;
  feeShareOfGross: number;
}

/**
 * Bir adayin degerlendirme kaydi — `strategies/candidates/<runId>/evaluation.json`.
 *
 * Bu dosya olmadan aday LISTELENEBILIR ama AKTIVE EDILEMEZ: canliya cikmak icin kodun
 * yani sira kazanan grid hucresinin parametreleri (params + risk) gerekir. Onlar olmadan
 * "hangi stratejiyi kosturdugumuz" sorusunun cevabi yoktur.
 */
export interface CandidateEvaluation {
  runId: string;
  evaluatedAt: number;
  strategyId: string;
  name: string;
  author: 'human' | 'codex';
  codeSha256: string;
  params: Record<string, number | boolean>;
  risk: RiskParams;
  symbols: string[];
  interval: CandleInterval;
  profile: StrategyProfile;
  costConfig: CostConfig;
  provenance?: { arxivId?: string; arxivTitle?: string; hypothesis?: string };
  evaluation: ModelEvaluation;
  gate: ModelGate;
}

/** Listede gorunen tek satir. */
export interface ModelListing {
  id: string;
  origin: ModelOrigin;
  name: string;
  strategyId: string;
  version: number;
  author: 'human' | 'codex';
  codePath: string;
  codeSha256: string;
  /** Su an canlida olan model mi? */
  isChampion: boolean;
  /** Kodu diskte duruyor ve sha tutuyor mu? false ise aktive EDILEMEZ. */
  runnable: boolean;
  /** Aktive edilemiyorsa sebebi. */
  blockedReason?: string;
  params: Record<string, number | boolean>;
  risk: RiskParams;
  symbols: string[];
  interval: CandleInterval;
  profile: StrategyProfile;
  provenance?: { arxivId?: string; arxivTitle?: string; hypothesis?: string };
  evaluation: ModelEvaluation | null;
  gate: ModelGate | null;
  /** Aday icin degerlendirme zamani, sampiyon icin promosyon zamani. */
  at: number;
  activatedBy?: 'gate' | 'operator';
}

const CANDIDATES_DIR = path.join(STRATEGIES_DIR, 'candidates');
const HISTORY_DIR = path.join(STRATEGIES_DIR, 'history');
const BUILTIN_PATH = 'src/strategy/builtin/mechanicalV0.ts';
export const BUILTIN_ID = 'mechanical-v0@builtin';

/** Aday degerlendirmesini diske yazar — listenin ve aktivasyonun kaynagi. */
export function saveCandidateEvaluation(runId: string, ev: CandidateEvaluation): void {
  const dir = path.join(CANDIDATES_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evaluation.json'), JSON.stringify(ev, null, 2));
}

export interface BuildEvaluationArgs {
  runId: string;
  source: string;
  result: ChallengeResult;
  verdict: PromotionVerdict;
  symbols: string[];
  interval: CandleInterval;
  profile: StrategyProfile;
}

/**
 * Bir yarisma sonucunu diske yazilabilir bir aday kaydina cevirir.
 *
 * Gece dongusu ve elle kosulan scripts/challenge.ts AYNI fonksiyonu kullanir — iki yerde
 * iki farkli kayit sekli olsaydi liste, hangi yoldan uretildigine gore farkli davranan
 * satirlar gosterirdi.
 *
 * Kosu basarisizsa null doner: degerlendirilememis bir adayin kaydi, listede aktive
 * edilebilir gibi gorunen bos bir satir uretirdi.
 */
export async function buildCandidateEvaluation(
  args: BuildEvaluationArgs,
): Promise<CandidateEvaluation | null> {
  const r = args.result;
  if (!r.ok || !r.evaluated || !r.selection || !r.stress || !r.holdout) return null;

  const meta = (await loadMeta(args.source)).meta;
  const best = r.selection.best;
  const e = r.evaluated;

  return {
    runId: args.runId,
    evaluatedAt: Date.now(),
    strategyId: meta.id,
    name: meta.name,
    author: meta.author === 'codex' ? 'codex' : 'human',
    codeSha256: r.codeSha256,
    params: best.params,
    risk: best.risk,
    symbols: [...args.symbols],
    interval: args.interval,
    profile: args.profile,
    costConfig: DEFAULT_COSTS,
    ...(meta.provenance ? { provenance: meta.provenance } : {}),
    evaluation: {
      verdict: e.verdict,
      testPnlPct: e.test.totalPnlPercent,
      testMar: e.test.mar,
      testMaxDDPct: e.test.maxDrawdownPercent,
      testTrades: e.test.totalTrades,
      windowsPositive: e.windowsPositive,
      windowCount: e.windowCount,
      stressPnlPct: r.stress.totalPnlPercent,
      holdoutPnlPct: r.holdout.totalPnlPercent,
      holdoutMaxDDPct: r.holdout.maxDrawdownPercent,
      qualifiedNeighbors: e.qualifiedNeighbors,
      feeShareOfGross: e.test.feeShareOfGross,
    },
    gate: {
      promote: args.verdict.promote,
      blockers: args.verdict.blockers,
      warnings: args.verdict.warnings,
      incumbentQualified: args.verdict.incumbentQualified,
    },
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Kodun diskte olup olmadigini ve sha'sinin tuttugunu dogrular.
 *
 * Liste, aktive EDILEMEYECEK bir modeli gizlemez — gosterir ve sebebini yazar. Gizlemek,
 * operatorun "neden burada yok?" diye aramasina yol acardi; sebebi yazmak ise dogrudan
 * onarilabilir bir hata mesajidir (dosya silinmis / elle duzenlenmis).
 */
function checkCode(codePath: string, expectedSha: string): { runnable: boolean; reason?: string } {
  if (!fs.existsSync(codePath)) return { runnable: false, reason: `kod bulunamadi: ${codePath}` };
  if (!expectedSha) return { runnable: true };

  const actual = sha256(fs.readFileSync(codePath, 'utf8'));
  if (actual !== expectedSha) {
    return {
      runnable: false,
      reason: `kod degismis — beklenen sha ${expectedSha.slice(0, 12)}, bulunan ${actual.slice(0, 12)}`,
    };
  }
  return { runnable: true };
}

function fromChampionRecord(rec: ChampionRecord, isChampion: boolean): ModelListing {
  const check = checkCode(rec.codePath, rec.codeSha256);
  return {
    id: `${rec.strategyId}@${rec.version}`,
    origin: 'champion',
    name: rec.name,
    strategyId: rec.strategyId,
    version: rec.version,
    author: rec.author,
    codePath: rec.codePath,
    codeSha256: rec.codeSha256,
    isChampion,
    runnable: check.runnable,
    ...(check.reason ? { blockedReason: check.reason } : {}),
    params: rec.params,
    risk: rec.risk,
    symbols: rec.symbols,
    interval: rec.interval,
    profile: rec.profile,
    ...(rec.provenance ? { provenance: rec.provenance } : {}),
    evaluation: rec.evaluation,
    gate: rec.gate ?? null,
    at: rec.promotedAt,
    activatedBy: rec.activatedBy ?? 'gate',
  };
}

/**
 * Canliya alinabilecek TUM modeller — builtin + gecmis sampiyonlar + degerlendirilmis
 * adaylar. En yeni once.
 *
 * TEKILLESTIRME KODUN SHA'SI UZERINDEN YAPILIR, id uzerinden DEGIL.
 *
 * Bir aday promote edildiginde iki yerde birden var olur: kaynak dizininde aday olarak
 * (`candidate:<runId>`) ve promosyon kaydi olarak (`<strategyId>@<version>`). Bunlarin
 * id'leri hicbir zaman esitlenmez, dolayisiyla id ile tekillestirme AYNI MODELI listede
 * iki kez gosterir — operator birini secip digerini "baska bir model" sanabilir.
 *
 * Ayni kod = ayni model. Sampiyon kaydi kazanir: o, kodu immutable dizine kopyalanmis ve
 * her okumada sha'si dogrulanan surumdur; aday dizini ise uzerine yazilabilir.
 */
export async function listModels(): Promise<ModelListing[]> {
  const out: ModelListing[] = [];
  const seen = new Set<string>();
  /** Sampiyon kaydi olarak zaten listelenmis kodlarin sha'lari. */
  const seenSha = new Set<string>();

  const current = readChampion();
  const currentId = current ? `${current.strategyId}@${current.version}` : BUILTIN_ID;

  // --- 1. Mevcut sampiyon + gecmis sampiyonlar.
  if (current) {
    out.push(fromChampionRecord(current, true));
    seen.add(currentId);
    if (current.codeSha256) seenSha.add(current.codeSha256);
  }

  if (fs.existsSync(HISTORY_DIR)) {
    for (const f of fs.readdirSync(HISTORY_DIR).filter((x) => x.endsWith('.json'))) {
      const rec = readJson<ChampionRecord>(path.join(HISTORY_DIR, f));
      if (!rec) continue;
      const id = `${rec.strategyId}@${rec.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (rec.codeSha256) seenSha.add(rec.codeSha256);
      out.push(fromChampionRecord(rec, false));
    }
  }

  // --- 2. Builtin. Promosyon kaydi yoksa canlida kosan odur.
  //
  // Builtin de SHA ile tekillestirilir. Elle aktive edildiginde promosyon kaydi olarak
  // (`<strategyId>@<version>`) listelenir ve o kaydin id'si BUILTIN_ID ile hicbir zaman
  // esitlenmez — yalnizca id'ye bakmak ayni kodu listede iki satir olarak gosterirdi
  // (biri "Mechanical V0" builtin, digeri "Mechanical V0" sampiyon).
  const builtinSource = fs.readFileSync(BUILTIN_PATH, 'utf8');
  const builtinSha = sha256(builtinSource);

  if (!seen.has(BUILTIN_ID) && !seenSha.has(builtinSha)) {
    const meta = (await loadMeta(builtinSource)).meta;
    const params: Record<string, number | boolean> = {};
    for (const p of meta.params) params[p.key] = p.default;

    seenSha.add(builtinSha);
    out.push({
      id: BUILTIN_ID,
      origin: 'builtin',
      name: meta.name,
      strategyId: meta.id,
      version: 0,
      author: 'human',
      codePath: BUILTIN_PATH,
      codeSha256: builtinSha,
      isChampion: currentId === BUILTIN_ID,
      runnable: true,
      params,
      risk: DEFAULT_RISK_PARAMS,
      symbols: [...env.nightly.symbols],
      interval: env.nightly.interval,
      profile: 'balanced',
      // Builtin hicbir kapidan gecmedi: sistemin baslangic noktasi, sinav vermis bir
      // strateji degil. Listede bunu bos birakmak dogru — uydurma bir hukum yazmak degil.
      evaluation: null,
      gate: null,
      at: 0,
    });
  }

  // --- 3. Degerlendirilmis adaylar.
  if (fs.existsSync(CANDIDATES_DIR)) {
    for (const runId of fs.readdirSync(CANDIDATES_DIR)) {
      const dir = path.join(CANDIDATES_DIR, runId);
      if (!fs.statSync(dir).isDirectory()) continue;

      const codePath = path.join(dir, 'strategy.ts');
      const ev = readJson<CandidateEvaluation>(path.join(dir, 'evaluation.json'));

      if (!ev) {
        // Kodu var, degerlendirmesi yok: params/risk bilinmedigi icin AKTIVE EDILEMEZ.
        // Yine de gosterilir — "neden listede yok?" sorusunu dogurmasin.
        if (!fs.existsSync(codePath)) continue;
        out.push({
          id: `candidate:${runId}`,
          origin: 'candidate',
          name: runId,
          strategyId: runId,
          version: 0,
          author: 'codex',
          codePath,
          codeSha256: '',
          isChampion: false,
          runnable: false,
          blockedReason:
            'degerlendirme kaydi yok (evaluation.json) — kazanan grid hucresinin ' +
            'parametreleri bilinmedigi icin canliya alinamaz',
          params: {},
          risk: DEFAULT_RISK_PARAMS,
          symbols: [],
          interval: env.nightly.interval,
          profile: 'balanced',
          evaluation: null,
          gate: null,
          at: 0,
        });
        continue;
      }

      // Bu kod zaten listelendi mi: sampiyon/gecmis kaydi olarak, builtin olarak veya
      // baska bir aday dizininde (ayni strateji iki gece kosusunda yeniden uretilebilir).
      // Tekrar gosterme (bkz. listModels basi).
      if (ev.codeSha256 && seenSha.has(ev.codeSha256)) continue;
      if (ev.codeSha256) seenSha.add(ev.codeSha256);

      const check = checkCode(codePath, ev.codeSha256);
      out.push({
        id: `candidate:${runId}`,
        origin: 'candidate',
        name: ev.name,
        strategyId: ev.strategyId,
        version: 0,
        author: ev.author,
        codePath,
        codeSha256: ev.codeSha256,
        isChampion: false,
        runnable: check.runnable,
        ...(check.reason ? { blockedReason: check.reason } : {}),
        params: ev.params,
        risk: ev.risk,
        symbols: ev.symbols,
        interval: ev.interval,
        profile: ev.profile,
        ...(ev.provenance ? { provenance: ev.provenance } : {}),
        evaluation: ev.evaluation,
        gate: ev.gate,
        at: ev.evaluatedAt,
      });
    }
  }

  return out.sort((a, b) => {
    if (a.isChampion !== b.isChampion) return a.isChampion ? -1 : 1;
    return b.at - a.at;
  });
}

/** `strategyId` icin bir sonraki surum numarasi. */
function nextVersion(strategyId: string, models: ModelListing[]): number {
  const versions = models
    .filter((m) => m.origin === 'champion' && m.strategyId === strategyId)
    .map((m) => m.version);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

export interface ActivateResult {
  record: ChampionRecord;
  /** Aktive edilen model kapiyi gecmis miydi? false ise operator kapiyi bypass etti. */
  gatePassed: boolean;
}

/**
 * Bir modeli ELLE canliya alir.
 *
 * Kapiyi calistirmaz ve beklemez: bu, operatorun bilincli karari. Ama kapinin o model
 * hakkinda daha once verdigi hukum kayda gecer (`record.gate`) ve kaydin `activatedBy`
 * alani 'operator' olur — boylece "kapi onayladi" ile "operator secti" hicbir raporda
 * birbirine karismaz.
 *
 * Acik pozisyonlara DOKUNMAZ (bkz. dosya basi).
 */
export async function activateModel(id: string): Promise<ActivateResult> {
  const models = await listModels();
  const model = models.find((m) => m.id === id);

  if (!model) throw new Error(`model bulunamadi: ${id}`);
  if (model.isChampion) throw new Error(`${model.name} zaten canlida`);
  if (!model.runnable) throw new Error(`${model.name} canliya alinamaz: ${model.blockedReason}`);

  const source = fs.readFileSync(model.codePath, 'utf8');

  // Kodun sha'si listelenmeden once dogrulandi; yine de aradaki surede degismis olabilir.
  // Iki kontrol arasindaki pencere kucuk ama sifir degil ve bedeli canlida yanlis kod.
  if (model.codeSha256 && sha256(source) !== model.codeSha256) {
    throw new Error(`${model.name}: kod listelendikten sonra degisti, aktivasyon iptal`);
  }

  const meta = (await loadMeta(source)).meta;

  const record = promoteChampion({
    source,
    record: {
      strategyId: model.strategyId,
      version: model.origin === 'champion' ? model.version : nextVersion(model.strategyId, models),
      name: model.name,
      author: model.author,
      params: model.params,
      risk: model.risk,
      symbols: model.symbols.length ? model.symbols : [...env.nightly.symbols],
      interval: model.interval,
      profile: model.profile,
      costConfig: DEFAULT_COSTS,
      // Hangi listeleme aktive edildi: denetim izi "elle secildi"nin yani sira
      // NEYIN secildigini de tasimali.
      promotedFromRunId: `manual:${model.id}:${new Date().toISOString()}`,
      ...(model.provenance ?? meta.provenance
        ? { provenance: model.provenance ?? meta.provenance }
        : {}),
      evaluation: model.evaluation ?? EMPTY_EVALUATION,
      ...(model.gate ? { gate: model.gate } : {}),
      activatedBy: 'operator',
      // Canli islem, modeli secmekle DEGIL panelden acmakla baslar. Secim "bundan sonra
      // bu strateji" demektir; para riske etmek ayri ve bilincli bir ikinci adimdir.
      live: { enabled: false, startedAt: 0 },
    },
  });

  return { record, gatePassed: model.gate?.promote ?? false };
}

/** Degerlendirmesi olmayan modeller icin — uydurma sayi yerine acik sifir. */
const EMPTY_EVALUATION: ModelEvaluation = {
  verdict: 'NOT_EVALUATED',
  testPnlPct: 0,
  testMar: 0,
  testMaxDDPct: 0,
  testTrades: 0,
  windowsPositive: 0,
  windowCount: 0,
  stressPnlPct: 0,
  holdoutPnlPct: 0,
  holdoutMaxDDPct: 0,
  qualifiedNeighbors: 0,
  feeShareOfGross: 0,
};
