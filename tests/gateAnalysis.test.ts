import { describe, expect, it } from 'vitest';
import { DEFAULT_LIFTED_CONFIDENCE, decideAt, liftVeto } from '../src/engine/signalRunner';
import type { Kline } from '../src/lib/klineStore';
import type { Strategy, StrategyContext, StrategyDecision } from '../src/strategy/types';
import type { TechnicalIndicators } from '../src/vendor/technicalIndicators';

/**
 * KARSI-OLGUSAL OLCUMUN SOZLESMESI.
 *
 * engine/gateAnalysis.ts, "bu filtre olmasaydi ne olurdu" sorusunu bir veto kuralini
 * RECORD gecisinde kaldirarak cevapliyor. Bu, karar akisina dokunan bir yetenek — yani
 * yanlis yazilirsa NORMAL kosuyu da bozar ve bunu kimse fark etmez: gate raporu makul
 * gorunur, ama gece dongusunun ve canlinin urettigi kararlar sessizce degismistir.
 *
 * Bu yuzden buradaki EN ONEMLI test, olcumun kendisi degil, olcum YOKKEN hicbir seyin
 * degismedigidir. Digerleri o duvarin uzerine kuruluyor.
 */

const H4 = 14_400_000;
const T0 = 1_700_000_000_000;
const SYMBOL = 'TESTUSDT';

function klines(count: number): Kline[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + 10 * Math.sin(i / 7);
    const openTime = T0 + i * H4;
    return {
      openTime,
      open: base,
      high: base * 1.01,
      low: base * 0.99,
      close: base * 1.002,
      volume: 1000 + i,
      closeTime: openTime + H4 - 1,
    };
  });
}

const indicators = (count: number): TechnicalIndicators[] =>
  Array.from({ length: count }, () => ({ atr: 2.5, sma200: 100 }) as unknown as TechnicalIndicators);

/**
 * Cift mumda LONG sinyali, tek mumda LOW_VOL veto'su veren iskelet strateji.
 * Veto'nun `wouldBe`'si parametreyle acilip kapanabiliyor — olculebilirlik sartini
 * test edebilmek icin.
 */
function stubStrategy(): Strategy {
  return {
    meta: {
      id: 'gate-test',
      name: 'Gate test',
      version: 1,
      author: 'human',
      warmupBars: 0,
      needs: { funding: false, macro: false, btcRegime: false, history: false },
      params: [
        { key: 'withDirection', type: 'boolean', default: true },
      ],
    },
    evaluate(ctx: StrategyContext): StrategyDecision {
      const i = ctx.candles.length;
      if (i % 2 === 0) return { side: 'LONG', confidence: 0.8, reason: 'cift' };
      return ctx.params['withDirection'] === false
        ? { veto: true, rule: 'LOW_VOL' }
        : { veto: true, rule: 'LOW_VOL', wouldBe: 'SHORT' };
    },
  };
}

function run(over: { lifted?: ReadonlySet<string>; conf?: number; params?: Record<string, number | boolean> }) {
  const ks = klines(40);
  const ind = indicators(40);
  const strategy = stubStrategy();

  return ks.slice(1).map((k) =>
    decideAt({
      strategy,
      symbols: [SYMBOL],
      interval: '4h',
      at: k.openTime,
      klines: { [SYMBOL]: ks },
      indicators: { [SYMBOL]: ind },
      funding: {},
      lsr: {},
      macroRiskAppetite: null,
      profile: 'balanced',
      params: { withDirection: true, ...over.params },
      ...(over.lifted ? { liftedVetoRules: over.lifted } : {}),
      ...(over.conf !== undefined ? { liftedConfidence: over.conf } : {}),
    }),
  );
}

