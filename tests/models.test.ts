import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Model defterinin regresyon takimi.
 *
 * Bu ekranin tek tehlikeli tarafi su: kapiyi BILEREK bypass ediyor. O yuzden test edilen
 * sey "liste dogru mu" degil, asil olarak sunlardir:
 *
 *   - kodu diskte olmayan / sha'si tutmayan bir model AKTIVE EDILEMEZ,
 *   - degerlendirmesi olmayan bir aday AKTIVE EDILEMEZ (params/risk bilinmiyor),
 *   - elle aktivasyon kayda 'operator' olarak gecer ve kapinin hukmunu SILMEZ.
 *
 * Ucu de sessizce bozulabilecek ve bozuldugunda canlida yanlis kod kosturacak seyler.
 */

// vi.hoisted: vi.mock fabrikasi import'larin ustune tasindigi icin TMP'nin de o ana
// kadar hazir olmasi gerekir. Normal bir `const` burada "before initialization" hatasi
// verir.
const TMP = vi.hoisted(
  () => `${process.env.TMPDIR ?? '/tmp'}/qalph-models-${process.pid}-${Date.now()}`,
);

vi.mock('../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../src/config/env')>('../src/config/env');
  return {
    ...actual,
    STRATEGIES_DIR: TMP,
    env: {
      ...actual.env,
      nightly: { ...actual.env.nightly, symbols: ['BTCUSDT', 'ETHUSDT'], interval: '4h' },
    },
  };
});

// vi.mock cagrilari import'larin USTUNE tasinir (vitest hoisting), bu yuzden statik
// import'lar zaten mock'lanmis env'i gorur.
import {
  listModels,
  activateModel,
  saveCandidateEvaluation,
  BUILTIN_ID,
  type CandidateEvaluation,
} from '../src/orchestrator/models';
import { sha256 } from '../src/orchestrator/champion';
import { DEFAULT_RISK_PARAMS } from '../src/engine/riskManagement';
import { DEFAULT_COSTS } from '../src/engine/costModel';

const BASE_SOURCE = fs.readFileSync('src/strategy/builtin/mechanicalV0.ts', 'utf8');

/** Her adayin kodu FARKLI olmali: tekillestirme sha uzerinden calisiyor. */
const sourceFor = (runId: string) => `${BASE_SOURCE}\n// ${runId}\n`;

function writeCandidate(runId: string, opts: { evaluation?: boolean; gatePasses?: boolean } = {}) {
  const dir = path.join(TMP, 'candidates', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'strategy.ts'), sourceFor(runId));

  if (opts.evaluation === false) return;

  saveCandidateEvaluation(runId, {
    runId,
    evaluatedAt: 1_700_000_000_000,
    strategyId: `strat-${runId}`,
    name: `Candidate ${runId}`,
    author: 'codex',
    codeSha256: sha256(sourceFor(runId)),
    params: { entryThreshold: 0.35 },
    risk: { ...DEFAULT_RISK_PARAMS, rewardRatio: 3.5, slMultiplier: 2.2, riskPerTradePct: 0.02 },
    symbols: ['BTCUSDT'],
    interval: '4h',
    profile: 'balanced',
    costConfig: DEFAULT_COSTS,
    evaluation: {
      verdict: 'FRAGILE',
      testPnlPct: 93.5,
      testMar: 2.38,
      testMaxDDPct: 32.7,
      testTrades: 128,
      windowsPositive: 7,
      windowCount: 11,
      stressPnlPct: 55.5,
      holdoutPnlPct: 66.2,
      holdoutMaxDDPct: 32.8,
      qualifiedNeighbors: 31,
      feeShareOfGross: 0.057,
    },
    gate: {
      promote: opts.gatePasses ?? false,
      blockers: opts.gatePasses ? [] : ['walk-forward FRAGILE, must be ROBUST'],
      warnings: [],
      incumbentQualified: false,
    },
  } satisfies CandidateEvaluation);
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('model listesi', () => {
  it('sampiyon kaydi yokken builtin listelenir ve CANLI isaretlenir', async () => {
    const models = await listModels();
    const builtin = models.find((m) => m.id === BUILTIN_ID);

    expect(builtin).toBeDefined();
    expect(builtin!.isChampion).toBe(true);
    expect(builtin!.runnable).toBe(true);
    // Builtin hicbir kapidan gecmedi — uydurma bir degerlendirme gostermemeli.
    expect(builtin!.evaluation).toBeNull();
    expect(builtin!.gate).toBeNull();
  });

  it('degerlendirilmis aday, kapiyi gecemese bile listelenir', async () => {
    writeCandidate('gece-1');

    const cand = (await listModels()).find((m) => m.id === 'candidate:gece-1');

    expect(cand).toBeDefined();
    expect(cand!.runnable).toBe(true);
    expect(cand!.gate?.promote).toBe(false);
    expect(cand!.gate?.blockers).toHaveLength(1);
  });

  it('degerlendirmesi olmayan aday gorunur ama AKTIVE EDILEMEZ', async () => {
    writeCandidate('gece-2', { evaluation: false });

    const cand = (await listModels()).find((m) => m.id === 'candidate:gece-2');

    expect(cand).toBeDefined();
    expect(cand!.runnable).toBe(false);
    expect(cand!.blockedReason).toMatch(/degerlendirme kaydi yok/);
  });

  it('kodu elle degistirilmis aday AKTIVE EDILEMEZ (sha tutmuyor)', async () => {
    writeCandidate('gece-3');
    fs.appendFileSync(path.join(TMP, 'candidates', 'gece-3', 'strategy.ts'), '\n// kurcalandi\n');

    const cand = (await listModels()).find((m) => m.id === 'candidate:gece-3');

    expect(cand!.runnable).toBe(false);
    expect(cand!.blockedReason).toMatch(/kod degismis/);
  });
});

