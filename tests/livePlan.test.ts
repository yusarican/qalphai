import { describe, expect, it, vi } from 'vitest';
import { EXCHANGE_ONLY_SKIPS, planActions, type PlanInput } from '../src/engine/livePlan';
import { DEFAULT_RISK_PARAMS } from '../src/engine/riskManagement';
import { ZERO_COSTS } from '../src/engine/costModel';
import { floorToStep, roundToTick } from '../src/services/binanceOrders';
import { inCooldown, readState, type LedgerPosition, type LiveState } from '../src/lib/liveState';
import { currentDecisionBar } from '../src/engine/liveDecider';
import type { Allocation } from '../src/engine/portfolio';
import type { SymbolFilters } from '../src/services/binanceOrders';

/**
 * CANLI GIRIS KAPILARI — backtest ile canliyi ayni strateji yapan sozlesme.
 *
 * Bu testler bir "kapsam" jesti degil: her biri, canli motorun backtest'ten AYRISABILECEGI
 * somut bir yolu kapatir. Kapilar ayrisirsa iki taraf da kendi icinde tutarli calisir,
 * hicbir sey kirmizi yanmaz, ve sistem gerceklesmeyen bir strateji hakkinda rapor uretir.
 *
 * Sayilar (balance 10.000, risk %5, tavan %15) DEFAULT_RISK_PARAMS'tan gelir:
 *   riskUSD = 10.000 x 0.05 = 500 / islem
 *   tavan   = 10.000 x 0.15 = 1500  -> en fazla 3 es zamanli pozisyon
 */

const BALANCE = 10_000;

/** Maliyetsiz: estFill = close, boylece beklenen sayilar elle dogrulanabilir. */
const COSTS = ZERO_COSTS;

/** price 100, atr 10, 5x -> margin = 625 x 100 / (10 x 5) = 1250 / pozisyon. */
const BAR = { close: 100, high: 105, low: 95, atr: 10 };

function alloc(symbol: string, side: 'LONG' | 'SHORT', confidence: number): Allocation {
  return { symbol, side, confidence, leverage: 5, allocationPercent: 20, reason: '' };
}

function position(symbol: string, side: 'LONG' | 'SHORT'): LedgerPosition {
  return {
    symbol,
    side,
    entryTime: 1_000,
    entryFill: 100,
    qtyBase: 62.5,
    margin: 1250,
    leverage: 5,
    confidence: 0.7,
    riskUSD: 500,
    initialStopPrice: 92,
    entryOrderId: 'x',
    slOrderId: null,
    tpOrderId: null,
    decisionBar: 1_000,
  };
}

function state(over: Partial<LiveState> = {}): LiveState {
  return {
    championId: 'test@1',
    positions: [],
    exits: [],
    lastRunAt: 0,
    lastDecisionBar: 0,
    ...over,
  };
}