describe('liftVeto: saf davranis', () => {
  it('kural kaldirilmamissa null doner — bugunku yol', () => {
    expect(liftVeto({ veto: true, rule: 'LOW_VOL', wouldBe: 'LONG' }, undefined, undefined)).toBeNull();
    expect(liftVeto({ veto: true, rule: 'LOW_VOL', wouldBe: 'LONG' }, new Set(['BASKA']), undefined)).toBeNull();
  });

  it('wouldBe YOKSA yon uydurmaz — kural kaldirilmis olsa bile null doner', () => {
    // gateAnalysis bu durumu "karsi-olgu alinamaz" diye raporlar; sessizce LONG
    // varsaymak, olcumun tamamini uydurma bir yone dayandirirdi.
    expect(liftVeto({ veto: true, rule: 'LOW_VOL' }, new Set(['LOW_VOL']), 0.7)).toBeNull();
  });

  it('kaldirildiginda wouldBe yonunde sinyal uretir', () => {
    const s = liftVeto({ veto: true, rule: 'LOW_VOL', wouldBe: 'SHORT' }, new Set(['LOW_VOL']), 0.42);
    expect(s).toEqual({ side: 'SHORT', confidence: 0.42, reason: 'karsi-olgu: LOW_VOL kaldirildi' });
  });

  it('gecersiz guven degeri araliga cekilir, NaN varsayilana duser', () => {
    expect(liftVeto({ veto: true, rule: 'R', wouldBe: 'LONG' }, new Set(['R']), 5)!.confidence).toBe(1);
    expect(liftVeto({ veto: true, rule: 'R', wouldBe: 'LONG' }, new Set(['R']), -1)!.confidence).toBe(0);
    expect(liftVeto({ veto: true, rule: 'R', wouldBe: 'LONG' }, new Set(['R']), NaN)!.confidence).toBe(
      DEFAULT_LIFTED_CONFIDENCE,
    );
  });
});

describe('decideAt: kaldirma YOKKEN hicbir sey degismez', () => {
  it('liftedVetoRules verilmeden ve bos Set ile kosu BIREBIR ayni', () => {
    // Bu testin degeri sudur: gate analizi yetenegi karar akisina dokunuyor. Bu esitlik
    // bozulursa gece dongusunun ve canlinin urettigi kararlar da degismis demektir.
    const base = run({});
    const emptyLift = run({ lifted: new Set<string>() });
    expect(JSON.stringify(emptyLift)).toBe(JSON.stringify(base));
  });

  it('HIC tetiklenmemis bir kurali kaldirmak sonucu degistirmez', () => {
    const base = run({});
    const other = run({ lifted: new Set(['HIC_OLMAYAN_KURAL']) });
    expect(JSON.stringify(other)).toBe(JSON.stringify(base));
  });
});

describe('decideAt: kaldirma olcum uretir', () => {
  it('tetiklenen kurali kaldirmak veto\'yu tahsise cevirir', () => {
    const base = run({});
    const lifted = run({ lifted: new Set(['LOW_VOL']), conf: 0.9 });

    const baseVetoes = base.flatMap((d) => d.rejections).filter((r) => r.rule === 'LOW_VOL');
    const liftedVetoes = lifted.flatMap((d) => d.rejections).filter((r) => r.rule === 'LOW_VOL');

    expect(baseVetoes.length).toBeGreaterThan(0);
    expect(liftedVetoes).toHaveLength(0);

    // Elenen her aday bir tahsise donusmeli: kaldirmanin ISLEM sayisina etkisi budur.
    const baseAllocs = base.flatMap((d) => d.allocations).length;
    const liftedAllocs = lifted.flatMap((d) => d.allocations).length;
    expect(liftedAllocs).toBe(baseAllocs + baseVetoes.length);
  });

  it('kaldirilan sinyal verilen guven degerini tasir', () => {
    const lifted = run({ lifted: new Set(['LOW_VOL']), conf: 0.33 });
    const revived = lifted.flatMap((d) => d.allocations).filter((a) => a.side === 'SHORT');
    expect(revived.length).toBeGreaterThan(0);
    for (const a of revived) expect(a.confidence).toBe(0.33);
  });

  it('wouldBe tasimayan veto kaldirilsa bile veto olarak kalir', () => {
    const lifted = run({
      lifted: new Set(['LOW_VOL']),
      params: { withDirection: false },
    });
    const vetoes = lifted.flatMap((d) => d.rejections).filter((r) => r.rule === 'LOW_VOL');
    expect(vetoes.length).toBeGreaterThan(0);
    expect(lifted.flatMap((d) => d.allocations).every((a) => a.side === 'LONG')).toBe(true);
  });
});
