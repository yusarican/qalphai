import { describe, expect, it } from 'vitest';
import {
  MAX_CELLS,
  paramCellCount,
  runBacktest,
  type GridSpec,
} from '../src/engine/backtest';
import { sliceResults } from '../src/engine/walkForward';
import { ZERO_COSTS } from '../src/engine/costModel';
import type { RecordedDecision } from '../src/engine/simulator';
import type { Kline } from '../src/lib/klineStore';
import type { Strategy } from '../src/strategy/types';
import type { TechnicalIndicators } from '../src/vendor/technicalIndicators';

/**
 * GRID'IN MALIYETI — kazanan hucrenin kosusu neden saklanmiyor.
 *
 * runBacktest eskiden HER hucrenin tam SimulateResult'ini (trade listesi + equity egrisi)
 * bellekte tutuyor, sonunda yalnizca kazananinkini kullaniyordu. Hucre sayisinin tavani
 * (2000) aslinda bu israfin tavaniydi; operatorun 13.824 hucrelik grid'i bu yuzden
 * reddediliyordu. Simdi kazananin kosusu secimden SONRA yeniden uretiliyor.
 *
 * Bu ancak RECORD ve REPLAY deterministikse dogrudur. Deterministiklik bir varsayim degil
 * SOZLESME: birisi simulatore rastgelelik, saat okumasi ya da cagrilar arasi tasinan durum
 * eklerse rapor sessizce yalan soylemeye baslar — panel, kazanan hucrenin metriklerini
 * BASKA bir kosunun equity egrisiyle birlikte gosterir. Asagidaki test o sozlesmeyi tutar.
 */

const H4 = 14_400_000;
const SYMBOL = 'TESTUSDT';

/** Deterministik testere disi: her mumun yonu indeksinden turer, rastgelelik yok. */
function klines(count: number, startTime: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + 12 * Math.sin(i / 9) + 4 * Math.sin(i / 2.3);
    const openTime = startTime + i * H4;
    out.push({
      openTime,
      open: base,
      high: base * 1.012,
      low: base * 0.988,
      close: base * (i % 3 === 0 ? 1.004 : 0.997),
      volume: 1_000 + i,
      closeTime: openTime + H4 - 1,
    });
  }
  return out;
}

/** Sizing icin yalnizca ATR okunuyor; geri kalan alanlar simulasyona girmez. */
const indicators = (count: number): TechnicalIndicators[] =>
  Array.from({ length: count }, () => ({ atr: 2.5 }) as unknown as TechnicalIndicators);

/**
 * Iki taranabilir parametresi olan iskelet strateji. evaluate CAGRILMAZ: karar akisini
 * asagidaki `record` uretir, cunku bu testin konusu stratejinin sinyali degil grid'in
 * muhasebesi.
 */
function stubStrategy(): Strategy {
  return {
    meta: {
      id: 'grid-test',
      name: 'Grid test',
      version: 1,
      author: 'human',
      warmupBars: 0,
      needs: { funding: false, macro: false, btcRegime: false, history: false },
      params: [
        { key: 'edge', type: 'number', default: 0.6, sweep: [0.6, 0.7, 0.8], min: 0, max: 1 },
        { key: 'lev', type: 'number', default: 3, sweep: [3, 5], min: 1, max: 10 },
      ],
      maxSweepCells: 12,
    },
    evaluate: () => null,
  };
}

/** Parametrelere BAGLI ama deterministik karar akisi — hucreler birbirinden ayrilsin. */
function decisionsFor(
  bars: Kline[],
  params: Record<string, number | boolean>,
): RecordedDecision[] {
  const edge = Number(params.edge);
  const lev = Number(params.lev);
  const out: RecordedDecision[] = [];
  for (let i = 5; i < bars.length; i += 6) {
    out.push({
      timestamp: bars[i]!.closeTime + 1,
      allocations: [
        {
          symbol: SYMBOL,
          side: i % 12 === 5 ? 'LONG' : 'SHORT',
          confidence: edge,
          leverage: lev,
          allocationPercent: 20,
          reason: 'test',
        },
      ],
      rejections: [],
    });
  }
  return out;
}

const GRID: GridSpec = {
  rewardRatios: [2, 3],
  slMultipliers: [1, 1.6],
  callbackMultipliers: [1],
  riskPerTradePcts: [0.01, 0.02],
};

const BARS = 1_800; // ~300 gun 4h — walk-forward'in kayan penceresine yeter.

