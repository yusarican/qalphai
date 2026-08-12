import { describe, expect, it } from 'vitest';
import {
  accrueFunding,
  computeTradePnl,
  DEFAULT_COSTS,
  entryFillPrice,
  exitFillPrice,
  makeMarkAt,
  slippageFraction,
  stressCosts,
  takerFee,
  ZERO_COSTS,
  type CostConfig,
} from '../src/engine/costModel';
import type { FundingRate, Kline } from '../src/lib/klineStore';

/**
 * Maliyet modeli, tum self-improvement dongusunun durustlugunun dayandigi yer:
 * maliyet yanlissa Codex, maliyet altinda olen stratejileri "karli" sanip promote eder.
 * Bu yuzden sayilar ELLE hesaplanip sabitlenmistir — implementasyondan turetilmemistir.
 */

// Sabit bps slippage: aritmetigi elle dogrulanabilir tutar.
const FLAT: CostConfig = {
  ...DEFAULT_COSTS,
  slippage: { model: 'bps', bps: 10 }, // %0.10
  takerFeeBps: 4.5, // %0.045
  stopSlipMultiplier: 2,
};

describe('slippage', () => {
  it('ATR modelinde taban bps ile ATR oraninin buyugunu alir', () => {
    const cfg: CostConfig = {
      ...DEFAULT_COSTS,
      slippage: { model: 'atr', atrFraction: 0.05, minBps: 1 },
    };
    // ATR = 100, fiyat = 50_000 -> 0.05 * 100 / 50000 = 0.0001 = 1bp. Taban da 1bp.
    expect(slippageFraction(cfg, 100, 50_000)).toBeCloseTo(0.0001, 10);

    // ATR = 1000 -> 0.05 * 1000 / 50000 = 0.001 = 10bp. Taban asilir.
    expect(slippageFraction(cfg, 1000, 50_000)).toBeCloseTo(0.001, 10);

    // ATR = 0 (hesaplanamadi) -> tabana duser, 0 dondurmez.
    expect(slippageFraction(cfg, 0, 50_000)).toBeCloseTo(0.0001, 10);
  });

  it('giris dolumu HER ZAMAN aleyhtedir', () => {
    // LONG daha PAHALIYA alir.
    expect(entryFillPrice(FLAT, 'LONG', 100, 1)).toBeCloseTo(100.1, 9);
    // SHORT daha UCUZA satar.
    expect(entryFillPrice(FLAT, 'SHORT', 100, 1)).toBeCloseTo(99.9, 9);
  });

  it('stop cikislari (SL/BE/TRAIL) TP den daha kotu doldurulur', () => {
    // LONG cikis = satis -> daha ucuza satar.
    // TP: 100 * (1 - 0.001 * 1) = 99.9
    expect(exitFillPrice(FLAT, 'LONG', 100, 1, 'TP')).toBeCloseTo(99.9, 9);
    // SL: market emir, harekete girer -> stopSlipMultiplier=2 -> 100 * (1 - 0.002) = 99.8
    expect(exitFillPrice(FLAT, 'LONG', 100, 1, 'SL')).toBeCloseTo(99.8, 9);
    expect(exitFillPrice(FLAT, 'LONG', 100, 1, 'TRAIL')).toBeCloseTo(99.8, 9);
    expect(exitFillPrice(FLAT, 'LONG', 100, 1, 'BE')).toBeCloseTo(99.8, 9);
    // SIGNAL_CHANGE stop degil -> normal slippage.
    expect(exitFillPrice(FLAT, 'LONG', 100, 1, 'SIGNAL_CHANGE')).toBeCloseTo(99.9, 9);
  });
});

describe('taker fee', () => {
  it('notional uzerinden alinir', () => {
    // 2 birim x $10_000 = $20_000 notional, 4.5bps -> $9
    expect(takerFee(FLAT, 2, 10_000)).toBeCloseTo(9, 9);
  });
});

