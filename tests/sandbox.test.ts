import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { SandboxPool } from '../src/strategy/sandbox/host';
import { compileStrategy } from '../src/strategy/validator';
import { loadDataset } from '../src/engine/dataset';
import { decisionPoints } from '../src/engine/backtest';
import type { WorkerInit } from '../src/strategy/sandbox/protocol';

/**
 * DUVAR 4'un testi — statik kontroller ATLANARAK.
 *
 * Buradaki her ornek validator'i (Duvar 2) zaten gecemezdi. Onlari kasten BYPASS edip
 * dogrudan sandbox'a veriyoruz: cunku katmanli savunmanin anlami, HER katmanin tek
 * basina da tutmasidir. "Validator zaten yakalar" demek, validator'da bir bug ciktigi
 * gun sistemin ciplak kalmasi demektir.
 */

const DAY = 86_400_000;

function apiDts(): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'strategy', 'types.ts'), 'utf8');
  return src
    .replace(/export function isSignal[\s\S]*?\n}/, 'export declare function isSignal(d: StrategyDecision): d is StrategySignal;')
    .replace(/export function isVeto[\s\S]*?\n}/, 'export declare function isVeto(d: StrategyDecision): d is StrategyVeto;');
}

/**
 * Strateji kaynagini derler.
 *
 * getGlobal(): test iskelesi — realm'in global objesine DOGRUDAN erisir.
 *
 * Not: ilk denememde bunu `Function('return this')()` ile yazmistim ve testler
 * "EvalError: Code generation from strings disallowed" ile dustu. Yani sandbox, testin
 * varsaydigindan gucluydu: kacis girisiminin ILK adimi bile calismadi. Simdi en kotu
 * senaryoyu variyoruz — saldirganin realm global'ine TAM erisimi olsun — ve orada
 * ne process'in ne Date'in BULUNMADIGINI kanitliyoruz.
 */
function compileRaw(body: string): string {
  const src = `
import type { Strategy, StrategyContext, StrategyDecision, StrategyFactory } from './strategy-api';

function getGlobal(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function evaluate(ctx: StrategyContext): StrategyDecision {
${body}
}

const factory: StrategyFactory = (): Strategy => ({
  meta: { id: 't', name: 'T', version: 1, author: 'codex', warmupBars: 250, needs: {}, params: [] },
  evaluate,
});
export default factory;`;
  const c = compileStrategy(src, apiDts());
  if (!c.ok) throw new Error('derlenmedi: ' + JSON.stringify(c.diagnostics));
  return c.js!;
}

// --- Gercek veriyle minik bir init ------------------------------------------------

const SYMBOLS = ['BTCUSDT'];
const endDate = Date.now();
const startDate = endDate - 30 * DAY;

function makeInit(compiledJs: string): WorkerInit {
  const ds = loadDataset({ symbols: SYMBOLS, interval: '4h', startDate, endDate });
  const init: WorkerInit = {
    compiledJs,
    symbols: SYMBOLS,
    interval: '4h',
    points: decisionPoints(startDate, endDate, '4h'),
    klines: ds.klines,
    indicators: ds.indicators,
    funding: ds.funding,
  };
  ds.close();
  return init;
}

