import { describe, expect, it } from 'vitest';
import {
  evaluatePromotion,
  signalOverlap,
  type EvaluatedRun,
  type PromotionInput,
} from '../src/engine/promotion';
import type { BacktestResults } from '../src/lib/types';

/**
 * Promosyon kapisinin regresyon takimi.
 *
 * Tablo-surumlu: her sart TEK BASINA bozulur ve TAM OLARAK bir engel uretmesi beklenir.
 * Sebebi: bir sartin sessizce etkisiz kalmasi (ornegin bir alan adi degisip
 * `undefined` ile karsilastirilmasi) kapiyi gevsetir ve BUNU KIMSE FARK ETMEZ —
 * sistem promote etmeye devam eder, sadece artik daha kotu adaylari.
 */

const good = (over: Partial<BacktestResults> = {}): BacktestResults => ({
  finalBalance: 13000,
  totalPnl: 3000,
  totalPnlPercent: 30,
  totalTrades: 80,
  winningTrades: 30,
  losingTrades: 50,
  winRate: 37.5,
  maxDrawdown: 1500,
  maxDrawdownPercent: 15,
  sharpeRatio: 1.4,
  sortinoRatio: 1.9,
  mar: 2.0,
  cagr: 30,
  profitFactor: 1.6,
  avgTradeReturn: 1.2,
  expectancyR: 0.3,
  totalFeesUSD: 200,
  totalFundingUSD: 30,
  feeShareOfGross: 0.08,
  turnoverUSD: 500_000,
  bestTrade: null,
  worstTrade: null,
  ...over,
});

const sig = (n: number, offset = 0): Set<string> =>
  new Set(Array.from({ length: n }, (_, i) => `${1000 + i + offset}:BTCUSDT:LONG`));

const champion = (over: Partial<EvaluatedRun> = {}): EvaluatedRun => ({
  verdict: 'ROBUST',
  qualified: true,
  test: good({ mar: 1.0, maxDrawdownPercent: 20 }),
  windowsPositive: 8,
  windowCount: 10,
  qualifiedNeighbors: 5,
  dqNeighbors: 2,
  codeSha256: 'CHAMPION_SHA',
  entrySignature: sig(50, 5000), // sampiyonun sinyalleri: aday ile ortusmuyor
  ...over,
});

const challenger = (over: Partial<EvaluatedRun> = {}): EvaluatedRun => ({
  verdict: 'ROBUST',
  qualified: true,
  test: good({ mar: 2.0, maxDrawdownPercent: 15, totalTrades: 80, totalPnlPercent: 30 }),
  windowsPositive: 8,
  windowCount: 10,
  qualifiedNeighbors: 5,
  dqNeighbors: 2,
  codeSha256: 'CHALLENGER_SHA',
  entrySignature: sig(50),
  ...over,
});

const baseInput = (): PromotionInput => ({
  champion: champion(),
  challenger: challenger(),
  challengerStress: good({ totalPnlPercent: 12 }),
  holdout: good({ totalPnlPercent: 8, maxDrawdownPercent: 18, totalTrades: 25 }),
});

describe('promosyon kapisi: temiz aday GECER', () => {
  it('tum sartlari saglayan aday promote edilir', () => {
    const v = evaluatePromotion(baseInput());
    if (!v.promote) console.error(v.blockers);
    expect(v.blockers).toEqual([]);
    expect(v.promote).toBe(true);
    // Gecen her sart raporda gorunmeli — "neden promote edildi" sorusu cevaplanabilsin.
    expect(v.reasons.length).toBeGreaterThanOrEqual(8);
  });
});

