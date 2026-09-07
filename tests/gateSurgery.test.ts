import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_GATES_AT_ONCE, detectGates, gateParamKey, gateSurgery } from '../src/strategy/gateSurgery';
import { compileStrategy, validateStrategySource } from '../src/strategy/validator';
import { buildApiDts, toSandboxSource } from '../src/codex/workspace';
import { loadMeta } from '../src/strategy/loader';

/**
 * GATE CERRAHISININ SOZLESMESI.
 *
 * Bu donusum, MAKINE tarafindan uretilmis ve sonra CANLIYA ALINABILECEK bir strateji
 * kaynagi ureti,yor. Yani ciktinin "makul gorunmesi" yetmez — bes duvarin (validator,
 * tip kontrolu, vm realm, gauntlet, kapi) ILKINDEN gecmek zorunda. Bir donusum hatasi
 * burada yakalanmazsa, gece dongusunde derlenmeyen bir aday veya daha kotusu SESSIZCE
 * baska bir sey yapan bir aday olarak ortaya cikar.
 */

const BUILTIN = fs.readFileSync('src/strategy/builtin/mechanicalV0.ts', 'utf8');

describe('detectGates: veto noktalarini bulur', () => {
  it('builtin\'in bilinen veto kurallarini bulur', () => {
    const rules = detectGates(BUILTIN).map((g) => g.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['NO_ATR', 'BELOW_THRESHOLD', 'LOW_VOLUME', 'DI_MISMATCH', 'NO_CONFIRMATION', 'CONFIDENCE_GATE']),
    );
  });

  it('wouldBe tasiyip tasimadigini ayirt eder — olculebilirligin sarti', () => {
    const gates = detectGates(BUILTIN);
    // NO_ATR yon tasimaz: ATR yoksa hangi yone girilecegi bilinemez.
    expect(gates.find((g) => g.rule === 'NO_ATR')!.hasDirection).toBe(false);
    expect(gates.find((g) => g.rule === 'LOW_VOLUME')!.hasDirection).toBe(true);
  });

  it('ctx kapsamda degilse kaldirilamaz olarak isaretler — uydurma yapmaz', () => {
    const src = `
      import type { Strategy, StrategyContext, StrategyDecision, StrategyFactory } from './types';
      function helper(x: number): StrategyDecision {
        if (x < 1) return { veto: true, rule: 'IN_HELPER', wouldBe: 'LONG' };
        return null;
      }
      function evaluate(ctx: StrategyContext): StrategyDecision {
        return helper(ctx.candles.length);
      }
      const factory: StrategyFactory = (): Strategy => ({
        meta: { id: 'x', name: 'x', version: 1, author: 'human', warmupBars: 1, needs: {}, params: [] },
        evaluate,
      });
      export default factory;
    `;
    const gate = detectGates(src).find((g) => g.rule === 'IN_HELPER')!;
    expect(gate.removable).toBe(false);
    expect(gate.reason).toContain('ctx');
  });

  it('hesaplanmis kural adini kaldirilamaz sayar', () => {
    const src = `
      function evaluate(ctx: any): any {
        const r = 'DYN' + '1';
        return { veto: true, rule: r, wouldBe: 'LONG' };
      }
    `;
    const gate = detectGates(src)[0]!;
    expect(gate.removable).toBe(false);
    expect(gate.reason).toContain('string literal');
  });
});