interface Harness {
  args: Parameters<typeof runBacktest>[0];
  recordCalls: () => number;
}

function harness(
  overrides: Partial<Parameters<typeof runBacktest>[0]> = {},
  barCount = BARS,
): Harness {
  const startDate = Date.UTC(2024, 0, 1);
  const bars = klines(barCount, startDate);
  const endDate = bars[bars.length - 1]!.closeTime;

  let calls = 0;
  return {
    recordCalls: () => calls,
    args: {
      strategy: stubStrategy(),
      record: async (params) => {
        calls++;
        return decisionsFor(bars, params);
      },
      symbols: [SYMBOL],
      interval: '4h',
      startDate,
      endDate,
      initialBalance: 10_000,
      profile: 'balanced',
      klines: { [SYMBOL]: bars },
      indicators: { [SYMBOL]: indicators(barCount) },
      funding: { [SYMBOL]: [] },
      lsr: {},
      macroRiskAppetite: null,
      intrabar: () => [],
      costs: ZERO_COSTS,
      grid: GRID,
      ...overrides,
    },
  };
}

describe('runBacktest: kazanan hucrenin kosusu', () => {
  it('yeniden uretilen kosu, grid sirasinda olculen hucrenin BIREBIR aynisidir', async () => {
    const h = harness();
    const out = await runBacktest(h.args);

    // Grid gercekten iki boyutlu tarandi mi: 6 strateji x 8 risk.
    expect(paramCellCount(h.args.strategy.meta.params)).toBe(6);
    expect(out.cells.length).toBe(48);

    const again = sliceResults(
      out.bestRun.trades,
      out.bestRun.equityCurve,
      h.args.initialBalance,
      out.plan,
    );

    // Panelin gosterdigi metrikler (best.results) ile panelin cizdigi egri (bestRun)
    // ayni kosudan gelmezse rapor kendi icinde celisir.
    expect(again.full).toEqual(out.best.results);
    expect(again.test).toEqual(out.best.testResults);
    expect(again.train).toEqual(out.best.trainResults);
    expect(again.windowTestPnls).toEqual(out.best.windowTestPnls);
    expect(out.bestRun.trades.length).toBeGreaterThan(0);
  });

  it('kazanan icin RECORD bir kez tekrarlanir — hucre basina degil', async () => {
    const h = harness();
    await runBacktest(h.args);
    // 6 strateji hucresi + kazanan icin 1 tekrar. Risk ekseni (8) RECORD'a dokunmaz.
    expect(h.recordCalls()).toBe(7);
  });

  it('strateji ekseni tek hucreyse RECORD hic tekrarlanmaz', async () => {
    const h = harness({ fixedParams: { edge: 0.7, lev: 3 } });
    const out = await runBacktest(h.args);

    expect(h.recordCalls()).toBe(1);
    expect(out.cells.length).toBe(8);

    const again = sliceResults(
      out.bestRun.trades,
      out.bestRun.equityCurve,
      h.args.initialBalance,
      out.plan,
    );
    expect(again.full).toEqual(out.best.results);
  });
});

describe('runBacktest: hucre tavani', () => {
  it('tavani asan grid, iki carpani da adiyla soyleyerek reddedilir', async () => {
    const wide = Array.from({ length: 60 }, (_, i) => 1 + i * 0.1);
    const h = harness({
      grid: {
        rewardRatios: wide,
        slMultipliers: wide,
        callbackMultipliers: [1],
        riskPerTradePcts: [0.01],
      },
    });

    // 6 strateji x 3600 risk = 21.600 > tavan.
    await expect(runBacktest(h.args)).rejects.toThrow(/6 strateji x 3600 risk/);
    expect(MAX_CELLS).toBeLessThan(21_600);
  });

  it('sabit parametreler carpani 1e indirir, ayni grid gecer', async () => {
    const wide = Array.from({ length: 60 }, (_, i) => 1 + i * 0.1);
    // Ayni 3600 hucrelik risk grid'i, bu kez 1 strateji hucresiyle. Kisa mum serisi:
    // olculen sey hucre sayisi, sonuc metrikleri degil.
    const h = harness(
      {
        fixedParams: { edge: 0.7, lev: 3 },
        grid: {
          rewardRatios: wide,
          slMultipliers: wide,
          callbackMultipliers: [1],
          riskPerTradePcts: [0.01],
        },
      },
      400,
    );

    const out = await runBacktest(h.args);
    expect(out.cells.length).toBe(3_600);
  });
});
