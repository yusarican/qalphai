import { calculatePositionSize, checkPortfolioRiskCap, type RiskParams } from './riskManagement';
import { entryFillPrice, type CostConfig } from './costModel';
import { DEFAULT_MIN_CONFIDENCE } from './execConfig';
import { inCooldown, openRiskUSD, type LedgerPosition, type LiveState } from '../lib/liveState';
import { floorToStep, type SymbolFilters } from '../services/binanceOrders';
import type { Allocation } from './portfolio';

/**
 * CANLI PLANLAYICI — kararin SAF yarisi.
 *
 * Bu dosya hicbir emir gondermez, hicbir agi cagirmaz, hicbir dosyaya yazmaz. Yalnizca
 * "bu tahsislerle ne YAPILMALI" sorusunu cevaplar. Emirleri gonderen kabuk liveExecutor'dur.
 *
 * Ayrim kasitli ve pahali bir hatanin sonucu: kapilar (RISK_CAP, cooldown, margin) once
 * emir gonderen dongunun icine gomulmustu ve TEST EDILEMIYORDU. Icine gomulu haldeyken
 * su hata fark edilmedi: borsa margin yetersizligiyle bir pozisyonu reddettiginde, o
 * pozisyonun risk butcesi SERBEST KALIYOR ve sirada bekleyen — backtest'in RISK_CAP ile
 * REDDETTIGI — bir pozisyon aniden uygun hale geliyordu. Yani canli motor, backtest'in
 * asla almadigi bir pozisyonu aliyordu.
 *
 * Simdi kapilar saf bir fonksiyonda ve testleri var (tests/livePlan.test.ts).
 *
 * KAPI SIRASI simulator.ts:248-317 ile birebir ayni olmak ZORUNDA:
 *
 *   MIN_CONF -> (ayni yon: koru | ters yon: SIGNAL_CHANGE) -> COOLDOWN -> ATR/fiyat
 *   -> sizing -> RISK_CAP -> MIN_MARGIN   [buraya kadar simulator]
 *   -> borsa filtreleri -> margin butcesi [yalnizca canli]
 *
 * Borsa kapilari EN SONA konur: buraya dusen bir tahsis "backtest bunu ALIRDI ama borsa
 * aldirmadi" demektir ve bu, sessizce yutulmamasi gereken bir IRAKSAMADIR.
 */

export type SkipReason =
  | 'MIN_CONF'
  | 'COOLDOWN'
  | 'RISK_CAP'
  | 'MIN_MARGIN'
  | 'NO_ATR_SIZING'
  | 'ALREADY_OPEN'
  | 'MIN_NOTIONAL'
  | 'UNMANAGED_POSITION'
  | 'INSUFFICIENT_MARGIN';

/**
 * Borsanin dayattigi ama SIMULATOR'UN MODELLEMEDIGI kisitlar. Bir tahsis bunlardan biri
 * yuzunden atlanirsa, canli motor backtest'in ALDIGI bir pozisyonu ALMAMIS demektir.
 */
export const EXCHANGE_ONLY_SKIPS: readonly SkipReason[] = ['INSUFFICIENT_MARGIN', 'MIN_NOTIONAL'];

/** Komisyon + fiyat oynamasi icin tampon: kullanilabilir margin'in tamami harcanmaz. */
export const MARGIN_SAFETY_BUFFER = 0.95;

/** simulator.ts:314 ile ayni esik. */
export const MIN_MARGIN_USD = 5;

/** Stratejinin GORDUGU son kapali mum (simulator'daki priceAt/atrAt kesiti). */
export interface ClosedBar {
  close: number;
  high: number;
  low: number;
  atr: number;
}

export interface PlanInput {
  /** portfolio.allocate ciktisi — confidence'a gore sirali. */
  allocations: Allocation[];
  bars: Record<string, ClosedBar | null>;
  /** Sizing tabani (simulator'daki balance()). */
  balance: number;
  /** Margin butcesi tabani — acik pozisyonlarin tuttugu margin dusulmus. */
  availableMargin: number;
  risk: RiskParams;
  costs: CostConfig;
  state: LiveState;
  at: number;
  cooldownMs: number;
  /** null: borsa filtreleri bilinmiyor (anahtarsiz kuru kosu) — filtre kapilari atlanir. */
  filters: Map<string, SymbolFilters> | null;
  /** Borsada olup defterde olmayan semboller — bunlara dokunulmaz. */
  unmanaged: string[];
}

export interface PlannedOpen {
  kind: 'OPEN';
  alloc: Allocation;
  qtyBase: number;
  margin: number;
  riskUSD: number;
  /** Maliyet modelinin TAHMIN ettigi dolum — miktar bundan hesaplandi. */
  estFill: number;
  /** TAHMINI seviyeler. Gercek emirde bunlar GERCEK dolumdan yeniden turetilir. */
  estStopPrice: number;
  estTakeProfitPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  callbackRatePct: number;
}

export interface PlannedClose {
  kind: 'CLOSE';
  position: LedgerPosition;
  reason: 'SIGNAL_CHANGE';
}

export interface PlannedSkip {
  kind: 'SKIP';
  alloc: Allocation;
  reason: SkipReason;
}

export type PlannedAction = PlannedOpen | PlannedClose | PlannedSkip;

