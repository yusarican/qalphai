import { describe, expect, it } from 'vitest';
import { assertCoverage, WARMUP_BARS, type Dataset } from '../src/engine/dataset';
import { INTERVAL_MS, type Kline } from '../src/lib/klineStore';
import type { CandleInterval } from '../src/config/env';

/**
 * Kapsam kontrolu, motorun "veri yoklugu" ile "edge yoklugu"nu ayirdigi tek yer.
 *
 * Ayrilmadigi zaman ne oluyordu: panelden 1h secilince (cache'te yalnizca 4h varken)
 * grid sifir karar uretiyor, 1728 hucrenin 1728'i AZ_ISLEM'den eleniyor ve panel
 * FAILED / %0.0 gosteriyordu — yani hic olculmemis bir strateji hakkinda olcum
 * raporlaniyordu. Bu testler o sessiz yolun kapali kalmasini garanti eder.
 */

const DAY = 86_400_000;
const INTERVAL: CandleInterval = '1h';

const START = Date.UTC(2025, 0, 1);
const END = START + 30 * DAY;

function candles(from: number, count: number, interval: CandleInterval = INTERVAL): Kline[] {
  const ms = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => ({
    openTime: from + i * ms,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    closeTime: from + (i + 1) * ms - 1,
  }));
}

function dataset(klines: Record<string, Kline[]>): Dataset {
  return {
    klines,
    indicators: {},
    funding: {},
    lsr: {},
    intrabar: () => [],
    close: () => {},
  };
}

const args = (symbols: string[]) => ({
  symbols,
  interval: INTERVAL,
  startDate: START,
  endDate: END,
});

describe('assertCoverage', () => {
  it('warmup + donem tam ise gecer', () => {
    const ms = INTERVAL_MS[INTERVAL];
    const ks = candles(START - WARMUP_BARS * ms, WARMUP_BARS + (END - START) / ms);
    expect(() => assertCoverage(dataset({ BTCUSDT: ks }), args(['BTCUSDT']))).not.toThrow();
  });

  it('sembolun mumu hic yoksa patlar — sifir islemli grid uretmez', () => {
    expect(() => assertCoverage(dataset({ BTCUSDT: [] }), args(['BTCUSDT']))).toThrow(
      /BTCUSDT 1h: cache'te hic mum yok/,
    );
  });

  it('cache anahtarinda olmayan sembol de eksik sayilir', () => {
    expect(() => assertCoverage(dataset({}), args(['ETHUSDT']))).toThrow(/ETHUSDT/);
  });

  it('warmup yetmiyorsa patlar', () => {
    const ms = INTERVAL_MS[INTERVAL];
    // Donem dolu, ama oncesinde yalnizca 10 mum var.
    const ks = candles(START - 10 * ms, 10 + (END - START) / ms);
    expect(() => assertCoverage(dataset({ BTCUSDT: ks }), args(['BTCUSDT']))).toThrow(
      /yalnizca 10 mum var/,
    );
  });

  it('donemin ICINDE mum yoksa patlar (cache donem oncesinde bitmis)', () => {
    const ms = INTERVAL_MS[INTERVAL];
    const ks = candles(START - (WARMUP_BARS + 50) * ms, WARMUP_BARS + 50);
    expect(() => assertCoverage(dataset({ BTCUSDT: ks }), args(['BTCUSDT']))).toThrow(
      /araliginda hic mum yok/,
    );
  });

  it('hata mesaji duzeltme komutunu ve TUM eksik sembolleri tasir', () => {
    let message = '';
    try {
      assertCoverage(dataset({}), args(['BTCUSDT', 'ETHUSDT']));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('BTCUSDT');
    expect(message).toContain('ETHUSDT');
    expect(message).toContain('npm run sync -- --interval 1h --days 30');
  });
});
