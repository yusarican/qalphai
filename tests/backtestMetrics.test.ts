import { describe, expect, it } from 'vitest';
import { calculateMetrics } from '../src/engine/backtestMetrics';
import type { BacktestTrade, EquityPoint } from '../src/lib/types';

const DAY = 86_400_000;

function trade(over: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryTime: 0,
    entryPrice: 100,
    entryFill: 100,
    exitTime: DAY,
    exitPrice: 110,
    exitFill: 110,
    exitReason: 'TP',
    leverage: 1,
    quantity: 100,
    qtyBase: 1,
    notional: 100,
    grossPnl: 10,
    feesUSD: 0,
    fundingUSD: 0,
    pnl: 10,
    pnlPercent: 10,
    liquidated: false,
    confidence: 0.7,
    ...over,
  };
}

/** Sample'in (backtestMetrics.ts:38-48) hatali algoritmasi — regresyonun kanit karsiligi. */
function sampleMaxDrawdownPercent(curve: EquityPoint[], initial: number): number {
  let peak = initial;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const p of curve) {
    if (p.balance > peak) peak = p.balance;
    const dd = peak - p.balance;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = ddPct; // <-- HATA: yuzde, MUTLAK max'in oldugu anda okunuyor
    }
  }
  return maxDrawdownPercent;
}

describe('maxDrawdownPercent — sample bug regresyonu', () => {
  /**
   * Senaryo, sample'in hatasini goturuyor:
   *   - Once kucuk bir bakiyede BUYUK YUZDE dusus: 1000 -> 700  =  -$300 / %30
   *   - Sonra buyuk bir bakiyede BUYUK MUTLAK dusus: 5000 -> 4500 = -$500 / %10
   *
   * Mutlak max DD = $500 (ikinci olay). Sample yuzdeyi O ANDA okuyor -> %10 diyor.
   * Gercek max YUZDE DD ise %30 (birinci olay).
   *
   * Bu, gridScoring'in TEST_DD > %40 diskalifiyesini dogrudan gevsetiyordu: gercekte
   * %30 cakan bir hucre %10 gorunuyordu.
   */
  const curve: EquityPoint[] = [
    { timestamp: 0, balance: 1000 },
    { timestamp: 1 * DAY, balance: 700 },  // -%30
    { timestamp: 2 * DAY, balance: 5000 }, // yeni zirve
    { timestamp: 3 * DAY, balance: 4500 }, // -$500 mutlak max, ama sadece -%10
  ];

  it('sample buggy algoritmasi gercek max yuzde DD yi KACIRIR', () => {
    expect(sampleMaxDrawdownPercent(curve, 1000)).toBeCloseTo(10, 6);
  });

  it('bizim algoritmamiz gercek max yuzde DD yi bulur', () => {
    const m = calculateMetrics([trade({ pnl: 3500, pnlPercent: 350 })], 1000, curve);
    expect(m.maxDrawdown).toBeCloseTo(500, 6); // mutlak: dogru (sample da dogruydu)
    expect(m.maxDrawdownPercent).toBeCloseTo(30, 6); // yuzde: DUZELDI
  });

  it('bakiye sifira duserse tasfiye (DD %100) sayilir', () => {
    const wiped: EquityPoint[] = [
      { timestamp: 0, balance: 1000 },
      { timestamp: DAY, balance: 0 },
    ];
    const m = calculateMetrics([trade({ pnl: -1000, pnlPercent: -100 })], 1000, wiped);
    expect(m.maxDrawdownPercent).toBe(100); // gridScoring LIKIDASYON diskalifiyesi tetiklenir
  });
});

