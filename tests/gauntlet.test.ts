import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGauntlet } from '../src/strategy/gauntlet';
import { compileStrategy } from '../src/strategy/validator';
import { loadDataset } from '../src/engine/dataset';
import { decisionPoints } from '../src/engine/backtest';
import type { WorkerInit, WorkerJob } from '../src/strategy/sandbox/protocol';

/**
 * Gauntlet'in KENDI regresyon takimi.
 *
 * Bir korumanin degeri, onu gecmeye calisan seyle olculur. Buradaki hilekarlar kalicidir:
 * gauntlet'e her dokunusta yeniden kosarlar. "Look-ahead testi yaziyorum" demek kolay;
 * o testin gercekten gelecege bakan bir stratejiyi YAKALADIGINI gostermek baska bir sey.
 */

const DAY = 86_400_000;
const SYMBOLS = ['BTCUSDT'];
const endDate = Date.now();
const startDate = endDate - 120 * DAY;

function apiDts(): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'strategy', 'types.ts'), 'utf8');
  return src
    .replace(/export function isSignal[\s\S]*?\n}/, 'export declare function isSignal(d: StrategyDecision): d is StrategySignal;')
    .replace(/export function isVeto[\s\S]*?\n}/, 'export declare function isVeto(d: StrategyDecision): d is StrategyVeto;');
}

