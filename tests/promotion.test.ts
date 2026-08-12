import { describe, expect, it } from 'vitest';
import {
  evaluatePromotion,
  plateau,
  signalOverlap,
  type EvaluatedRun,
  type PromotionInput,
} from '../src/engine/promotion';
import type { BacktestResults } from '../src/lib/types';

/**
 * Promosyon kapisinin regresyon takimi.
 *
 * Tablo-surumlu: her sart TEK BASINA bozulur ve TAM OLARAK bir engel uretmesi beklenir.
 * Sebebi: bir sartin sessizce etkisiz kalmasi kapiyi gevsetir ve BUNU KIMSE FARK ETMEZ —
 * sistem promote etmeye devam eder, sadece artik daha kotu adaylari.
 *
 * Bu takim ayrica kapinin bastan yazilmasina sebep olan uc hatayi da kilitler:
 *   - plato sartinin GECILEBILIR olmasi (eski mutlak esik 6 eksenli gridde imkansizdi),
 *   - ayni olcunun iki esikle sorulmamasi (olu sart uretiyordu),
 *   - sampiyonun da kendi kapisindan gecirilmesi (asimetri).
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

/**
 * Referans grid: 1000 hucrenin 100'u nitelikli (%10). Kazanan hucrenin 60 komsusunun
 * 12'si nitelikli (%20) — yani grid genelinin 2 kati, gereken 1.5 katin ustunde.
 */
const GRID = { gridQualified: 100, gridTotal: 1000 } as const;
const HOOD = { qualifiedNeighbors: 12, dqNeighbors: 48 } as const;

const champion = (over: Partial<EvaluatedRun> = {}): EvaluatedRun => ({
  verdict: 'ROBUST',
  qualified: true,
  test: good({ mar: 1.0, maxDrawdownPercent: 20 }),
  windowsPositive: 8,
  windowCount: 10,
  ...HOOD,
  ...GRID,
  boundaryAxes: 0,
  freeAxes: 4,
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
  ...HOOD,
  ...GRID,
  boundaryAxes: 0,
  freeAxes: 4,
  codeSha256: 'CHALLENGER_SHA',
  entrySignature: sig(50),
  ...over,
});

const baseInput = (): PromotionInput => ({
  champion: champion(),
  championStress: good({ totalPnlPercent: 6 }),
  championHoldout: good({ totalPnlPercent: 5, maxDrawdownPercent: 18, totalTrades: 25 }),
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

  it('temiz bir gecede uyari da cikmaz ve sampiyon da niteliklidir', () => {
    const v = evaluatePromotion(baseInput());
    expect(v.warnings).toEqual([]);
    expect(v.incumbentQualified).toBe(true);
  });
});