describe('funding tahakkuku', () => {
  const candles: Kline[] = [
    { openTime: 0, closeTime: 999, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { openTime: 1000, closeTime: 1999, open: 100, high: 100, low: 100, close: 200, volume: 1 },
  ];
  const markAt = makeMarkAt(candles);
  const funding: FundingRate[] = [
    { fundingTime: 500, rate: 0.0001 },
    { fundingTime: 1500, rate: 0.0001 },
    { fundingTime: 2500, rate: 0.0001 },
  ];

  it('LONG, pozitif oranda ODER; (from, to] yari-acik araligi kullanir', () => {
    // (0, 2000] -> 500 ve 1500 settle'lari dahil.
    //   500  -> mark = 100 (openTime<=500 olan son mum: index 0, close 100)
    //   1500 -> mark = 200 (index 1, close 200)
    // qty = 3 -> 0.0001*3*100 + 0.0001*3*200 = 0.03 + 0.06 = 0.09
    const cost = accrueFunding({
      cfg: DEFAULT_COSTS,
      side: 'LONG',
      qtyBase: 3,
      fromMs: 0,
      toMs: 2000,
      funding,
      markAt,
    });
    expect(cost).toBeCloseTo(0.09, 9);
  });

  it('SHORT, pozitif oranda TAHSIL EDER (isaret ters)', () => {
    const cost = accrueFunding({
      cfg: DEFAULT_COSTS,
      side: 'SHORT',
      qtyBase: 3,
      fromMs: 0,
      toMs: 2000,
      funding,
      markAt,
    });
    expect(cost).toBeCloseTo(-0.09, 9);
  });

  it('sinirdaki settle CIFT SAYILMAZ (yari-acik aralik)', () => {
    // (0, 500] ve (500, 2000] birlestiginde (0, 2000] ile ayni olmali.
    const a = accrueFunding({ cfg: DEFAULT_COSTS, side: 'LONG', qtyBase: 3, fromMs: 0, toMs: 500, funding, markAt });
    const b = accrueFunding({ cfg: DEFAULT_COSTS, side: 'LONG', qtyBase: 3, fromMs: 500, toMs: 2000, funding, markAt });
    expect(a + b).toBeCloseTo(0.09, 9);
  });

  it('kapaliyken sifir doner', () => {
    const cost = accrueFunding({
      cfg: ZERO_COSTS,
      side: 'LONG',
      qtyBase: 3,
      fromMs: 0,
      toMs: 2000,
      funding,
      markAt,
    });
    expect(cost).toBe(0);
  });
});

describe('trade PnL', () => {
  it('elle hesaplanmis LONG: brut - fee - funding', () => {
    // qty 2, giris 10_000 -> cikis 11_000, margin 2_000
    // brut     = 2 * (11000 - 10000) = 2000
    // feeGiris = 2 * 10000 * 0.00045 = 9
    // feeCikis = 2 * 11000 * 0.00045 = 9.9
    // funding  = 5
    // net      = 2000 - 18.9 - 5 = 1976.1
    const r = computeTradePnl({
      cfg: FLAT,
      side: 'LONG',
      qtyBase: 2,
      entryFill: 10_000,
      exitFill: 11_000,
      fundingUSD: 5,
      margin: 2_000,
    });
    expect(r.grossPnl).toBeCloseTo(2000, 9);
    expect(r.feesUSD).toBeCloseTo(18.9, 9);
    expect(r.netPnl).toBeCloseTo(1976.1, 9);
    expect(r.pnlPercent).toBeCloseTo(98.805, 6);
    expect(r.liquidated).toBe(false);
  });

  it('SHORT: fiyat DUSERSE kazanir', () => {
    const r = computeTradePnl({
      cfg: ZERO_COSTS,
      side: 'SHORT',
      qtyBase: 2,
      entryFill: 10_000,
      exitFill: 9_000,
      fundingUSD: 0,
      margin: 2_000,
    });
    expect(r.grossPnl).toBeCloseTo(2000, 9);
    expect(r.netPnl).toBeCloseTo(2000, 9);
  });

  it('izole margin: kayip -margin ile TABANLANIR (tasfiye)', () => {
    // Brut kayip 5000 ama margin sadece 1000 -> en fazla 1000 kaybedilebilir.
    const r = computeTradePnl({
      cfg: ZERO_COSTS,
      side: 'LONG',
      qtyBase: 5,
      entryFill: 10_000,
      exitFill: 9_000,
      fundingUSD: 0,
      margin: 1_000,
    });
    expect(r.grossPnl).toBeCloseTo(-5000, 9);
    expect(r.netPnl).toBe(-1000);
    expect(r.pnlPercent).toBe(-100);
    expect(r.liquidated).toBe(true);
  });

  it('maliyet kapaliyken net == brut (altin regresyon icin sart)', () => {
    const r = computeTradePnl({
      cfg: ZERO_COSTS,
      side: 'LONG',
      qtyBase: 2,
      entryFill: 10_000,
      exitFill: 11_000,
      fundingUSD: 0,
      margin: 2_000,
    });
    expect(r.netPnl).toBe(r.grossPnl);
    expect(r.feesUSD).toBe(0);
  });
});

describe('maliyet stres testi (promosyon kapisi)', () => {
  it('fee x1.5, slippage x2', () => {
    const s = stressCosts(DEFAULT_COSTS);
    expect(s.takerFeeBps).toBeCloseTo(6.75, 9);
    expect(s.slippage).toEqual({ model: 'atr', atrFraction: 0.1, minBps: 2 });
  });

  it('stres, PnL i her zaman DUSURUR (asla artirmaz)', () => {
    const base = computeTradePnl({
      cfg: DEFAULT_COSTS,
      side: 'LONG',
      qtyBase: 2,
      entryFill: 10_000,
      exitFill: 11_000,
      fundingUSD: 0,
      margin: 2_000,
    });
    const stressed = computeTradePnl({
      cfg: stressCosts(DEFAULT_COSTS),
      side: 'LONG',
      qtyBase: 2,
      entryFill: 10_000,
      exitFill: 11_000,
      fundingUSD: 0,
      margin: 2_000,
    });
    expect(stressed.netPnl).toBeLessThan(base.netPnl);
  });
});