function build(body: string, extra = ''): WorkerInit {
  const src = `
import type { Strategy, StrategyContext, StrategyDecision, StrategyFactory } from './strategy-api';
${extra}
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

  const ds = loadDataset({ symbols: SYMBOLS, interval: '4h', startDate, endDate });
  const init: WorkerInit = {
    compiledJs: c.js!,
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

const JOB: WorkerJob = { cellIndex: 0, params: {}, profile: 'balanced', macroRiskAppetite: null };

describe('gauntlet: durust strateji GECER', () => {
  it('sadece gecmisi okuyan deterministik strateji tum kontrolleri gecer', async () => {
    const init = build(`
  const rsi = ctx.indicators.rsi;
  if (rsi === null) return null;
  if (rsi < 35) return { side: 'LONG', confidence: 0.7 };
  if (rsi > 65) return { side: 'SHORT', confidence: 0.7 };
  return { veto: true, rule: 'NO_EDGE' };`);

    const r = await runGauntlet({ init, job: JOB });
    if (!r.pass) console.error(r.checks);

    expect(r.checks['determinizm']!.pass).toBe(true);
    expect(r.checks['look-ahead']!.pass).toBe(true);
    expect(r.checks['saglik']!.pass).toBe(true);
    expect(r.pass).toBe(true);
  }, 180_000);
});

describe('gauntlet: hilekarlar YAKALANIR', () => {
  /**
   * HILEKAR 1 — dejenere strateji.
   * Her mumda sinyal veriyor: backtest'te islem sayisini sisirip istatistiki guveni
   * (gridScoring'in sqrt(trades/100) carpani) sahte sekilde yukseltir.
   */
  it('her mumda sinyal veren dejenere strateji SAGLIK kontrolunden duser', async () => {
    const init = build(`  return { side: 'LONG', confidence: 0.9 };`);
    const r = await runGauntlet({ init, job: JOB });

    expect(r.checks['saglik']!.pass).toBe(false);
    expect(r.checks['saglik']!.detail).toMatch(/dejenere/);
    expect(r.pass).toBe(false);
  }, 180_000);

  /**
   * HILEKAR 2 — hic sinyal uretmeyen strateji.
   * Backtest'i "0 islem, 0 kayip" ile gecmeye calisir; kapinin AZ_ISLEM diskalifiyesi
   * zaten yakalar ama boyle bir aday Codex'in zamanini bosa harcar — burada eler.
   */
  it('hic sinyal uretmeyen strateji SAGLIK kontrolunden duser', async () => {
    const init = build(`  return { veto: true, rule: 'NEVER' };`);
    const r = await runGauntlet({ init, job: JOB });

    expect(r.checks['saglik']!.pass).toBe(false);
    expect(r.checks['saglik']!.detail).toMatch(/hic sinyal/);
  }, 180_000);

  /**
   * HILEKAR 3 — sonsuz dongu.
   * Gece dongusunu kilitlemeye calisir. Worker OLDURULUR ve gauntlet basarisiz doner;
   * sampiyona dokunulmaz.
   */
  it('sonsuz dongu gauntlet i kilitlemez, hucreyi dusurur', async () => {
    const init = build(`
  let x = 0;
  while (true) { x = x + 1; }
  return null;`);

    const r = await runGauntlet({ init, job: { ...JOB }, timeoutMs: 4_000 });
    expect(r.pass).toBe(false);
    expect(r.checks['calisma']!.pass).toBe(false);
  }, 60_000);
});

/**
 * LOOK-AHEAD testinin GECERLILIGI.
 *
 * Kritik soru: zehir testi gercekten gelecege bakan bir stratejiyi yakalayabilir mi,
 * yoksa her zaman mi yesil yaniyor?
 *
 * Sistemde look-ahead YAPISAL olarak imkansiz: strateji yalnizca ctx'i gorur ve ctx'i
 * her zaman BIZIM context.ts'imiz keser. Yani bir strateji ne kadar isterse istesin
 * gelecek mumu goremez — gorecek bir kanali yok.
 *
 * O halde zehir testi neyi koruyor? BIZIM KESIM KODUMUZU. Asagidaki test tam olarak
 * bunu kanitlar: context.ts'in `openTime < t` kesitini `<=` yapan bir regresyonu
 * simule eder (zehir noktasini bir mum KAYDIRARAK) ve testin KIRMIZI yandigini gosterir.
 * Boylece "look-ahead: pass" satiri bos bir teselli degil, gercek bir sinyal olur.
 */
describe('gauntlet: look-ahead testi GERCEKTEN calisiyor mu?', () => {
  it('zehirlenmis mum karara sizsaydi test KIRMIZI yanardi', async () => {
    // Fiyata dogrudan bakan bir strateji: zehir (1e9) sizarsa karari kesin degisir.
    const init = build(`
  const last = ctx.candles[ctx.candles.length - 1];
  if (!last) return null;
  const prev = ctx.candles[ctx.candles.length - 2];
  if (!prev) return null;
  return last.close > prev.close
    ? { side: 'LONG', confidence: 0.6 }
    : { side: 'SHORT', confidence: 0.6 };`);

    // Once gercek gauntlet: temiz gecmeli (kesim dogru).
    const clean = await runGauntlet({ init, job: JOB });
    expect(clean.checks['look-ahead']!.pass).toBe(true);

    // Simdi kesim kodunun BOZUK oldugu senaryoyu elle kur: zehirlenmis veriyi
    // dogrudan besleyip kararlarin gercekten DEGISTIGINI gosterelim. Yani zehir
    // etkili bir zehir — testin yesil yanmasi, zehrin etkisiz olmasindan degil,
    // kesimin dogru olmasindan.
    const { SandboxPool } = await import('../src/strategy/sandbox/host');
    const ref = init.klines['BTCUSDT']!;
    const idx = Math.floor(ref.length * 0.7);

    // Zehri BIR MUM ERKEN baslat: artik karar barinin GORDUGU son kapali mum da cop.
    // Kesim dogru olsa bile bu kararlari degistirmeli — zehrin etkili oldugunun kaniti.
    const shifted = {
      ...init,
      klines: {
        BTCUSDT: ref.map((k, i) =>
          i < idx - 1 ? k : { ...k, open: 1e9, high: 1e9, low: 1e9, close: 1e9, volume: 0 },
        ),
      },
    };

    const poolA = SandboxPool.create(init, { workers: 1, timeoutMs: 120_000 });
    const poolB = SandboxPool.create(shifted, { workers: 1, timeoutMs: 120_000 });
    try {
      const a = await poolA.run(JOB);
      const b = await poolB.run(JOB);

      const poisonTime = ref[idx]!.openTime;
      const aClean = JSON.stringify(a.filter((d) => d.timestamp <= poisonTime));
      const bClean = JSON.stringify(b.filter((d) => d.timestamp <= poisonTime));

      // Zehir bir mum erken basladiginda kararlar DEGISIYOR -> zehir etkili,
      // test gercekten bir sey olcuyor.
      expect(aClean).not.toBe(bClean);
    } finally {
      await poolA.close();
      await poolB.close();
    }
  }, 300_000);
});