describe('promosyon kapisi: her sart TEK BASINA reddedebilmeli', () => {
  const cases: Array<{ name: string; mutate: (i: PromotionInput) => void; expect: RegExp }> = [
    {
      name: 'pencere istikrari zayif -> hukum FRAGILE',
      mutate: (i) => { i.challenger = challenger({ windowsPositive: 4 }); },
      expect: /walk-forward FRAGILE.*4\/10 windows positive \(8 required\)/,
    },
    {
      name: 'test drawdown tavani asiyor -> hukum FRAGILE',
      mutate: (i) => {
        i.challenger = challenger({ test: good({ mar: 2.0, maxDrawdownPercent: 45, totalPnlPercent: 30 }) });
      },
      expect: /walk-forward FRAGILE.*drawdown 45\.0% \(ceiling 40%\)/,
    },
    {
      name: 'test dilimi zararda -> hukum FAILED',
      mutate: (i) => {
        i.challenger = challenger({ test: good({ totalPnlPercent: -5, mar: 2.0 }) });
      },
      expect: /walk-forward FAILED/,
    },
    {
      name: 'hicbir hucre skorlama filtrelerini gecemedi',
      mutate: (i) => { i.challenger = challenger({ qualified: false }); },
      expect: /no grid cell passed the scoring filters/,
    },
    {
      name: 'test islemi cok az (istatistiki guven yok)',
      mutate: (i) => {
        i.challenger = challenger({ test: good({ totalTrades: 12, mar: 2.0, totalPnlPercent: 30 }) });
      },
      expect: /only 12 test trades/,
    },
    {
      name: 'maliyet stresi altinda zarara geciyor',
      mutate: (i) => { i.challengerStress = good({ totalPnlPercent: -3 }); },
      expect: /-3\.0% under cost stress/,
    },
    {
      name: 'KASA da zarar ediyor (overfit)',
      mutate: (i) => { i.holdout = good({ totalPnlPercent: -12, maxDrawdownPercent: 20, totalTrades: 25 }); },
      expect: /failed on the HOLDOUT: -12\.0%/,
    },
    {
      name: 'KASA da drawdown patliyor',
      mutate: (i) => { i.holdout = good({ totalPnlPercent: 5, maxDrawdownPercent: 55, totalTrades: 25 }); },
      expect: /failed on the HOLDOUT.*drawdown 55\.0% \(ceiling 40%\)/,
    },
    {
      // Eski kapida bu delik acikti: kasada 3 islemle +%100 "kanit" sayiliyordu.
      name: 'KASA karli ama islem sayisi gurultu seviyesinde',
      mutate: (i) => { i.holdout = good({ totalPnlPercent: 100, maxDrawdownPercent: 10, totalTrades: 3 }); },
      expect: /failed on the HOLDOUT.*3 trades \(20 required\)/,
    },
    {
      name: 'kazanan hucre bir DIKEN (komsulugu grid genelinden temiz degil)',
      mutate: (i) => { i.challenger = challenger({ qualifiedNeighbors: 4, dqNeighbors: 96 }); },
      expect: /is a SPIKE: only 4\.0% of its 100 neighbours qualify/,
    },
    {
      name: 'komsulugun orani iyi ama mutlak nitelikli komsu sayisi cok az',
      mutate: (i) => { i.challenger = challenger({ qualifiedNeighbors: 2, dqNeighbors: 0 }); },
      expect: /is a SPIKE/,
    },
    {
      name: 'sampiyonun MAR ini %10 marjla gecemedi',
      mutate: (i) => {
        i.champion = champion({ test: good({ mar: 2.0, maxDrawdownPercent: 20 }) });
        i.challenger = challenger({ test: good({ mar: 2.1, totalTrades: 80, totalPnlPercent: 30 }) });
      },
      expect: /did not clear the champion's 2\.00 by 10%/,
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

describe('kapi, disaridan gelen hukum etiketine GUVENMEZ', () => {
  it('etiket ROBUST dese de sayilar FRAGILE ise reddeder', () => {
    const input = baseInput();
    // Etiket dogru, sayilar degil: alan elle "ROBUST" yazilmis ama 2/10 pencere pozitif.
    input.challenger = challenger({ verdict: 'ROBUST', windowsPositive: 2 });

    const v = evaluatePromotion(input);

    expect(v.promote).toBe(false);
    expect(v.blockers.join(' ')).toMatch(/walk-forward FRAGILE/);
    // Ve tutarsizligi da bildirir — bu bir bug isaretidir.
    expect(v.warnings.join(' ')).toMatch(/internal inconsistency/);
  });
});

describe('plato sarti: grid seklinden BAGIMSIZ olmali', () => {
  it('6 eksenli gercek bir gridde (2304 hucre, %4 nitelikli) gecilebilir', () => {
    // 2026-08-12 gecesinin gercek sayilari: eski kapi burada "en fazla 6 diskalifiye
    // komsu" istiyordu; komsuluk 143 hucre ve grid genelinde yalnizca 98 nitelikli hucre
    // vardi — yani sart ARITMETIK OLARAK saglanamazdi.
    const run = challenger({
      qualifiedNeighbors: 25,
      dqNeighbors: 118,
      gridQualified: 98,
      gridTotal: 2304,
    });
    const p = plateau(run);

    expect(p.hood).toBe(143);
    expect(p.localRate).toBeCloseTo(25 / 143, 6);
    expect(p.gridRate).toBeCloseTo(98 / 2304, 6);
    expect(p.lift).toBeGreaterThan(4);

    const input = baseInput();
    input.challenger = run;
    expect(evaluatePromotion(input).promote).toBe(true);
  });

  it('gridin cogu nitelikliyken oran carpani tavanlanir (aksi halde >%100 istenirdi)', () => {
    // %90 nitelikli bir gridde 1.5x = %135 olurdu, saglanamaz. Tavan %90'a duser.
    const run = challenger({ gridQualified: 900, gridTotal: 1000, qualifiedNeighbors: 57, dqNeighbors: 3 });
    const p = plateau(run);

    expect(p.requiredRate).toBeCloseTo(0.9, 6);
    expect(p.localRate).toBeCloseTo(57 / 60, 6);

    const input = baseInput();
    input.challenger = run;
    expect(evaluatePromotion(input).promote).toBe(true);
  });

  it('ayni gevsek gridde vasat bir komsuluk yine reddedilir', () => {
    const input = baseInput();
    input.challenger = challenger({
      gridQualified: 900,
      gridTotal: 1000,
      qualifiedNeighbors: 30,
      dqNeighbors: 30,
    });

    const v = evaluatePromotion(input);
    expect(v.promote).toBe(false);
    expect(v.blockers.join(' ')).toMatch(/is a SPIKE/);
  });
});

describe('simetri: sampiyon da kendi kapisindan gecmeli', () => {
  it('sampiyon kasada zarardaysa uyari verilir ama aday yine de promote olabilir', () => {
    const input = baseInput();
    input.championHoldout = good({ totalPnlPercent: -9.1, maxDrawdownPercent: 22, totalTrades: 140 });

    const v = evaluatePromotion(input);

    expect(v.incumbentQualified).toBe(false);
    expect(v.warnings.join(' ')).toMatch(/INCUMBENT WOULD NOT PASS ITS OWN GATE/);
    expect(v.warnings.join(' ')).toMatch(/failed on the HOLDOUT/);
    // Uyari bir engel DEGIL: aday temizse yine gecer.
    expect(v.promote).toBe(true);
  });

  it('sampiyonun nitelikli olmamasi adayin engellerini degistirmez', () => {
    const input = baseInput();
    input.champion = champion({ windowsPositive: 4 }); // sampiyon FRAGILE
    input.champion.test = good({ mar: 1.0, maxDrawdownPercent: 20 });

    const v = evaluatePromotion(input);

    expect(v.incumbentQualified).toBe(false);
    expect(v.blockers).toEqual([]);
    expect(v.promote).toBe(true);
  });

  it('sampiyonun stres/kasa kosusu yoksa yeniden nitelendirme yapilmaz', () => {
    const input = baseInput();
    input.championStress = null;
    input.championHoldout = null;

    expect(evaluatePromotion(input).incumbentQualified).toBeNull();
  });
});

describe('grid siniri uyarisi', () => {
  it('optimum eksenlerin yarisindan coğunda kenardaysa uyarir ama engellemez', () => {
    const input = baseInput();
    input.challenger = challenger({ boundaryAxes: 3, freeAxes: 5 });

    const v = evaluatePromotion(input);

    expect(v.promote).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/sits at the grid boundary on 3 of 5/);
  });

  it('ic bolgedeki bir optimum uyari uretmez', () => {
    const input = baseInput();
    input.challenger = challenger({ boundaryAxes: 1, freeAxes: 5 });

    expect(evaluatePromotion(input).warnings).toEqual([]);
  });
});

describe('promosyon kapisi: ilk sampiyon', () => {
  it('sampiyon yokken aday yine de KASA ve stres testini gecmek zorunda', () => {
    const input = baseInput();
    input.champion = null;
    input.championStress = null;
    input.championHoldout = null;
    input.holdout = good({ totalPnlPercent: -5, totalTrades: 25 });

    const v = evaluatePromotion(input);
    expect(v.promote).toBe(false);
    expect(v.blockers.join(' ')).toMatch(/HOLDOUT/);
  });

  it('sampiyon yoksa ve aday temizse promote edilir', () => {
    const input = baseInput();
    input.champion = null;
    input.championStress = null;
    input.championHoldout = null;

    const v = evaluatePromotion(input);
    expect(v.promote).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/first champion/);
    expect(v.incumbentQualified).toBeNull();
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