describe('elle aktivasyon', () => {
  it('adayi sampiyon yapar ve kaydi OPERATOR karari olarak damgalar', async () => {
    writeCandidate('gece-1');

    const { record, gatePassed } = await activateModel('candidate:gece-1');

    expect(record.name).toBe('Candidate gece-1');
    expect(record.activatedBy).toBe('operator');
    expect(gatePassed).toBe(false);

    // Kapinin hukmu SILINMEZ: "operator bilerek secti" ile "kapi onayladi" ayri seyler.
    expect(record.gate?.promote).toBe(false);
    expect(record.gate?.blockers).toContain('walk-forward FRAGILE, must be ROBUST');

    // Canli islem secimle DEGIL, panelden ayrica acilir.
    expect(record.live.enabled).toBe(false);
  });

  it('aktivasyondan sonra yeni sampiyon listede CANLI gorunur', async () => {
    writeCandidate('gece-1');
    await activateModel('candidate:gece-1');

    const models = await listModels();
    const live = models.filter((m) => m.isChampion);

    expect(live).toHaveLength(1);
    expect(live[0]!.name).toBe('Candidate gece-1');
    expect(live[0]!.activatedBy).toBe('operator');
  });

  it('promote edilen aday listede IKI KEZ gorunmez', async () => {
    // Aday, promote edildikten sonra iki yerde birden vardir: kaynak dizininde ve
    // promosyon kaydinda. id'leri asla esitlenmez (candidate:gece-1 vs strat-gece-1@1),
    // bu yuzden tekillestirme KODUN SHA'SI uzerinden yapilmali. Yoksa operator ayni
    // modeli listede iki satir olarak gorur ve birini "baska bir model" sanar.
    writeCandidate('gece-1');
    await activateModel('candidate:gece-1');

    const models = await listModels();
    const sameCode = models.filter((m) => m.name === 'Candidate gece-1');

    expect(sameCode).toHaveLength(1);
    // Kalan satir, kodu immutable dizine kopyalanmis ve sha'si dogrulanan surumdur.
    expect(sameCode[0]!.origin).toBe('champion');
    expect(models.some((m) => m.id === 'candidate:gece-1')).toBe(false);
  });

  it('promote EDILMEMIS baska bir aday listede kalir', async () => {
    writeCandidate('gece-1');
    writeCandidate('gece-2');
    await activateModel('candidate:gece-1');

    const ids = (await listModels()).map((m) => m.id);

    expect(ids).toContain('candidate:gece-2');
    expect(ids).not.toContain('candidate:gece-1');
  });

  it('kapiyi gecen bir aday icin gatePassed true doner', async () => {
    writeCandidate('gece-temiz', { gatePasses: true });

    const { gatePassed, record } = await activateModel('candidate:gece-temiz');

    expect(gatePassed).toBe(true);
    // Kapiyi gecmis olsa bile ELLE secildi — damga yine operator.
    expect(record.activatedBy).toBe('operator');
  });

  it('zaten canlida olan model tekrar aktive edilemez', async () => {
    await expect(activateModel(BUILTIN_ID)).rejects.toThrow(/zaten canlida/);
  });

  it('bilinmeyen id reddedilir', async () => {
    await expect(activateModel('candidate:yok-boyle')).rejects.toThrow(/bulunamadi/);
  });

  it('degerlendirmesi olmayan aday aktive edilemez', async () => {
    writeCandidate('gece-2', { evaluation: false });
    await expect(activateModel('candidate:gece-2')).rejects.toThrow(/canliya alinamaz/);
  });
});