describe('promosyon kapisi: her sart TEK BASINA reddedebilmeli', () => {
  const cases: Array<{ name: string; mutate: (i: PromotionInput) => void; expect: RegExp }> = [
    {
      name: 'walk-forward hukmu FRAGILE',
      mutate: (i) => { i.challenger = challenger({ verdict: 'FRAGILE' }); },
      expect: /walk-forward verdict FRAGILE/,
    },
    {
      name: 'hicbir hucre skorlama filtrelerini gecemedi',
      mutate: (i) => { i.challenger = challenger({ qualified: false, verdict: 'FAILED' }); },
      expect: /no grid cell passed/,
    },
    {
      name: 'test dilimi zararda',
      mutate: (i) => { i.challenger = challenger({ test: good({ totalPnlPercent: -5, mar: 2.0 }) }); },
      expect: /test slice -5\.0%/,
    },
    {
      name: 'test islemi cok az (istatistiki guven yok)',
      mutate: (i) => { i.challenger = challenger({ test: good({ totalTrades: 12, mar: 2.0 }) }); },
      expect: /only 12 test trades/,
    },
    {
      name: 'pencere istikrari zayif (kar tek pencerede)',
      mutate: (i) => { i.challenger = challenger({ windowsPositive: 4, windowCount: 10 }); },
      expect: /only 40% of windows positive/,
    },
    {
      name: 'sampiyonun MAR ini %10 marjla gecemedi',
      mutate: (i) => {
        i.champion = champion({ test: good({ mar: 2.0 }) });
        i.challenger = challenger({ test: good({ mar: 2.1, totalTrades: 80, totalPnlPercent: 30 }) }); // 2.0 x 1.1 = 2.2 gerekli
      },
      expect: /did not clear the champion's 2\.00 by 10%/,
    },
    {
      name: 'test drawdown i sampiyonu asiyor',
      mutate: (i) => {
        i.champion = champion({ test: good({ mar: 1.0, maxDrawdownPercent: 10 }) });
        i.challenger = challenger({ test: good({ mar: 2.0, maxDrawdownPercent: 35, totalTrades: 80, totalPnlPercent: 30 }) });
      },
      expect: /test drawdown 35\.0% exceeds the .* ceiling/,
    },
    {
      name: 'maliyet stresi altinda zarara geciyor',
      mutate: (i) => { i.challengerStress = good({ totalPnlPercent: -3 }); },
      expect: /-3\.0% under cost stress/,
    },
    {
      name: 'kazanan hucre bir DIKEN (yeterli nitelikli komsu yok)',
      mutate: (i) => { i.challenger = challenger({ qualifiedNeighbors: 1 }); },
      expect: /is a SPIKE/,
    },
    {
      name: 'kazanan hucrenin cevresi mayin tarlasi',
      mutate: (i) => { i.challenger = challenger({ dqNeighbors: 20 }); },
      expect: /is a SPIKE/,
    },
    {
      name: 'KASA da zarar ediyor (overfit)',
      mutate: (i) => { i.holdout = good({ totalPnlPercent: -12, maxDrawdownPercent: 20 }); },
      expect: /failed on the HOLDOUT/,
    },
    {
      name: 'KASA da drawdown patliyor',
      mutate: (i) => { i.holdout = good({ totalPnlPercent: 5, maxDrawdownPercent: 55 }); },
      expect: /failed on the HOLDOUT/,
    },
    {
      name: 'kod sampiyonla birebir ayni (klon)',
      mutate: (i) => { i.challenger = challenger({ codeSha256: 'CHAMPION_SHA' }); },
      expect: /byte-identical to the champion/,
    },
    {
      name: 'sinyaller sampiyonla neredeyse tamamen ortusuyor (ayni strateji, farkli sapka)',
      mutate: (i) => {
        const shared = sig(50);
        i.champion = champion({ entrySignature: shared });
        i.challenger = challenger({ entrySignature: shared, codeSha256: 'DIFFERENT_SHA' });
      },
      expect: /same strategy wearing a different hat/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const input = baseInput();
      c.mutate(input);

      const v = evaluatePromotion(input);

      expect(v.promote).toBe(false);
      expect(v.blockers.length).toBeGreaterThanOrEqual(1);
      expect(v.blockers.join(' | ')).toMatch(c.expect);
    });
  }
});

describe('promosyon kapisi: ilk sampiyon', () => {
  it('sampiyon yokken aday yine de KASA ve stres testini gecmek zorunda', () => {
    const input = baseInput();
    input.champion = null;
    input.holdout = good({ totalPnlPercent: -5 }); // kasada zarar

    const v = evaluatePromotion(input);
    expect(v.promote).toBe(false);
    expect(v.blockers.join(' ')).toMatch(/HOLDOUT/);
  });

  it('sampiyon yoksa ve aday temizse promote edilir', () => {
    const input = baseInput();
    input.champion = null;

    const v = evaluatePromotion(input);
    expect(v.promote).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/first champion/);
  });
});

describe('sinyal ortusmesi (Jaccard)', () => {
  it('ayni sinyaller -> 1.0', () => {
    expect(signalOverlap(sig(10), sig(10))).toBe(1);
  });
  it('tamamen farkli sinyaller -> 0', () => {
    expect(signalOverlap(sig(10), sig(10, 9999))).toBe(0);
  });
  it('yarisi ortak -> 1/3 (Jaccard: 5 / (10+10-5))', () => {
    expect(signalOverlap(sig(10), sig(10, 5))).toBeCloseTo(5 / 15, 6);
  });
});