function filters(over: Partial<SymbolFilters> = {}): Map<string, SymbolFilters> {
  const f: SymbolFilters = {
    stepSize: 0.001,
    minQty: 0.001,
    tickSize: 0.01,
    minNotional: 5,
    quantityPrecision: 3,
    pricePrecision: 2,
    ...over,
  };
  return new Map(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'].map((s) => [s, f]));
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  const allocations = over.allocations ?? [];

  // Varsayilan: her sembol ayni saglikli mumu gorur. Testler gerekirse bars'i ezer.
  const defaultBars: Record<string, typeof BAR> = {};
  for (const a of allocations) defaultBars[a.symbol] = BAR;

  return {
    balance: BALANCE,
    availableMargin: BALANCE,
    risk: DEFAULT_RISK_PARAMS,
    costs: COSTS,
    state: state(),
    at: 10_000_000,
    cooldownMs: 3 * 4 * 3_600_000, // 3 x 4h
    filters: filters(),
    unmanaged: [],
    ...over,
    allocations,
    bars: over.bars ?? defaultBars,
  };
}

const kinds = (p: ReturnType<typeof planActions>) =>
  p.map((s) => (s.kind === 'SKIP' ? `SKIP:${s.reason}` : s.kind === 'OPEN' ? `OPEN:${s.alloc.symbol}` : `CLOSE:${s.position.symbol}`));

describe('livePlan: risk tavani simulator ile ayni', () => {
  it('tavan dolunca 4. pozisyonu RISK_CAP ile reddeder (3 x 500 = 1500 = tavan)', () => {
    const plan = planActions(
      input({
        allocations: [
          alloc('BTCUSDT', 'SHORT', 0.79),
          alloc('SOLUSDT', 'SHORT', 0.78),
          alloc('BNBUSDT', 'SHORT', 0.74),
          alloc('ETHUSDT', 'SHORT', 0.64),
        ],
      }),
    );

    expect(kinds(plan)).toEqual(['OPEN:BTCUSDT', 'OPEN:SOLUSDT', 'OPEN:BNBUSDT', 'SKIP:RISK_CAP']);
  });

  it('zaten acik pozisyonlarin riski tavana SAYILIR', () => {
    // Defterde 2 acik pozisyon (2 x 500 = 1000). Tavana 500 kaldi -> yalniz 1 yeni giris.
    const plan = planActions(
      input({
        allocations: [alloc('BTCUSDT', 'SHORT', 0.8), alloc('SOLUSDT', 'SHORT', 0.7)],
        state: state({ positions: [position('ETHUSDT', 'LONG'), position('BNBUSDT', 'LONG')] }),
      }),
    );

    expect(kinds(plan)).toEqual(['OPEN:BTCUSDT', 'SKIP:RISK_CAP']);
  });

  /**
   * REGRESYON — bu hata gercekten yasandi.
   *
   * Borsa bir pozisyonu margin/notional yuzunden reddettiginde, o pozisyonun risk butcesi
   * SERBEST KALMAMALI. Kalirsa, sirada bekleyen ve backtest'in RISK_CAP ile REDDETTIGI bir
   * pozisyon aniden uygun hale gelir — yani canli motor, backtest'in ASLA almadigi bir
   * pozisyonu acar. Borsanin reddi, simulator'un kapisini GEVSETEMEZ.
   */
  it('borsa kaynakli red (MIN_NOTIONAL) risk butcesini SERBEST BIRAKMAZ', () => {
    const f = filters();
    // SOLUSDT borsada devasa bir minNotional'a takilsin (6250 notional < 99999).
    f.set('SOLUSDT', { ...f.get('SOLUSDT')!, minNotional: 99_999 });

    const plan = planActions(
      input({
        allocations: [
          alloc('BTCUSDT', 'SHORT', 0.8), // acilir      -> rezerve 500
          alloc('SOLUSDT', 'SHORT', 0.75), // MIN_NOTIONAL -> rezerve YINE DE 1000
          alloc('BNBUSDT', 'SHORT', 0.7), // acilir      -> rezerve 1500 (tavan)
          alloc('ETHUSDT', 'SHORT', 0.65), // RISK_CAP
        ],
        filters: f,
      }),
    );

    expect(kinds(plan)).toEqual([
      'OPEN:BTCUSDT',
      'SKIP:MIN_NOTIONAL',
      'OPEN:BNBUSDT',
      'SKIP:RISK_CAP', // <-- hata varken burasi OPEN olurdu: backtest'in almadigi pozisyon
    ]);
  });
});

describe('livePlan: borsa kapilari (simulator bunlari bilmez)', () => {
  it('toplam margin kullanilabilir bakiyeyi asarsa INSUFFICIENT_MARGIN', () => {
    // Butce = 3000 x 0.95 = 2850. Pozisyon basi margin 1250 -> yalniz 2 tane sigar.
    const plan = planActions(
      input({
        allocations: [
          alloc('BTCUSDT', 'SHORT', 0.8),
          alloc('SOLUSDT', 'SHORT', 0.75),
          alloc('BNBUSDT', 'SHORT', 0.7),
        ],
        availableMargin: 3_000,
      }),
    );

    expect(kinds(plan)).toEqual(['OPEN:BTCUSDT', 'OPEN:SOLUSDT', 'SKIP:INSUFFICIENT_MARGIN']);
  });

  it('borsa kaynakli redler IRAKSAMA olarak isaretlidir', () => {
    // Bu ikisi "backtest alirdi, borsa aldirmadi" demektir — sessiz gecilemez.
    expect(EXCHANGE_ONLY_SKIPS).toContain('INSUFFICIENT_MARGIN');
    expect(EXCHANGE_ONLY_SKIPS).toContain('MIN_NOTIONAL');
    // Bunlar simulator'un da uyguladigi kapilar — iraksama DEGIL.
    expect(EXCHANGE_ONLY_SKIPS).not.toContain('RISK_CAP');
    expect(EXCHANGE_ONLY_SKIPS).not.toContain('COOLDOWN');
  });

  it('miktar stepSize\'a ASAGI yuvarlanir — asla yukari (yukari yuvarlamak riski buyutur)', () => {
    expect(floorToStep(62.5789, 0.001)).toBe(62.578);
    expect(floorToStep(0.4275540161482705, 0.001)).toBe(0.427);
    expect(floorToStep(223214.2857, 1)).toBe(223214);

    // Adimin tam kati olan miktar OLDUGU GIBI kalmali.
    expect(floorToStep(1.5, 0.5)).toBe(1.5);
    expect(floorToStep(62.5, 0.001)).toBe(62.5);
  });

  /**
   * REGRESYON — IEEE-754.
   *
   * 0.3 / 0.1 = 2.9999999999999996. Duz Math.floor bunu 2'ye indirir ve miktar TAM BIR
   * ADIM eksilir: 0.3 yerine 0.2 — %33 kucuk pozisyon. riskUSD = miktar x stop mesafesi
   * oldugu icin risk modeli de sessizce yanlis olur. Emir borsada gecerli gorunur,
   * hicbir sey kirmizi yanmaz.
   */
  it('adim tam kati iken kayan nokta hatasi BIR ADIM eksiltmez', () => {
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
    expect(floorToStep(0.7, 0.1)).toBe(0.7);
    expect(floorToStep(1.1, 0.1)).toBe(1.1);
    expect(floorToStep(0.29, 0.01)).toBe(0.29);

    // Ama gercekten adimin ALTINDA kalan bir miktar yukari CIKARILMAMALI.
    expect(floorToStep(0.29999, 0.1)).toBe(0.2);
    expect(floorToStep(0.999, 1)).toBe(0);
  });

  it('tetik fiyatlari tickSize\'a yuvarlanir', () => {
    expect(roundToTick(61660.2527, 0.1)).toBe(61660.3);
    expect(roundToTick(0.08276, 0.00001)).toBe(0.08276);
    // Ayni kayan nokta tuzagi: 0.15 / 0.05 = 2.9999999999999996
    expect(roundToTick(0.15, 0.05)).toBe(0.15);
  });
});

describe('livePlan: pozisyon yasam dongusu simulator ile ayni', () => {
  it('ayni yonde sinyal: pozisyon KORUNUR, piramit yok', () => {
    const plan = planActions(
      input({
        allocations: [alloc('BTCUSDT', 'LONG', 0.8)],
        state: state({ positions: [position('BTCUSDT', 'LONG')] }),
      }),
    );

    expect(kinds(plan)).toEqual(['SKIP:ALREADY_OPEN']);
  });

  it('ters yonde sinyal: once KAPAT (SIGNAL_CHANGE), sonra ac', () => {
    const plan = planActions(
      input({
        allocations: [alloc('BTCUSDT', 'SHORT', 0.8)],
        state: state({ positions: [position('BTCUSDT', 'LONG')] }),
      }),
    );

    expect(kinds(plan)).toEqual(['CLOSE:BTCUSDT', 'OPEN:BTCUSDT']);
    // Kapanan pozisyonun riski butceden dusmeli, yoksa ters sinyal kendi tavanini yer.
    const opened = plan.find((s) => s.kind === 'OPEN');
    expect(opened).toBeDefined();
  });

  it('stop yendikten sonra ayni sembol+yonde COOLDOWN', () => {
    const at = 10_000_000;
    const st = state({
      exits: [{ symbol: 'BTCUSDT', side: 'LONG', exitTime: at - 1000, reason: 'STOP', realizedPnl: -120 }],
    });

    expect(kinds(planActions(input({ allocations: [alloc('BTCUSDT', 'LONG', 0.8)], state: st, at })))).toEqual([
      'SKIP:COOLDOWN',
    ]);

    // TERS yon serbest — cooldown yone bagli (simulator.ts:266).
    expect(kinds(planActions(input({ allocations: [alloc('BTCUSDT', 'SHORT', 0.8)], state: st, at })))).toEqual([
      'OPEN:BTCUSDT',
    ]);
  });

  it('KARLA kapanan pozisyon cooldown TETIKLEMEZ (simulator yalniz SL/BE\'ye bakar)', () => {
    const at = 10_000_000;
    const st = state({
      exits: [{ symbol: 'BTCUSDT', side: 'LONG', exitTime: at - 1000, reason: 'PROFIT', realizedPnl: 300 }],
    });

    expect(inCooldown(st, 'BTCUSDT', 'LONG', at, 43_200_000)).toBe(false);
    expect(kinds(planActions(input({ allocations: [alloc('BTCUSDT', 'LONG', 0.8)], state: st, at })))).toEqual([
      'OPEN:BTCUSDT',
    ]);
  });

  it('ATR yoksa pozisyon buyuklugu hesaplanamaz -> NO_ATR_SIZING', () => {
    const plan = planActions(
      input({
        allocations: [alloc('BTCUSDT', 'LONG', 0.8)],
        bars: { BTCUSDT: { close: 100, high: 101, low: 99, atr: 0 } },
      }),
    );

    expect(kinds(plan)).toEqual(['SKIP:NO_ATR_SIZING']);
  });

  it('bizim acmadigimiz pozisyonun sembolune DOKUNULMAZ', () => {
    const plan = planActions(
      input({ allocations: [alloc('BTCUSDT', 'LONG', 0.8)], unmanaged: ['BTCUSDT'] }),
    );

    expect(kinds(plan)).toEqual(['SKIP:UNMANAGED_POSITION']);
  });
});

describe('canli defter + karar bari', () => {
  it('sampiyon degisince cikis gecmisi SILINIR (eski stop\'lar yeni stratejiyi baglamaz)', () => {
    // readState dosya yoksa bos defter doner; championId farkliysa exits temizlenir.
    const s = readState('yeni-sampiyon@2');
    expect(s.championId).toBe('yeni-sampiyon@2');
    expect(s.exits).toEqual([]);
  });

  it('karar bari mum sinirina asagi yuvarlanir (kapanan mumun ardindaki an)', () => {
    const H4 = 4 * 3_600_000;
    // 4h mumlari UTC'de 00:00, 04:00, ... kapanir.
    const t = Date.UTC(2026, 5, 6, 21, 37, 12); // 21:37 -> icinde bulundugumuz bar 20:00
    expect(currentDecisionBar('4h', t)).toBe(Date.UTC(2026, 5, 6, 20, 0, 0));
    expect(currentDecisionBar('4h', t) % H4).toBe(0);

    // Tam sinirda: bar HENUZ acildi, karar ani tam olarak odur.
    const edge = Date.UTC(2026, 5, 6, 20, 0, 0);
    expect(currentDecisionBar('4h', edge)).toBe(edge);
  });
});

describe('mainnet kapisi', () => {
  it('BINANCE_TESTNET=false iken emir GONDERILMEZ (bilincli izin sart)', async () => {
    vi.stubEnv('BINANCE_TESTNET', 'false');
    vi.resetModules();

    const mod = await import('../src/services/binanceOrders');
    expect(() => mod.assertOrderVenue(false)).toThrow(/mainnet/i);
    expect(() => mod.assertOrderVenue(true)).not.toThrow();

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