export function planActions(input: PlanInput): PlannedAction[] {
  const plan: PlannedAction[] = [];

  const marginBudget = input.availableMargin * MARGIN_SAFETY_BUFFER;
  let usedMargin = 0;

  /**
   * SIMULATOR ILE AYNI RISK MUHASEBESI. Bir tahsis simulator'un kapilarindan gectiyse
   * riski REZERVE edilir — borsa onu sonradan reddetse BILE. Borsanin reddi,
   * simulator'un kapisini GEVSETEMEZ (bkz. dosya basligi).
   */
  let simRiskUSD = openRiskUSD(input.state);

  // Bu kosuda kapatilanlar: ayni sembolde ters sinyal geldiginde pozisyon kapanir ve
  // artik "acik" sayilmaz.
  const closed = new Set<LedgerPosition>();

  for (const alloc of input.allocations) {
    const skip = (reason: SkipReason) => plan.push({ kind: 'SKIP', alloc, reason });

    // (a) MIN_CONF
    if (alloc.confidence < DEFAULT_MIN_CONFIDENCE) {
      skip('MIN_CONF');
      continue;
    }

    // (b) Bizim yonetmedigimiz bir pozisyonun sembolune DOKUNMA: riskUSD'sini ve stop
    //     mesafesini bilmiyoruz, yani RISK_CAP'e katamayiz.
    if (input.unmanaged.includes(alloc.symbol)) {
      skip('UNMANAGED_POSITION');
      continue;
    }

    // (c) Mevcut pozisyon: ayni yon -> koru (piramit yok). Ters yon -> SIGNAL_CHANGE.
    const existing = input.state.positions.find((p) => p.symbol === alloc.symbol && !closed.has(p));
    if (existing) {
      if (existing.side === alloc.side) {
        skip('ALREADY_OPEN');
        continue;
      }
      plan.push({ kind: 'CLOSE', position: existing, reason: 'SIGNAL_CHANGE' });
      closed.add(existing);
      // Kapanan pozisyonun riski butceden duser (simulator: open dizisinden cikarilir).
      simRiskUSD -= existing.riskUSD;
    }

    // (d) COOLDOWN
    if (inCooldown(input.state, alloc.symbol, alloc.side, input.at, input.cooldownMs)) {
      skip('COOLDOWN');
      continue;
    }

    // (e) Fiyat + ATR — ATR olmadan pozisyon buyuklugu hesaplanamaz.
    const bar = input.bars[alloc.symbol];
    if (!bar || !(bar.close > 0) || !(bar.atr > 0)) {
      skip('NO_ATR_SIZING');
      continue;
    }

    // (f) SIZING — TAHMINI dolumdan. Emir, dolumdan once verilmek zorunda.
    const estFill = entryFillPrice(input.costs, alloc.side, bar.close, bar.atr);
    const sizing = calculatePositionSize({
      balance: input.balance,
      entryPrice: estFill,
      atr: bar.atr,
      leverage: alloc.leverage,
      riskPerTradePct: input.risk.riskPerTradePct,
      slMultiplier: input.risk.slMultiplier,
      callbackMultiplier: input.risk.callbackMultiplier,
      rewardRatio: input.risk.rewardRatio,
    });

    // (g) RISK_CAP
    const cap = checkPortfolioRiskCap({
      balance: input.balance,
      currentOpenRiskUSD: simRiskUSD,
      newTradeRiskUSD: sizing.riskUSD,
      maxPortfolioRiskPct: input.risk.maxPortfolioRiskPct,
    });
    if (!cap.allowed) {
      skip('RISK_CAP');
      continue;
    }

    // (h) MIN_MARGIN
    if (sizing.margin < MIN_MARGIN_USD) {
      skip('MIN_MARGIN');
      continue;
    }

    // Simulator'un TUM kapilari gecildi -> backtest bu pozisyonu ALIR. Riski SIMDI
    // rezerve et: asagidaki borsa kapilari reddetse bile butce geri VERILMEZ.
    simRiskUSD += sizing.riskUSD;

    // --- Buradan asagisi yalnizca BORSA. Simulator bunlari bilmez.

    const isLong = alloc.side === 'LONG';

    // (i) LOT_SIZE / MIN_NOTIONAL. Miktar ASAGI yuvarlanir — yukari yuvarlamak riski buyutur.
    let qtyBase = sizing.quantityBase;
    if (input.filters) {
      const f = input.filters.get(alloc.symbol);
      if (!f) {
        skip('MIN_NOTIONAL');
        continue;
      }
      qtyBase = floorToStep(qtyBase, f.stepSize);
      if (qtyBase < f.minQty || qtyBase * estFill < f.minNotional) {
        skip('MIN_NOTIONAL');
        continue;
      }
    }

    // (j) MARGIN BUTCESI. Onceden kontrol: emri gonderip -2019 yemek portfoyu YARIM
    //     acik birakir (ilk iki pozisyon acilmis, ucuncusu reddedilmis).
    if (usedMargin + sizing.margin > marginBudget) {
      skip('INSUFFICIENT_MARGIN');
      continue;
    }
    usedMargin += sizing.margin;

    plan.push({
      kind: 'OPEN',
      alloc,
      qtyBase,
      margin: sizing.margin,
      riskUSD: sizing.riskUSD,
      estFill,
      estStopPrice: isLong
        ? estFill * (1 - sizing.stopLossPct / 100)
        : estFill * (1 + sizing.stopLossPct / 100),
      estTakeProfitPrice: isLong
        ? estFill * (1 + sizing.takeProfitPct / 100)
        : estFill * (1 - sizing.takeProfitPct / 100),
      stopLossPct: sizing.stopLossPct,
      takeProfitPct: sizing.takeProfitPct,
      callbackRatePct: sizing.callbackRatePct,
    });
  }

  return plan;
}