describe('Sharpe — zaman serisi, islem frekansindan bagimsiz', () => {
  /**
   * Sample'in Sharpe'i trade-basina dispersiyonu sabit sqrt(365) ile olcekliyordu
   * (backtestMetrics.ts:50-57): yilda 20 islem yapanla 2000 yapan AYNI annualizasyonu
   * aliyordu. Yani sayi finansal olarak karsilastirilamazdi — ve gridScoring onu
   * hucreleri KARSILASTIRMAK icin kullaniyordu.
   */
  it('ayni equity yolu, farkli islem sayisi -> AYNI Sharpe', () => {
    // Ayni gunluk bakiye yolu; bir kere 2 trade, bir kere 20 trade ile uretilmis.
    const curve: EquityPoint[] = [];
    for (let d = 0; d <= 60; d++) {
      curve.push({ timestamp: d * DAY, balance: 1000 * Math.pow(1.002, d) });
    }

    const few = calculateMetrics(
      Array.from({ length: 2 }, () => trade({ pnl: 60, pnlPercent: 6 })),
      1000,
      curve,
    );
    const many = calculateMetrics(
      Array.from({ length: 20 }, () => trade({ pnl: 6, pnlPercent: 0.6 })),
      1000,
      curve,
    );

    expect(few.sharpeRatio).toBeCloseTo(many.sharpeRatio, 6);
  });

  it('duz yukselen egri -> yuksek Sharpe; oynak egri -> dusuk', () => {
    const smooth: EquityPoint[] = [];
    const choppy: EquityPoint[] = [];
    for (let d = 0; d <= 90; d++) {
      smooth.push({ timestamp: d * DAY, balance: 1000 * Math.pow(1.003, d) });
      // Ayni bitis noktasi, ama zigzagli.
      const noise = d % 2 === 0 ? 0.94 : 1.06;
      choppy.push({ timestamp: d * DAY, balance: 1000 * Math.pow(1.003, d) * noise });
    }
    const a = calculateMetrics([trade()], 1000, smooth);
    const b = calculateMetrics([trade()], 1000, choppy);
    expect(a.sharpeRatio).toBeGreaterThan(b.sharpeRatio);
  });
});

describe('maliyet alanlari', () => {
  it('feeShareOfGross, maliyetin brut kara oranini verir (MALIYET_YIYOR DQ nin girdisi)', () => {
    const trades = [
      trade({ grossPnl: 100, feesUSD: 30, fundingUSD: 30, pnl: 40 }),
      trade({ grossPnl: 100, feesUSD: 30, fundingUSD: 0, pnl: 70 }),
    ];
    const curve: EquityPoint[] = [
      { timestamp: 0, balance: 1000 },
      { timestamp: DAY, balance: 1110 },
    ];
    const m = calculateMetrics(trades, 1000, curve);
    // brut kar = 200; maliyet = fee 60 + funding 30 = 90 -> 0.45
    expect(m.totalFeesUSD).toBeCloseTo(60, 6);
    expect(m.totalFundingUSD).toBeCloseTo(30, 6);
    expect(m.feeShareOfGross).toBeCloseTo(0.45, 4);
  });

  it('devir hacmi giris+cikis olarak sayilir', () => {
    const m = calculateMetrics([trade({ notional: 500 })], 1000, [
      { timestamp: 0, balance: 1000 },
      { timestamp: DAY, balance: 1010 },
    ]);
    expect(m.turnoverUSD).toBeCloseTo(1000, 6); // 500 x 2
  });
});

describe('sinir durumlari', () => {
  it('islem yoksa her sey sifir, bakiye degismez', () => {
    const m = calculateMetrics([], 5000, []);
    expect(m.finalBalance).toBe(5000);
    expect(m.totalTrades).toBe(0);
    expect(m.maxDrawdownPercent).toBe(0);
    expect(m.sharpeRatio).toBe(0);
  });

  it('hic kayip yoksa profit factor 999 a sabitlenir (Infinity degil)', () => {
    const m = calculateMetrics([trade({ pnl: 10 })], 1000, [
      { timestamp: 0, balance: 1000 },
      { timestamp: DAY, balance: 1010 },
    ]);
    expect(m.profitFactor).toBe(999);
    expect(Number.isFinite(m.profitFactor)).toBe(true);
  });
});