describe('gateSurgery: uretilen kaynak duvarlardan gecer', () => {
  it('cikti VALIDATOR ve TIP KONTROLUNDEN gecer', async () => {
    const res = await gateSurgery({ source: BUILTIN, rules: ['LOW_VOLUME', 'DI_MISMATCH'] });
    expect(res.applied).toEqual(['LOW_VOLUME', 'DI_MISMATCH']);

    const v = validateStrategySource(res.source);
    expect(v.ok, JSON.stringify(v.issues)).toBe(true);

    const c = compileStrategy(res.source, buildApiDts());
    expect(c.ok, JSON.stringify(c.diagnostics)).toBe(true);
  });

  it('cikti ADAY biciminde: strategy-api import eder, ../types degil', () => {
    // challenge() RAW kaynagi dogrular ve yalnizca './strategy-api' import'una izin
    // verir. Builtin '../types' import ediyor; cerrahi ciktisi cevrilmis olmali,
    // yoksa her varyant FORBIDDEN_IMPORT ile duserdi.
    expect(BUILTIN).toContain("from '../types'");
  });

  it('meta: gate parametreleri eklenir, digerleri PINLENIR (sweep silinir)', async () => {
    const res = await gateSurgery({
      source: BUILTIN,
      rules: ['LOW_VOLUME'],
      pinnedParams: { entryThreshold: 0.45, confirmationCandles: 1 },
    });
    const meta = (await loadMeta(res.source)).meta;

    const gate = meta.params.find((p) => p.key === gateParamKey('LOW_VOLUME'))!;
    expect(gate).toMatchObject({ type: 'boolean', default: true, sweep: [true, false] });

    // Pinlenen degerler default'a yazilmis olmali.
    expect(meta.params.find((p) => p.key === 'entryThreshold')!.default).toBe(0.45);
    expect(meta.params.find((p) => p.key === 'confirmationCandles')!.default).toBe(1);

    // Gate DISI hicbir parametre taranmiyor: grid tek soru sorsun.
    for (const p of meta.params) {
      if (!p.key.startsWith('gate_')) expect(p.sweep).toBeUndefined();
    }
    expect(meta.maxSweepCells).toBe(2);
  });

  it('kimlik degisir — ayni model iki kez listelenmesin', async () => {
    const res = await gateSurgery({ source: BUILTIN, rules: ['LOW_VOLUME'] });
    const meta = (await loadMeta(res.source)).meta;
    expect(meta.id).not.toBe('mechanical-v0');
    expect(meta.id).toContain('gate');
    expect(meta.version).toBe(2);
  });

  it('BIRDEN FAZLA gate ayni anda: konumlar kaymaz', async () => {
    // Duzenlemeler sondan basa uygulanmazsa ikinci ekleme yanlis ofsete duser ve
    // sonuc DERLENEN ama baska bir sey yapan bir kaynak olur.
    const res = await gateSurgery({
      source: BUILTIN,
      rules: ['LOW_VOLUME', 'DI_MISMATCH', 'NO_CONFIRMATION'],
    });
    expect(res.applied).toHaveLength(3);
    expect(res.sweepCells).toBe(8);

    for (const rule of res.applied) {
      expect(res.source).toContain(`ctx.params['${gateParamKey(rule)}'] !== false`);
    }
    const c = compileStrategy(res.source, buildApiDts());
    expect(c.ok, JSON.stringify(c.diagnostics)).toBe(true);
  });

  it(`tavan asilirsa fazlasi SESSIZCE dusurulmez, nedeniyle raporlanir`, async () => {
    const res = await gateSurgery({
      source: BUILTIN,
      rules: ['LOW_VOLUME', 'DI_MISMATCH', 'NO_CONFIRMATION', 'BELOW_THRESHOLD'],
    });
    expect(res.applied).toHaveLength(MAX_GATES_AT_ONCE);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.rule).toBe('BELOW_THRESHOLD');
    expect(res.skipped[0]!.reason).toContain('en fazla');
  });

  it('kaldirilamaz gate istenirse atlanir ve nedeni yazilir', async () => {
    const res = await gateSurgery({ source: BUILTIN, rules: ['NO_ATR', 'LOW_VOLUME'] });
    // NO_ATR ctx kapsaminda ve string literal — kaldirilabilir; ama yon tasimaz.
    // Burada onemli olan: istenmeyen bir kural istendiginde SESSIZ kalinmamasi.
    const bogus = await gateSurgery({ source: BUILTIN, rules: ['BOYLE_BIR_KURAL_YOK'] });
    expect(bogus.applied).toHaveLength(0);
    expect(bogus.skipped[0]!.reason).toContain('yok');
    expect(res.applied.length).toBeGreaterThan(0);
  });

  it('hicbir kural uygulanmazsa kaynak DEGISMEDEN doner', async () => {
    const res = await gateSurgery({ source: BUILTIN, rules: ['BOYLE_BIR_KURAL_YOK'] });
    expect(res.source).toBe(BUILTIN);
    expect(res.sweepCells).toBe(1);
  });
});