const pools: SandboxPool[] = [];
function pool(compiledJs: string, timeoutMs = 20_000): SandboxPool {
  const p = SandboxPool.create(makeInit(compiledJs), { workers: 1, timeoutMs });
  pools.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

const JOB = { cellIndex: 0, params: {}, profile: 'balanced' as const, macroRiskAppetite: null };

describe('sandbox: normal calisma', () => {
  it('gecerli strateji sinyal uretir', async () => {
    const js = compileRaw(`
  const rsi = ctx.indicators.rsi;
  if (rsi === null) return null;
  if (rsi < 35) return { side: 'LONG', confidence: 0.7 };
  if (rsi > 65) return { side: 'SHORT', confidence: 0.7 };
  return { veto: true, rule: 'NO_EDGE' };`);

    const decisions = await pool(js).run(JOB);
    expect(decisions.length).toBeGreaterThan(0);

    const allocs = decisions.flatMap((d) => d.allocations);
    expect(allocs.length).toBeGreaterThan(0);

    // KALDIRAC harness tarafindan atanir — strateji ona dokunamadi ve dokunamaz.
    for (const a of allocs) {
      expect(a.leverage).toBeGreaterThan(0);
      expect(a.leverage).toBeLessThanOrEqual(10); // portfolio.MAX_LEVERAGE
      expect(a.allocationPercent).toBeGreaterThanOrEqual(5);
    }
  }, 60_000);

  it('AYNI girdi -> AYNI cikti (determinizm)', async () => {
    const js = compileRaw(`
  const rsi = ctx.indicators.rsi;
  if (rsi === null) return null;
  return rsi < 50 ? { side: 'LONG', confidence: 0.6 } : { side: 'SHORT', confidence: 0.6 };`);

    const p = pool(js);
    const a = await p.run(JOB);
    const b = await p.run(JOB);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 60_000);
});

describe('sandbox: kacis denemeleri (validator BYPASS edilerek)', () => {
  it('realm de process YOKTUR', async () => {
    // TS tip kontrolunu atlatmak icin globalThis uzerinden dolaniyoruz — gercek bir
    // saldirganin yapacagi sey. Realm'de globalThis.process tanimsizdir.
    const js = compileRaw(`
  const g = getGlobal();
  if (g && g['process']) return { side: 'LONG', confidence: 1 };  // KACIS BASARILI olsaydi
  return { veto: true, rule: 'NO_PROCESS' };`);

    const decisions = await pool(js).run(JOB);
    // Hicbir sinyal uretilmemeli: process bulunamadi -> hep veto.
    expect(decisions.flatMap((d) => d.allocations)).toHaveLength(0);
    expect(decisions.some((d) => d.rejections.some((r) => r.rule === 'NO_PROCESS'))).toBe(true);
  }, 60_000);

  it('realm de kod uretimi KAPALI — Function("...") EvalError firlatir', async () => {
    // Realm global'inde Function VARDIR (V8 intrinsic'i), ama codeGeneration.strings=false
    // oldugu icin STRING'den kod uretemez. Kacis zincirinin ilk halkasi burada kopar.
    const js = compileRaw(`
  const g = getGlobal();
  const F = g['Function'] as (src: string) => () => unknown;
  const leak = F('return typeof process')();   // <- EvalError
  return { side: 'LONG', confidence: 1 };`);

    // Sessizce yutulmaz: hucre GURULTULU sekilde patlar.
    await expect(pool(js).run(JOB)).rejects.toThrow(/Code generation from strings disallowed/i);
  }, 60_000);

  it('kod uretimi denemesi yakalansa bile hicbir sinyal uretemez', async () => {
    const js = compileRaw(`
  const g = getGlobal();
  try {
    const F = g['Function'] as (src: string) => () => unknown;
    F('return process')();
    return { side: 'LONG', confidence: 1 };   // kod uretimi calissaydi buraya gelirdi
  } catch (e) {
    return { veto: true, rule: 'CODEGEN_BLOCKED' };
  }`);

    const decisions = await pool(js).run(JOB);
    expect(decisions.flatMap((d) => d.allocations)).toHaveLength(0);
    expect(decisions.some((d) => d.rejections.some((r) => r.rule === 'CODEGEN_BLOCKED'))).toBe(true);
  }, 60_000);

  it('Math.random() cagrilirsa GURULTULU olur (sessizce non-deterministik olmaz)', async () => {
    const js = compileRaw(`
  const m: any = Math;
  m.random();
  return { side: 'LONG', confidence: 0.9 };`);

    // Strateji patlar -> hucre hata verir. Sessizce rastgele sonuc URETMEZ.
    await expect(pool(js).run(JOB)).rejects.toThrow(/random/i);
  }, 60_000);

  it('Date realm de tanimsiz (saat okunamaz)', async () => {
    const js = compileRaw(`
  const g = getGlobal();
  if (g['Date']) return { side: 'LONG', confidence: 1 };
  return { veto: true, rule: 'NO_DATE' };`);

    const decisions = await pool(js).run(JOB);
    expect(decisions.flatMap((d) => d.allocations)).toHaveLength(0);
  }, 60_000);

  it('ctx DONDURULMUS — mutasyon veriyi bozamaz', async () => {
    const js = compileRaw(`
  const c: any = ctx;
  try {
    c.params.injected = 999;
    (c.candles as any).push({ close: 1e9 });
  } catch (e) { /* strict mode: TypeError */ }
  // Mutasyon tuttuysa candles uzunlugu degisirdi; tutmadiysa veri saglam.
  return { veto: true, rule: 'LEN_' + ctx.candles.length };`);

    const decisions = await pool(js).run(JOB);
    const rules = new Set(decisions.flatMap((d) => d.rejections.map((r) => r.rule)));
    // Mum sayisi hep 250 (lookback penceresi) — push tutmadi.
    expect([...rules].every((r) => r === 'LEN_250')).toBe(true);
  }, 60_000);

  it('sonsuz dongu worker OLDURULEREK kesilir (havuz kilitlenmez)', async () => {
    const js = compileRaw(`
  while (true) { /* vm icinden kesilemez — tek cikis worker.terminate() */ }
  return null;`);

    const p = pool(js, 3_000);
    await expect(p.run(JOB)).rejects.toThrow(/bitmedi|oldur/i);

    // Havuz kendini toparlamis olmali: yeni worker dogmus, yeni is kabul edilebilir.
    expect(p.size).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
